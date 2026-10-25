// `lexcode tui`: the board in the terminal. Attaching a card opens Claude in ONE pane on the right:
// a tmux split, or a Neovim window when run inside Neovim's :terminal. Other cards' Claude panes are parked
// (tmux: hidden windows, Neovim: hidden buffers) and swapped back in, still running, on the next attach.
// Without tmux or Neovim, Claude takes over the terminal and the board comes back when it exits.
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import { execFile, execFileSync, spawn, spawnSync } from 'child_process';
import { Store, Board, Story, Status, Project } from './store';
import { Agent, AgentWatcher, liveRun } from './claude';
import { FactoryRunner } from './factoryRunner';
import { dashboardCore } from './dashboardCore';
import { Host, setHost } from './host';
import { syncSource } from './importer';
import { HOME, setting, launcher, cliProjects, opener, onPath } from './server';

const STATUSES: Status[] = ['todo', 'doing', 'review', 'done'];
const ROOT = path.join(__dirname, '..');

// Padded/cut to exactly w columns; control characters become spaces.
// ponytail: one column per code point; wide CJK/emoji titles push the row out of line.
export function fit(s: string, w: number) {
  if (w <= 0) return '';
  const cs = Array.from(s.replace(/[\x00-\x1f\x7f]/g, ' '));
  return cs.length > w ? cs.slice(0, w - 1).join('') + '…' : cs.join('') + ' '.repeat(w - cs.length);
}
const sgr = (code: string, s: string) => code ? `\x1b[${code}m${s}\x1b[0m` : s;

/* ---------- the right-hand pane ---------- */
// key: which card the pane belongs to (story id, or a hash of the command for anything else).
// make: writes the launcher script; only called when a new pane is actually started.
interface Pane {
  show(key: string): boolean;                  // bring an existing pane for key to the right; false = none
  open(key: string, label: string, make: () => string): void;
  edit?(file: string, line?: number): void;   // absent: $EDITOR in the pane
  focus(): void;
  state(): { open?: string; parked: string[] };
}

function tmuxPane(self: string): Pane {
  const tmux = (...a: string[]) => execFileSync('tmux', a, { encoding: 'utf8' }).trim();
  // tmux would read #[…] / #{…} in titles and window names as formats.
  const name = (s: string) => s.replace(/[\x00-\x1f#]/g, ' ').slice(0, 40);
  let cur: { pane: string; key: string; label: string } | undefined;
  const parked = new Map<string, { pane: string; label: string }>();
  const prune = () => {
    const live = new Set(tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n'));
    if (cur && !live.has(cur.pane)) cur = undefined; // Claude exited: its pane closed
    for (const [k, p] of parked) if (!live.has(p.pane)) parked.delete(k);
  };
  const park = () => {
    if (!cur) return;
    tmux('break-pane', '-d', '-s', cur.pane, '-n', `⏸ ${name(cur.label)}`);
    parked.set(cur.key, cur);
    cur = undefined;
  };
  const show = (key: string) => {
    prune();
    if (cur?.key === key) { tmux('select-pane', '-t', cur.pane); return true; }
    const back = parked.get(key);
    if (!back) return false;
    park();
    parked.delete(key);
    tmux('join-pane', '-h', '-l', '55%', '-s', back.pane, '-t', self);
    cur = { ...back, key };
    return true;
  };
  return {
    show,
    open(key, label, make) {
      if (show(key)) return;
      park();
      // Two arguments after --: tmux execs them directly, no shell. The prompt stays inside the script file.
      const pane = tmux('split-window', '-h', '-l', '55%', '-t', self, '-P', '-F', '#{pane_id}', '--', 'sh', make());
      tmux('select-pane', '-t', pane, '-T', name(label));
      cur = { pane, key, label };
    },
    focus() { prune(); if (cur) tmux('select-pane', '-t', cur.pane); },
    state() { try { prune(); } catch { /* tmux gone */ } return { open: cur?.key, parked: [...parked.keys()] }; },
  };
}

// Lua runs inside the user's Neovim; arguments travel hex-encoded so no string ever needs quoting.
const NVIM_LUA = `-- Written by \`lexcode tui\`: one Claude window on the right; other cards' terminals stay as hidden buffers.
local function unhex(s) return (s:gsub('..', function(h) return string.char(tonumber(h, 16)) end)) end
return function(op, key, script)
  op, key, script = unhex(op), unhex(key), unhex(script)
  local L = _G.lexcode_tui or { bufs = {} }
  _G.lexcode_tui = L
  local api = vim.api
  local win_ok = L.win and api.nvim_win_is_valid(L.win)
  for k, b in pairs(L.bufs) do if not api.nvim_buf_is_valid(b) then L.bufs[k] = nil end end
  if op == 'edit' then
    vim.cmd('tabedit ' .. vim.fn.fnameescape(key))
    local n = tonumber(script)
    if n then pcall(api.nvim_win_set_cursor, 0, { n, 0 }) end
    return 1
  end
  if op == 'focus' then
    if win_ok then api.nvim_set_current_win(L.win); vim.cmd('startinsert') end
    return 1
  end
  local shown = win_ok and api.nvim_win_get_buf(L.win) or -1
  if op == 'state' then
    local open, parked = '', {}
    for k, b in pairs(L.bufs) do if b == shown then open = k else parked[#parked + 1] = k end end
    return open .. '\\n' .. table.concat(parked, '\\n')
  end
  local buf = L.bufs[key]
  if not buf and op == 'show' then return 0 end
  if not win_ok then
    vim.cmd('botright vsplit')
    L.win = api.nvim_get_current_win()
    api.nvim_win_set_width(L.win, math.floor(vim.o.columns * 0.55))
  else
    api.nvim_set_current_win(L.win)
  end
  if buf then
    api.nvim_win_set_buf(L.win, buf)
  else
    buf = api.nvim_create_buf(true, false)
    api.nvim_win_set_buf(L.win, buf)
    if vim.fn.has('nvim-0.11') == 1 then vim.fn.jobstart({ 'sh', script }, { term = true })
    else vim.fn.termopen({ 'sh', script }) end
    L.bufs[key] = buf
  end
  vim.cmd('startinsert')
  return 1
end
`;
const hex = (s: string) => Buffer.from(s).toString('hex');
const UNHEX = `(_A[1]:gsub("..", function(h) return string.char(tonumber(h, 16)) end))`;
// The --remote-expr for one call: everything from outside is hex digits inside single-quoted Vim strings.
export const nvimExpr = (luaFile: string, ...args: [string, string, string]) =>
  `luaeval('dofile(${UNHEX})(_A[2], _A[3], _A[4])', [${[luaFile, ...args].map(a => `'${hex(a)}'`).join(', ')}])`;

function nvimPane(server: string): Pane {
  const lua = path.join(HOME, 'tui-nvim.lua');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(lua, NVIM_LUA);
  const call = (op: string, key = '', script = '') =>
    execFileSync('nvim', ['--server', server, '--remote-expr', nvimExpr(lua, op, key, script)], { encoding: 'utf8' }).trim();
  let cached: { open?: string; parked: string[] } = { parked: [] };
  const refresh = () => {
    try { const [open, ...parked] = call('state').split('\n'); cached = { open: open || undefined, parked: parked.filter(Boolean) }; }
    catch { /* nvim busy or closing */ }
  };
  return {
    show(key) { const ok = call('show', key) === '1'; refresh(); return ok; },
    open(key, label, make) { call('open', key, make()); refresh(); },
    edit(file, line) { call('edit', file, line ? String(line) : ''); },
    focus() { call('focus'); },
    state() { refresh(); return cached; },
  };
}

// No multiplexer: hand the terminal to Claude until it exits.
function inlinePane(suspend: () => void, resume: () => void): Pane {
  return {
    show: () => false,
    open(_key, _label, make) {
      suspend();
      spawn('sh', [make()], { stdio: 'inherit' }).on('exit', resume).on('error', resume);
    },
    focus() {},
    state: () => ({ parked: [] }),
  };
}

/* ---------- app ---------- */
export async function tui(boardFile: string) {
  const mode = setting<string>('tui.terminal', 'auto');
  // Plain terminal with tmux installed: run inside a `lexcode` tmux session (reattaches if it's already running).
  if (mode === 'auto' && !process.env.TMUX && !process.env.NVIM && onPath('tmux')) {
    const r = spawnSync('tmux', ['new-session', '-A', '-s', 'lexcode', '-n', 'board', '-e', 'LEXCODE_TMUX=1', '-e', `LEXCODE_BOARD=${boardFile}`,
      '--', process.execPath, path.join(ROOT, 'out', 'cli.js'), 'tui'], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  }
  if (!process.stdin.isTTY) throw new Error('lexcode tui needs a terminal');

  const out = process.stdout;
  let quitting = false, help = false;
  let flash: { text: string; level: string; at: number } | undefined;
  type Ask = { kind: 'input' | 'choice'; text: string; level?: string; detail?: string; value: string; actions: string[]; resolve: (v?: string) => void };
  const asks: Ask[] = [];
  const ask = (a: Omit<Ask, 'resolve'>) => new Promise<string | undefined>(resolve => { asks.push({ ...a, resolve }); render(); });
  const logFile = path.join(HOME, 'tui.log');

  let pane: Pane;
  let intent: { key: string; label: string } | undefined; // the card being attached, read by host.terminal
  // ponytail: one pending intent; two quick attaches before the first launches can swap keys.
  const host: Host = {
    message(level, text, opts, ...actions) {
      if (!actions.length) { flash = { text: opts?.detail ? `${text}: ${opts.detail}` : text, level, at: Date.now() }; render(); return Promise.resolve(undefined); }
      return ask({ kind: 'choice', text, level, detail: opts?.detail, value: '', actions });
    },
    input: (prompt, value) => ask({ kind: 'input', text: prompt, value: value ?? '', actions: [] }),
    setting,
    terminal(title, cwd, argv) {
      const key = intent?.key ?? createHash('sha1').update(JSON.stringify([cwd, argv])).digest('hex').slice(0, 12);
      const label = intent?.label ?? title;
      intent = undefined;
      try { pane.open(key, label, () => launcher(label, cwd, argv)); } // its title escape names the tmux pane too
      catch (e: any) { host.message('error', `Couldn't open the Claude pane: ${e.message}`); }
    },
    openFile(file, opts) {
      if (pane.edit) return pane.edit(file, opts?.line);
      const [ed, ...edArgs] = (process.env.VISUAL || process.env.EDITOR || 'vi').split(/\s+/); // ponytail: no quoted args in $EDITOR
      host.terminal(`Edit · ${path.basename(file)}`, path.dirname(file), [ed, ...edArgs, ...(opts?.line ? [`+${opts.line}`] : []), file]);
    },
    openExternal: url => { if (/^https?:\/\//.test(url)) execFile(opener, [url]); },
    log: line => fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {}),
  };
  setHost(host);

  const store = new Store(boardFile, s => { try { if (s.source) syncSource(s); } catch (e: any) { host.log(e.message); } });
  const agents = new AgentWatcher(store);
  let data: { board: Board; agents: Record<string, Agent> } | undefined;
  let push = () => {};
  const factory = new FactoryRunner(store, agents, path.join(path.dirname(boardFile), 'locks'), path.join(ROOT, 'agents'), () => push());
  const shell = (p: Project) => { intent = { key: `shell:${p.id}`, label: `shell · ${p.name}` }; host.terminal(`Shell · ${p.name}`, p.path, [process.env.SHELL || 'sh']); };
  const core = dashboardCore(store, agents, factory, (m: any) => { if (m?.type === 'board') { data = m; render(); } }, '', () => push(), cliProjects(store, shell));
  push = core.push;
  agents.onDidChange(push);
  fs.watchFile(boardFile, { interval: 1000 }, () => { store.reload(); push(); }); // VS Code, `lexcode ui`, sync

  const enter = () => { out.write('\x1b[?1049h\x1b[?25l'); process.stdin.setRawMode(true); process.stdin.resume(); render(); };
  const leave = () => { out.write('\x1b[0m\x1b[?25h\x1b[?1049l'); if (process.stdin.isTTY) process.stdin.setRawMode(false); };
  let suspended = false;
  const tmuxSelf = process.env.TMUX_PANE;
  if ((mode === 'nvim' || mode === 'auto') && process.env.NVIM) pane = nvimPane(process.env.NVIM);
  else if ((mode === 'tmux' || mode === 'auto') && process.env.TMUX && tmuxSelf) pane = tmuxPane(tmuxSelf);
  else pane = inlinePane(() => { suspended = true; leave(); process.stdin.pause(); }, () => { suspended = false; enter(); });
  if (process.env.LEXCODE_TMUX && tmuxSelf) {
    // Our own session: label panes on their top border.
    execFile('tmux', ['set', '-w', '-t', tmuxSelf, 'pane-border-status', 'top', ';', 'set', '-w', '-t', tmuxSelf, 'pane-border-format', ' #{pane_title} ', ';', 'select-pane', '-t', tmuxSelf, '-T', 'board']);
  }

  /* ---------- selection ---------- */
  let pi = 0, col = 0, row = 0, scroll = 0;
  let selId: string | undefined; // the cursor follows the card when it changes status (attach, H/L, other windows)
  const projects = () => data?.board.projects ?? [];
  const project = () => projects()[Math.min(pi, projects().length - 1)];
  const columns = () => {
    const p = project();
    return STATUSES.map(st => (data?.board.stories ?? []).filter(s => s.projectId === p?.id && !s.archived && s.status === st));
  };
  const selected = (): Story | undefined => columns()[col]?.[row];
  const clamp = () => {
    pi = Math.max(0, Math.min(pi, projects().length - 1));
    const cs = columns();
    const c = selId ? cs.findIndex(l => l.some(s => s.id === selId)) : -1;
    if (c >= 0) { col = c; row = cs[c].findIndex(s => s.id === selId); }
    else {
      col = Math.max(0, Math.min(col, 3));
      // The narrow list has no cursor on an empty group: go to the nearest group with cards.
      if (narrow() && !cs[col].length) col = [1, 2, 3].flatMap(d => [col - d, col + d]).find(i => cs[i]?.length) ?? col;
      row = Math.max(0, Math.min(row, cs[col].length - 1));
    }
    selId = cs[col][row]?.id;
  };
  const narrow = () => out.columns < 100;
  // Narrow layout is one list: up/down cross into the next non-empty status group.
  const step = (dy: number) => {
    const cs = columns();
    if (!narrow()) { row += dy; return; }
    row += dy;
    while (col >= 0 && col < 4 && (row < 0 || row >= cs[col].length)) {
      if (row < 0) { col--; if (col >= 0) row = cs[col].length - 1; } else { col++; row = 0; }
    }
    if (col < 0 || col > 3) { col = Math.max(0, Math.min(col, 3)); row = dy < 0 ? 0 : cs[col].length - 1; }
  };

  const needsYou = (p: Project) => {
    const b = data!.board;
    return b.stories.filter(s => s.projectId === p.id && liveRun(s, data!.agents)?.state === 'blocked').length
      + b.epics.filter(e => e.projectId === p.id && (e.error || e.stage?.startsWith('awaiting'))).length
      + b.sprints.filter(s => s.projectId === p.id && (s.blocked || s.state === 'awaitingMerge')).length;
  };
  const badge = (s: Story, st: ReturnType<Pane['state']>) => {
    const run = liveRun(s, data!.agents);
    if (st.open === s.id) return ['▣ open', '36'];
    if (run?.state === 'blocked') return ['! approve', '33'];
    if (run) return [`◉ ${run.state}`, '32'];
    if (st.parked.includes(s.id)) return ['⏸ parked', '36'];
    if (s.sessionIds?.length) return ['↻', '2'];
    return ['', ''];
  };
  const meta = (s: Story) => [data!.board.epics.find(e => e.id === s.epicId)?.title, s.points != null && `${s.points}pt`].filter(Boolean).join(' · ');

  /* ---------- drawing ---------- */
  function render() {
    if (quitting || suspended) return;
    const W = out.columns || 80, H = out.rows || 24;
    if (!data) { out.write(`\x1b[H\x1b[2J Loading board…`); return; }
    clamp();
    const st = pane.state();
    const p = project();
    const lines: string[] = [];
    const running = Object.values(data.agents).filter(a => !['done', 'stopped', 'failed'].includes(a.state)).length;
    const needs = projects().reduce((n, x) => n + needsYou(x), 0);
    const right = `${running} running${needs ? ` · ${needs} need you` : ''} `;
    const left = ` LexCode ─ ${p?.name ?? 'no projects (A to add)'}${projects().length > 1 ? '  [ ]' : ''}`;
    lines.push(sgr('1', fit(left, W - right.length)) + sgr(needs ? '33' : '2', right));
    const body = H - 3;
    const cs = columns();

    if (!p) for (let i = 0; i < body; i++) lines.push(fit(i === 1 ? '  A add a project folder   q quit' : '', W));
    else if (narrow()) {
      // Grouped list: [label, sgr, isSelected]
      const items: [string, string, boolean][] = [];
      cs.forEach((list, c) => {
        items.push([`${STATUSES[c].toUpperCase()} ${list.length}`, '1;2', false]);
        list.forEach((s, r) => {
          const [b, bc] = badge(s, st);
          const sel = c === col && r === row;
          items.push([`${sel ? '▸' : ' '} ${fit(s.title, Math.max(4, W - 14))} ${fit(b, 11)}`, sel ? '7' : bc ? '' : '', sel]);
        });
      });
      const at = items.findIndex(i => i[2]);
      scroll = Math.max(0, Math.min(scroll, at), at - body + 1);
      for (let i = 0; i < body; i++) { const it = items[i + scroll]; lines.push(it ? sgr(it[1], fit(it[0], W)) : fit('', W)); }
    } else {
      const pw = 18, cw = Math.floor((W - pw) / 4), last = W - pw - cw * 3;
      const widths = [cw, cw, cw, last];
      const head = fit(' Projects', pw) + cs.map((l, c) => sgr(c === col ? '1' : '1;2', fit(` ${STATUSES[c].toUpperCase()} ${l.length}`, widths[c]))).join('');
      lines.push(head);
      const cards = Math.floor((body - 1) / 2);
      scroll = Math.max(0, Math.min(scroll, row), row - cards + 1);
      for (let i = 0; i < body - 1; i++) {
        const pr = projects()[i];
        let line = pr ? sgr(pr === p ? '7' : '', fit(` ${pr.name}${needsYou(pr) ? ' !' : ''}`, pw - 1)) + ' ' : fit('', pw);
        cs.forEach((list, c) => {
          const r = Math.floor(i / 2) + (c === col ? scroll : 0), s = list[r];
          const w = widths[c] - 1;
          if (!s) { line += fit('', w + 1); return; }
          const sel = c === col && r === row;
          const [b, bc] = badge(s, st);
          const text = i % 2 === 0 ? sgr(sel ? '7;1' : '', fit(` ${s.title}`, w))
            : sgr(sel ? '7' : '2', fit(` ${meta(s)}`, Math.max(0, w - b.length - 1))) + sgr(sel ? '7' : bc, fit(b ? `${b} ` : '', Math.min(w, b.length + 1)));
          line += text + ' ';
        });
        lines.push(line);
      }
    }

    const a = asks[0];
    if (a) {
      lines.push(sgr(a.level === 'error' ? '31' : a.level === 'warn' ? '33' : '1', fit(` ${a.text}${a.detail ? `  ${a.detail}` : ''}`, W)));
      lines.push(a.kind === 'input' ? fit(` › ${a.value}▌`, W)
        : fit(' ' + a.actions.map((x, i) => `[${i + 1}] ${x}`).join('  ') + '   esc cancel', W));
    } else {
      if (flash && Date.now() - flash.at > 8000) flash = undefined;
      lines.push(flash ? sgr(flash.level === 'error' ? '31' : flash.level === 'warn' ? '33' : '32', fit(` ${flash.text}`, W))
        : sgr('2', fit(st.parked.length ? ` parked: ${st.parked.length} Claude pane${st.parked.length > 1 ? 's' : ''}` : '', W)));
      lines.push(sgr('2', fit(help
        ? ' ⏎/a attach  c new session  H/L move status  n new story  d delete  o shell  A add project  i import  tab → pane  r reload  q quit'
        : ' ⏎ attach  H/L status  n new  tab → claude  ? help  q quit', W)));
    }
    out.write('\x1b[H' + lines.slice(0, H).join('\r\n'));
  }

  /* ---------- keys ---------- */
  const attach = (s: Story, fresh: boolean) => {
    const st = pane.state();
    if (fresh && (st.open === s.id || st.parked.includes(s.id))) {
      return host.message('warn', 'This card already has a Claude pane. Exit that Claude first, then start a new session.');
    }
    if (!fresh && pane.show(s.id)) return render();
    intent = { key: s.id, label: s.title };
    const run = liveRun(s, data!.agents);
    core.handle(fresh ? { type: 'newSession', id: s.id } : run ? { type: 'attach', id: s.id, sessionId: run.sessionId } : { type: 'claude', id: s.id });
  };
  const quit = () => {
    quitting = true;
    leave();
    fs.unwatchFile(boardFile);
    agents.dispose();
    factory.dispose();
    process.exit(0);
  };
  process.on('exit', () => { if (!quitting) leave(); });

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (str: string | undefined, key: readline.Key = {}) => {
    if (suspended) return;
    if (key.ctrl && key.name === 'c') return quit();
    const a = asks[0];
    if (a) {
      const done = (v?: string) => { asks.shift(); a.resolve(v); render(); };
      if (key.name === 'escape') return done();
      if (a.kind === 'input') {
        if (key.name === 'return') return done(a.value);
        if (key.name === 'backspace') a.value = Array.from(a.value).slice(0, -1).join('');
        else if (str && !key.ctrl && !key.meta && str >= ' ') a.value += str;
      } else {
        const n = Number(str);
        if (n >= 1 && n <= a.actions.length) return done(a.actions[n - 1]);
      }
      return render();
    }
    if (!data) return;
    const p = project(), s = selected(), at = [pi, col, row].join();
    switch (key.name === 'return' ? 'return' : str ?? key.name) {
      case 'q': return quit();
      case 'j': step(1); break;
      case 'k': step(-1); break;
      case 'h': if (!narrow()) { col--; scroll = 0; } else step(-1); break;
      case 'l': if (!narrow()) { col++; scroll = 0; } else step(1); break;
      case '[': pi = (pi - 1 + projects().length) % Math.max(1, projects().length); col = row = scroll = 0; break;
      case ']': pi = (pi + 1) % Math.max(1, projects().length); col = row = scroll = 0; break;
      case 'H': case 'L': {
        const to = STATUSES[STATUSES.indexOf(s?.status as Status) + (str === 'H' ? -1 : 1)];
        if (s && to) core.handle({ type: 'status', id: s.id, status: to });
        break;
      }
      case 'return': case 'a': if (s) attach(s, false); break;
      case 'c': if (s) attach(s, true); break;
      case 'n': if (p) host.input(`New story in ${p.name}`).then(t => { if (t?.trim()) core.handle({ type: 'add', id: p.id, title: t }); }); break;
      case 'd': if (s) core.handle({ type: 'delete', id: s.id }); break;
      case 'o': if (p) shell(p); break;
      case 'A': core.handle({ type: 'addProject' }); break;
      case 'i': if (p) core.handle({ type: 'importTasks', id: p.id }); break;
      case 'r': store.reload(); push(); break;
      case '?': help = !help; break;
      case '\t': case 'tab': pane.focus(); break;
      default:
        if (key.name === 'down') step(1);
        else if (key.name === 'up') step(-1);
        else if (key.name === 'left') { if (narrow()) step(-1); else { col--; scroll = 0; } }
        else if (key.name === 'right') { if (narrow()) step(1); else { col++; scroll = 0; } }
        else if (key.name === 'tab') pane.focus();
        else return;
    }
    if ([pi, col, row].join() !== at) selId = undefined; // moved by hand: pick the card at the new position
    render();
  });
  out.on('resize', render);
  setInterval(render, 3000); // pane state (Claude exited, parked) and flash expiry
  enter();
  push();
}
