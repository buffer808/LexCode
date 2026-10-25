// `lexcode tui`: the board in the terminal. Attaching a card opens Claude in ONE pane on the right:
// a tmux split, or a Neovim window when run inside Neovim's :terminal. Other cards' Claude panes are parked
// (tmux: hidden windows, Neovim: hidden buffers) and swapped back in, still running, on the next attach.
// Without tmux or Neovim, Claude takes over the terminal and the board comes back when it exits.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import { execFile, spawnSync } from 'child_process';
import { Store, Board, Story, Status, Project } from './store';
import { Agent, AgentWatcher, liveRun, claudeBin } from './claude';
import { FactoryRunner } from './factoryRunner';
import { dashboardCore } from './dashboardCore';
import { Host, setHost } from './host';
import { syncSource } from './importer';
import { Pane, tmuxPane, nvimPane, inlinePane, ideArgs, ideLocks } from './panes';
import { Act, SCISSORS, cutHelp, epicNeeds, epicView, pipeline, progress } from './epicView';
import { validBranch } from './factory';
import { launcher, cliProjects, opener, onPath } from './server';
import { HOME, setting } from './config';

const STATUSES: Status[] = ['todo', 'doing', 'review', 'done'];
const ROOT = path.join(__dirname, '..');

// Terminal columns for one code point: East Asian wide/fullwidth and emoji take 2, combining marks and ZWJ 0.
// ponytail: range check, not full Unicode width tables; rare scripts may be off by one.
const cols = (c: string) => {
  const n = c.codePointAt(0)!;
  if (/[̀-ͯ​-‏︀-️]/.test(c)) return 0;
  return (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff)
    || (n >= 0xfe30 && n <= 0xfe4f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6)
    || (n >= 0x1f300 && n <= 0x1faff) || (n >= 0x20000 && n <= 0x3fffd) ? 2 : 1;
};
// Padded/cut to exactly w columns; control characters become spaces.
export function fit(s: string, w: number) {
  if (w <= 0) return '';
  const cs = Array.from(s.replace(/[\x00-\x1f\x7f]/g, ' '));
  const total = cs.reduce((n, c) => n + cols(c), 0);
  if (total <= w) return cs.join('') + ' '.repeat(w - total);
  let r = '', used = 0;
  for (const c of cs) { if (used + cols(c) > w - 1) break; r += c; used += cols(c); }
  return r + '…' + ' '.repeat(w - 1 - used); // pad when a wide char didn't fit before the …
}
const sgr = (code: string, s: string) => code ? `\x1b[${code}m${s}\x1b[0m` : s;
// ponytail: split on spaces; quoted arguments inside $EDITOR aren't supported.
const editor = () => (process.env.VISUAL || process.env.EDITOR || 'vi').trim().split(/\s+/);

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain' };
// New-epic reference files: comma-separated paths (~ and relative to the project), same limits as dashboard uploads.
export function readRefs(input: string, base: string): { name: string; mime: string; data: string }[] {
  const paths = input.split(',').map(s => s.trim()).filter(Boolean);
  if (paths.length > 20) throw new Error('At most 20 reference files.');
  return paths.map(p => {
    const file = path.resolve(base, p.replace(/^~(?=$|\/)/, os.homedir()));
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`${p} isn't a file.`);
    if (st.size > 25 * 1024 * 1024) throw new Error(`${p} is over 25 MB.`);
    return { name: path.basename(file), mime: MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', data: fs.readFileSync(file).toString('base64') };
  });
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
  // Attaches run one at a time so each launch reads its own intent (keys in one stdin chunk arrive back to back).
  let launches = Promise.resolve();
  const launch = (i: { key: string; label: string }, run: () => unknown) => {
    launches = launches.then(async () => { intent = i; try { await run(); } finally { intent = undefined; } }).catch(e => host.log(e.message));
  };
  const host: Host = {
    message(level, text, opts, ...actions) {
      if (!actions.length) { flash = { text: opts?.detail ? `${text}: ${opts.detail}` : text, level, at: Date.now() }; render(); return Promise.resolve(undefined); }
      return ask({ kind: 'choice', text, level, detail: opts?.detail, value: '', actions });
    },
    input: (prompt, value, opts) => opts?.multiline ? editText(value ?? '', prompt) : ask({ kind: 'input', text: prompt, value: value ?? '', actions: [] }),
    setting,
    terminal(title, cwd, argv) {
      const key = intent?.key ?? createHash('sha1').update(JSON.stringify([cwd, argv])).digest('hex').slice(0, 12);
      const label = intent?.label ?? title;
      intent = undefined;
      // In Neovim with claudecode.nvim: --ide so Claude's edits open as Neovim diffs.
      if (inNvim) { const r = ideArgs(argv, claudeBin(), ideLocks(), cwd); argv = r.argv; if (r.hint) host.message('info', r.hint); }
      try { pane.open(key, label, () => launcher(label, cwd, argv)); } // its title escape names the tmux pane too
      catch (e: any) { host.message('error', `Couldn't open the Claude pane: ${e.message}`); }
    },
    openFile(file, opts) {
      if (pane.edit) return pane.edit(file, opts?.line);
      if (opts?.preview) { // rendered markdown (plans): a pager over the board
        const viewer = onPath('glow') ? ['glow', '-p', file] : ['less', '-R', file];
        return pane.popup(() => launcher(path.basename(file), path.dirname(file), viewer));
      }
      host.terminal(`Edit · ${path.basename(file)}`, path.dirname(file), [...editor(), ...(opts?.line ? [`+${opts.line}`] : []), file]);
    },
    openExternal: url => { if (/^https?:\/\//.test(url)) execFile(opener, [url]); },
    log: line => fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`, () => {}),
  };
  setHost(host);

  // Long text (epic description, plan changes, send-back notes) in $EDITOR over the board; undefined = cancelled.
  async function editText(initial: string, hint: string): Promise<string | undefined> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-text-'));
    const file = path.join(dir, 'TEXT.md'), done = path.join(dir, 'done');
    try {
      fs.writeFileSync(file, `${initial}\n\n${SCISSORS}\n${hint.split('\n').map(l => `# ${l}`).join('\n')}\n# Everything from the >8 line down is ignored. Leave the text empty to cancel.\n`, { mode: 0o600 });
      // The launcher writes `done` once the editor exits; Neovim's floating window writes it on close.
      pane.popup(() => launcher('LexCode · edit', dir, ['sh', '-c', '"$@"; : > "$0"', done, ...editor(), file]), { file, done });
      while (!fs.existsSync(done)) await new Promise(r => setTimeout(r, 500));
      return cutHelp(fs.readFileSync(file, 'utf8')) || undefined;
    } catch (e: any) {
      host.message('error', `Couldn't open the editor: ${e.message}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const store = new Store(boardFile, s => { try { if (s.source) syncSource(s); } catch (e: any) { host.log(e.message); } });
  const agents = new AgentWatcher(store);
  let data: { board: Board; agents: Record<string, Agent>; factory: {
    plans: Record<string, string>; stages: Record<string, string>; skills: Record<string, string[]>; efforts: string[];
    targetBranch: string; builderMode: string; workers: number; roleAgents: Record<string, { roles: Record<string, string> }>;
  } } | undefined;
  let push = () => {};
  const factory = new FactoryRunner(store, agents, path.join(path.dirname(boardFile), 'locks'), path.join(ROOT, 'agents'), () => push());
  const shell = (p: Project) => launch({ key: `shell:${p.id}`, label: `shell · ${p.name}` }, () => host.terminal(`Shell · ${p.name}`, p.path, [process.env.SHELL || 'sh']));
  const core = dashboardCore(store, agents, factory, (m: any) => { if (m?.type === 'board') { data = m; render(); } }, '', () => push(), cliProjects(store, shell));
  push = core.push;
  agents.onDidChange(push);
  fs.watchFile(boardFile, { interval: 1000 }, () => { store.reload(); push(); }); // VS Code, `lexcode ui`, sync

  const enter = () => { out.write('\x1b[?1049h\x1b[?25l'); process.stdin.setRawMode(true); process.stdin.resume(); render(); };
  const leave = () => { out.write('\x1b[0m\x1b[?25h\x1b[?1049l'); if (process.stdin.isTTY) process.stdin.setRawMode(false); };
  let suspended = false;
  const tmuxSelf = process.env.TMUX_PANE;
  const inNvim = (mode === 'nvim' || mode === 'auto') && !!process.env.NVIM;
  if (inNvim) pane = nvimPane(process.env.NVIM!);
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

  const storyNeeds = (s: Story) => liveRun(s, data!.agents)?.state === 'blocked';
  const needsYou = (p: Project) => {
    const b = data!.board;
    return b.stories.filter(s => s.projectId === p.id && !s.epicId && storyNeeds(s)).length
      + b.epics.filter(e => e.projectId === p.id && e.stage && epicNeeds(b, e, data!.agents)).length;
  };

  /* ---------- epics screen: cursor over the epic list, then the selected epic's sprint rows ---------- */
  let screen: 'board' | 'epics' = 'board';
  let selEpic: string | undefined, selRow: string | undefined; // selRow undefined: cursor is on the epic list
  const epicState = () => {
    const es = data!.board.epics.filter(e => e.projectId === project()?.id && e.stage);
    const e = es.find(x => x.id === selEpic) ?? es[0];
    const v = e && epicView(data!.board, e, data!.agents, data!.factory.plans[e.id]);
    const r = v?.rows.find(x => x.id === selRow);
    return { es, e, v, r, at: r ? es.length + v!.rows.indexOf(r) : Math.max(0, es.indexOf(e!)) };
  };
  // j/k: the selected epic's line, then its rows. h/l: previous/next epic.
  const epicStep = (dy: number) => {
    const { e, v, r } = epicState();
    if (!e || !v) return;
    const n = Math.max(-1, Math.min((r ? v.rows.indexOf(r) : -1) + dy, v.rows.length - 1));
    selEpic = e.id;
    selRow = n < 0 ? undefined : v.rows[n].id;
  };
  const epicSwitch = (d: number) => {
    const { es, e } = epicState();
    if (!es.length) return;
    selEpic = es[(es.indexOf(e!) + d + es.length) % es.length].id;
    selRow = undefined;
  };
  const glyph = (e: Board['epics'][number]) => epicNeeds(data!.board, e, data!.agents) ? '!' : e.stage === 'done' ? '✓'
    : e.stage === 'cancelled' || e.stage === 'failed' ? '✗' : e.stage === 'building' || e.stage?.match(/planning|revalidating|securityCheck/) ? '◉' : '·';

  function renderEpics(W: number, body: number): { lines: string[]; footer: string } {
    const { es, e, v, at } = epicState();
    const b = data!.board;
    const items: [string, string, boolean][] = []; // text, sgr, cursor
    es.forEach((x, i) => {
      const cur = i === at, sel = x === e;
      items.push([`${cur ? '▸' : sel ? '›' : ' '} ${fit(x.title, Math.max(8, Math.floor(W * 0.35)))} ${fit(`${glyph(x)} ${data!.factory.stages[x.stage!] ?? x.stage}`, 28)} ${progress(b, x)}`,
        cur ? '7' : epicNeeds(b, x, data!.agents) ? '33' : '', cur]);
    });
    if (!es.length) items.push(['  No factory epics in this project yet. N starts one.', '2', false]);
    if (e && v) {
      items.push(['─'.repeat(W), '2', false]);
      const files = e.attachments?.length ? `   📎 ${e.attachments.map(a => a.name).join(', ')}` : '';
      items.push([` ${e.title}   ${e.branch ? `${e.branch} → ${e.targetBranch ?? data!.factory.targetBranch}   ` : ''}${e.builderMode === 'auto' ? '🤖 Full auto' : '🛡 Accept edits'}${files}`, '1', false]);
      items.push([` ${pipeline(b, e)}`, '', false]);
      for (const l of v.lines) items.push([`   ${l}`, l.startsWith('✗') || l.startsWith('⚠') ? '31' : '2', false]);
      if (v.rows.length) items.push(['', '', false]);
      v.rows.forEach((r, i) => {
        const cur = es.length + i === at;
        items.push([`${cur ? '▸' : ' '} ${fit(r.text, Math.max(8, W - 42))} ${r.badge}`, cur ? '7' : r.needs ? '33' : '', cur]);
        for (const l of r.lines) items.push([`      ${l}`, l.startsWith('✗') ? '31' : '2', false]);
      });
    }
    const c = items.findIndex(i => i[2]);
    scroll = Math.max(0, Math.min(scroll, c), c - body + 1);
    const lines = Array.from({ length: body }, (_, i) => { const it = items[i + scroll]; return it ? sgr(it[1], fit(it[0], W)) : fit('', W); });
    const keys = epicKeys();
    const footer = [...Object.entries(keys).map(([k, a]) => `${k} ${a.label}`),
      ...(help ? ['j/k rows', 'h/l epic', 'N new epic', 'g next needing you', '[ ] project', 'tab → pane', 'r reload', 'e board', 'q quit'] : ['h/l epic', 'N new', 'g next', 'e board', '? help'])].join('  ');
    return { lines, footer: ` ${footer}` };
  }
  const epicKeys = (): Record<string, Act> => { const { v, r } = epicState(); return { ...v?.keys, ...r?.keys }; };
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
    const left = ` LexCode ─ ${p?.name ?? 'no projects (A to add)'}${p && screen === 'epics' ? ' ─ epics' : ''}${projects().length > 1 ? '  [ ]' : ''}`;
    lines.push(sgr('1', fit(left, W - right.length)) + sgr(needs ? '33' : '2', right));
    const body = H - 3;
    const cs = columns();
    let footer = help
      ? ' ⏎/a attach  c new session  H/L move status  n new story  d delete  o shell  e epics  N new epic  g next needing you  A add project  i import  tab → pane  r reload  q quit'
      : ' ⏎ attach  H/L status  n new  e epics  g next  tab → claude  ? help  q quit';

    if (!p) for (let i = 0; i < body; i++) lines.push(fit(i === 1 ? '  A add a project folder   q quit' : '', W));
    else if (screen === 'epics') { const ev = renderEpics(W, body); lines.push(...ev.lines); footer = ev.footer; }
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
      lines.push(sgr('2', fit(footer, W)));
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
    const run = liveRun(s, data!.agents);
    launch({ key: s.id, label: s.title }, () =>
      core.handle(fresh ? { type: 'newSession', id: s.id } : run ? { type: 'attach', id: s.id, sessionId: run.sessionId } : { type: 'claude', id: s.id }));
  };
  const gate = (epicId: string, decision: string, extra: Record<string, unknown> = {}) => core.handle({ type: 'factoryGate', epicId, decision, ...extra });
  const builders = async (value: number) => {
    const n = Number(await host.input('Builders: how many sprints may build at once (1–8)', String(value)));
    return Number.isInteger(n) && n >= 1 && n <= 8 ? n : undefined;
  };
  const PR_VIA: [string, string][] = [['auto', 'Auto (GitHub → gh, else Gitea)'], ['gh', 'GitHub (gh)'], ['tea', 'Gitea (tea)'], ['skill', 'Claude skill…']];

  async function runAct(act: Act) {
    const { e } = epicState();
    if (!e) return;
    if ('msg' in act) {
      if (act.msg.type === 'attachEpic') return launch({ key: String(act.msg.sessionId), label: e.title }, () => core.handle(act.msg));
      return core.handle(act.msg);
    }
    if ('plan' in act) return core.handle({ type: 'openPlan', epicId: e.id, source: act.plan === 'source' });
    if ('url' in act) return host.openExternal(act.url);
    const f = data!.factory;
    switch (act.ask) {
      case 'changes': {
        const text = await editText('', `What should change in the plan for "${e.title}"?\nThis goes back to the orchestrator, which plans again.`);
        if (text) gate(e.id, 'changes', { text });
        return;
      }
      case 'sendBack': {
        const text = await editText('', 'What should the builder fix before this sprint is merged?');
        if (text) gate(e.id, 'sendBack', { sprintId: act.sprintId, text });
        return;
      }
      case 'start': case 'workers': {
        const n = await builders(e.workers ?? f.workers ?? 1);
        if (n) gate(e.id, act.ask, { workers: n });
        return;
      }
      case 'prOpened': {
        const url = (await host.input('URL of the PR the skill opened'))?.trim();
        if (url && /^https?:\/\/\S+$/.test(url)) gate(e.id, 'prOpened', { url });
        else if (url) host.message('error', `"${url}" isn't an http(s) URL.`);
        return;
      }
      case 'createPr': {
        const p = data!.board.projects.find(x => x.id === e.projectId);
        const label = await host.message('info', `Open a PR for "${e.title}" with`, undefined, ...PR_VIA.map(v => v[1]));
        const via = PR_VIA.find(v => v[1] === label)?.[0];
        if (!via) return;
        let skill: string | undefined;
        if (via === 'skill') {
          const skills = f.skills[e.projectId] ?? [];
          if (!skills.length) return host.message('error', `No Claude skills found in ${p?.name ?? 'this project'}.`);
          skill = (await host.message('info', 'Which skill opens the PR?', undefined, ...skills.map(s => `/${s}`)))?.slice(1);
          if (!skill) return;
        }
        const targetBranch = (await host.input('PR target branch', e.targetBranch ?? f.targetBranch))?.trim();
        if (!targetBranch) return;
        if (!validBranch(targetBranch)) return host.message('error', `"${targetBranch}" isn't a valid branch name.`);
        gate(e.id, 'createPr', { targetBranch, via, skill });
        return;
      }
    }
  }

  // N: the dashboard's epic form as a run of prompts. Nothing is created until the last one; esc anywhere cancels.
  async function newEpic(p: Project) {
    const f = data!.factory;
    const title = (await host.input(`New factory epic in ${p.name}: title`))?.trim();
    if (!title) return;
    const MODES = ['Accept edits', 'Full auto', 'Manual epic (no factory)'];
    const how = await host.message('info', `"${title}": how should builders run?`,
      { detail: `default ${f.builderMode === 'auto' ? 'Full auto' : 'Accept edits'}` }, ...(f.builderMode === 'auto' ? [MODES[1], MODES[0], MODES[2]] : MODES));
    if (!how) return;
    if (how === MODES[2]) { core.handle({ type: 'addEpic', id: p.id, start: false, title }); return; }
    if (how === MODES[1] && !await host.message('warn', 'Full auto: builders run shell commands without asking you. Use it?', undefined, 'Yes, full auto')) return;
    const description = await editText('', `Describe "${title}": goal, constraints, acceptance criteria.\nThe orchestrator plans sprints and stories from this.`);
    if (description === undefined) return;
    let targetBranch: string | undefined = f.targetBranch;
    for (;;) {
      targetBranch = (await host.input('Target branch for the PR', targetBranch))?.trim();
      if (!targetBranch) return;
      if (validBranch(targetBranch)) break;
      host.message('error', `"${targetBranch}" isn't a valid branch name.`);
    }
    const models: Record<string, { model: string; effort: string }> = {};
    const m = await host.message('info', 'Models', { detail: 'defaults: planner opus/high, builder and reviewer from settings' }, 'Defaults', 'Customize');
    if (!m) return;
    if (m === 'Customize') for (const role of ['planner', 'builder', 'reviewer']) {
      const model = await host.message('info', `${role} model`, undefined, 'default', 'opus', 'sonnet', 'haiku', 'fable');
      const effort = model && await host.message('info', `${role} effort`, undefined, 'default', ...f.efforts);
      if (!model || !effort) return;
      models[role] = { model: model === 'default' ? '' : model, effort: effort === 'default' ? '' : effort };
    }
    let attachments: ReturnType<typeof readRefs> = [];
    for (;;) {
      const refs = await host.input('Reference files: comma-separated paths (empty for none)', '');
      if (refs === undefined) return;
      try { attachments = readRefs(refs, p.path); break; } catch (e: any) { host.message('error', e.message); }
    }
    const roles = Object.entries(f.roleAgents[p.id]?.roles ?? {}).map(([r, a]) => `${r}: ${a}`).join(', ');
    const go = await host.message('info', `Start planning "${title}"?`, { detail: [how, `→ ${targetBranch}`,
      attachments.length && `${attachments.length} file${attachments.length > 1 ? 's' : ''}`, roles && `agents ${roles}`].filter(Boolean).join(' · ') }, 'Start planning');
    if (!go) return;
    await core.handle({ type: 'addEpic', id: p.id, start: true, title, description, targetBranch, builderMode: how === MODES[1] ? 'auto' : 'acceptEdits', models, attachments });
    screen = 'epics';
    selEpic = data!.board.epics.find(x => x.projectId === p.id && x.title === title && x.stage)?.id;
    selRow = undefined;
    render();
  }

  // g: the next thing waiting on you, in any project: epic gates/errors/blocked sprints, then blocked background runs.
  function nextNeeding() {
    const b = data!.board, ps = projects();
    const spots: { pi: number; epic?: string; row?: string; story?: Story }[] = [];
    ps.forEach((p, i) => {
      for (const e of b.epics.filter(x => x.projectId === p.id && x.stage && epicNeeds(b, x, data!.agents))) {
        const rows = epicView(b, e, data!.agents).rows.filter(r => r.needs);
        if (rows.length) rows.forEach(r => spots.push({ pi: i, epic: e.id, row: r.id }));
        else spots.push({ pi: i, epic: e.id });
      }
      for (const s of b.stories.filter(x => x.projectId === p.id && !x.archived && !x.epicId && storyNeeds(x))) spots.push({ pi: i, story: s });
    });
    if (!spots.length) return host.message('info', 'Nothing needs you right now.');
    const here = spots.findIndex(x => x.pi === pi && (screen === 'epics' ? x.epic === selEpic && x.row === selRow : x.story?.id === selId));
    // From the current spot on; otherwise the first one in or after the current project.
    const next = here >= 0 ? spots[(here + 1) % spots.length] : spots.find(x => x.pi >= pi) ?? spots[0];
    pi = next.pi;
    if (next.story) { screen = 'board'; selId = next.story.id; }
    else { screen = 'epics'; selEpic = next.epic; selRow = next.row; }
  }

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
    const k = key.name === 'return' ? 'return' : str ?? key.name ?? '';
    // Both screens
    if (k === 'e' && p) { screen = screen === 'board' ? 'epics' : 'board'; scroll = 0; return render(); }
    if (k === 'N' && p) { newEpic(p).catch(e => host.message('error', e.message)); return; }
    if (k === 'g') { nextNeeding(); scroll = 0; return render(); }
    if (screen === 'epics' && p) {
      const acts = epicKeys();
      if (k === 'q') return quit();
      if (k === 'j' || key.name === 'down') epicStep(1);
      else if (k === 'k' || key.name === 'up') epicStep(-1);
      else if (k === 'h' || key.name === 'left') epicSwitch(-1);
      else if (k === 'l' || key.name === 'right') epicSwitch(1);
      else if (k === '[' || k === ']') { pi = (pi + (k === '[' ? -1 : 1) + projects().length) % Math.max(1, projects().length); selEpic = selRow = undefined; scroll = 0; }
      else if (k === 'r') { store.reload(); push(); }
      else if (k === '?') help = !help;
      else if (k === 'tab' || k === '\t') pane.focus();
      else if (acts[k] || (k === 'return' && acts.a)) runAct(acts[k] ?? acts.a).catch(e => host.message('error', e.message));
      return render();
    }
    switch (k) {
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
