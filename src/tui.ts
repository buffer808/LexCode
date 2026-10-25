// `lexcode tui`: LexCode in the terminal, drawn like Claude Code on the normal screen. Events print once into
// scrollback; the task list (or epics view), the prompt and the status line are redrawn in place under them.
// Plain text becomes a story, `/` opens the command menu, `@` names a task. Attaching still opens Claude in a
// tmux/Neovim pane or takes over the terminal (rework steps R3/R4 replace that with a modal and tabs).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import { execFile, spawnSync } from 'child_process';
import { Store, Board, Story, Status, Project } from './store';
import { Agent, AgentWatcher, liveRun, claudeBin, storySessions } from './claude';
import { FactoryRunner } from './factoryRunner';
import { dashboardCore } from './dashboardCore';
import { Host, setHost } from './host';
import { syncSource } from './importer';
import { Pane, tmuxPane, nvimPane, inlinePane, ideArgs, ideLocks } from './panes';
import { Act, SCISSORS, cutHelp, epicNeeds, epicView, pipeline, progress } from './epicView';
import { validBranch } from './factory';
import { launcher, cliProjects, opener, onPath } from './server';
import { HOME, setting } from './config';
import { Live, Seg, box, fit, line, sgr, width, SPIN, ORANGE, DIM, GREEN, YELLOW, RED, BOLD } from './render';
import { COMMANDS, View, complete, epicCommand, parse, pick } from './commands';
export { fit };

const STATUSES: Status[] = ['todo', 'doing', 'review', 'done'];
const ROOT = path.join(__dirname, '..');

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
  const live = new Live(out);
  let quitting = false;
  type Ask = { kind: 'input' | 'choice'; text: string; level?: string; detail?: string; value: string; actions: string[]; cur: number; resolve: (v?: string) => void };
  const asks: Ask[] = [];
  const ask = (a: Omit<Ask, 'resolve' | 'cur'>) => new Promise<string | undefined>(resolve => { asks.push({ ...a, cur: 0, resolve }); render(); });
  const logFile = path.join(HOME, 'tui.log');
  const say = (level: string, text: string) => live.print([line([['⏺ ', level === 'error' ? RED : level === 'warn' ? YELLOW : GREEN], [text]], width(text) + 2)]);

  let pane: Pane;
  let intent: { key: string; label: string } | undefined; // the card being attached, read by host.terminal
  // Attaches run one at a time so each launch reads its own intent (keys in one stdin chunk arrive back to back).
  let launches = Promise.resolve();
  const launch = (i: { key: string; label: string }, run: () => unknown) => {
    launches = launches.then(async () => { intent = i; try { await run(); } finally { intent = undefined; } }).catch(e => host.log(e.message));
  };
  const host: Host = {
    message(level, text, opts, ...actions) {
      if (!actions.length) { say(level, opts?.detail ? `${text}: ${opts.detail}` : text); return Promise.resolve(undefined); }
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
  const core = dashboardCore(store, agents, factory, (m: any) => { if (m?.type === 'board') { data = m; announce(); render(); } }, '', () => push(), cliProjects(store, shell));
  push = core.push;
  agents.onDidChange(push);
  fs.watchFile(boardFile, { interval: 1000 }, () => { store.reload(); push(); }); // VS Code, `lexcode ui`, sync

  let welcomed = false;
  const enter = () => {
    out.write('\x1b[?25l\x1b[?2004h'); // hide the cursor (the prompt draws its own), bracketed paste
    process.stdin.setRawMode(true); process.stdin.resume();
    if (!welcomed) {
      welcomed = true;
      live.print(box([[['✻ ', ORANGE], ['Welcome to LexCode', BOLD]], [['']],
        [['  Type a story, / for commands, @ to name a task', DIM]], [['  shift+tab switches view · ⏎ on an empty prompt attaches', DIM]],
        [[`  cwd: ${process.cwd()}`, DIM]]], Math.min(64, (out.columns || 80) - 1), ORANGE));
    }
    render();
  };
  const leave = () => { live.detach(); out.write('\x1b[0m\x1b[?25h\x1b[?2004l'); if (process.stdin.isTTY) process.stdin.setRawMode(false); };
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

  /* ---------- selection: one list grouped by status ---------- */
  let pi = 0, col = 0, row = 0, scroll = 0, tick = 0;
  let selId: string | undefined; // the cursor follows the card when it changes status (attach, /move, other windows)
  let view: View = 'tasks';
  const projects = () => data?.board.projects ?? [];
  const project = () => projects()[Math.min(pi, projects().length - 1)];
  const columns = () => {
    const p = project();
    return STATUSES.map(st => (data?.board.stories ?? []).filter(s => s.projectId === p?.id && !s.archived && s.status === st));
  };
  const stories = () => columns().flat();
  const selected = (): Story | undefined => columns()[col]?.[row];
  const clamp = () => {
    pi = Math.max(0, Math.min(pi, projects().length - 1));
    const cs = columns();
    const c = selId ? cs.findIndex(l => l.some(s => s.id === selId)) : -1;
    if (c >= 0) { col = c; row = cs[c].findIndex(s => s.id === selId); }
    else {
      col = Math.max(0, Math.min(col, 3));
      // No cursor on an empty group: go to the nearest group with cards.
      if (!cs[col].length) col = [1, 2, 3].flatMap(d => [col - d, col + d]).find(i => cs[i]?.length) ?? col;
      row = Math.max(0, Math.min(row, cs[col].length - 1));
    }
    selId = cs[col][row]?.id;
  };
  // up/down cross into the next non-empty status group.
  const step = (dy: number) => {
    const cs = columns();
    row += dy;
    while (col >= 0 && col < 4 && (row < 0 || row >= cs[col].length)) {
      if (row < 0) { col--; if (col >= 0) row = cs[col].length - 1; } else { col++; row = 0; }
    }
    if (col < 0 || col > 3) { col = Math.max(0, Math.min(col, 3)); row = dy < 0 ? 0 : cs[col].length - 1; }
    selId = cs[col][row]?.id;
  };
  const switchProject = (d: number) => { pi = (pi + d + projects().length) % Math.max(1, projects().length); col = row = scroll = 0; selId = selEpic = selRow = undefined; };

  const storyNeeds = (s: Story) => liveRun(s, data!.agents)?.state === 'blocked';
  const needsYou = (p: Project) => {
    const b = data!.board;
    return b.stories.filter(s => s.projectId === p.id && !s.epicId && storyNeeds(s)).length
      + b.epics.filter(e => e.projectId === p.id && e.stage && epicNeeds(b, e, data!.agents)).length;
  };

  /* ---------- epics view: cursor over the epic list, then the selected epic's sprint rows ---------- */
  let selEpic: string | undefined, selRow: string | undefined; // selRow undefined: cursor is on the epic list
  const epicState = () => {
    const es = data!.board.epics.filter(e => e.projectId === project()?.id && e.stage);
    const e = es.find(x => x.id === selEpic) ?? es[0];
    const v = e && epicView(data!.board, e, data!.agents, data!.factory.plans[e.id]);
    const r = v?.rows.find(x => x.id === selRow);
    return { es, e, v, r, at: r ? es.length + v!.rows.indexOf(r) : Math.max(0, es.indexOf(e!)) };
  };
  // up/down: the selected epic's line, then its rows. left/right: previous/next epic.
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
    : e.stage === 'cancelled' || e.stage === 'failed' ? '✗' : e.stage === 'building' || e.stage?.match(/planning|revalidating|securityCheck/) ? SPIN[tick % SPIN.length] : '·';
  const epicKeys = (): Record<string, Act> => { const { v, r } = epicState(); return { ...v?.keys, ...r?.keys }; };
  // The selected row's actions as the commands that run them, for the status line.
  const epicHints = () => Object.entries(epicKeys()).map(([k, a]) => k === 'a' ? `⏎ ${a.label}` : `/${epicCommand(k, a.label)}`).filter(h => !h.endsWith('undefined'));

  type Item = { segs: Seg[]; cur?: boolean };
  function epicItems(W: number): Item[] {
    const { es, e, v, at } = epicState();
    const b = data!.board;
    const items: Item[] = [];
    es.forEach((x, i) => {
      const cur = i === at, needs = epicNeeds(b, x, data!.agents);
      items.push({ cur, segs: [[cur ? '❯ ' : x === e ? '› ' : '  ', ORANGE], [fit(x.title, Math.max(8, Math.floor(W * 0.35))), cur ? ORANGE : ''],
        [` ${fit(`${glyph(x)} ${data!.factory.stages[x.stage!] ?? x.stage}`, 28)} `, needs ? YELLOW : DIM], [progress(b, x), DIM]] });
    });
    if (!es.length) items.push({ segs: [['  No factory epics in this project yet. /epic starts one.', DIM]] });
    if (e && v) {
      items.push({ segs: [[''] ] });
      const files = e.attachments?.length ? `   📎 ${e.attachments.map(a => a.name).join(', ')}` : '';
      items.push({ segs: [[e.title, BOLD], [`   ${e.branch ? `${e.branch} → ${e.targetBranch ?? data!.factory.targetBranch}   ` : ''}${e.builderMode === 'auto' ? 'Full auto' : 'Accept edits'}${files}`, DIM]] });
      items.push({ segs: [[pipeline(b, e)]] });
      for (const l of v.lines) items.push({ segs: [[`  ⎿  ${l}`, l.startsWith('✗') || l.startsWith('⚠') ? RED : DIM]] });
      v.rows.forEach((r, i) => {
        const cur = es.length + i === at;
        items.push({ cur, segs: [[cur ? '❯ ' : '  ', ORANGE], [fit(r.text, Math.max(8, W - 30)), cur ? ORANGE : ''], [` ${r.badge}`, r.needs ? YELLOW : DIM]] });
        for (const l of r.lines) items.push({ segs: [[`      ⎿  ${l.trim()}`, l.startsWith('✗') ? RED : DIM]] });
      });
    }
    return items;
  }

  const badge = (s: Story, st: ReturnType<Pane['state']>): Seg => {
    const run = liveRun(s, data!.agents);
    if (st.open === s.id) return ['▣ open', '36'];
    if (run?.state === 'blocked') return ['! needs you', YELLOW];
    if (run) return [`${SPIN[tick % SPIN.length]} ${run.state}`, ORANGE];
    if (st.parked.includes(s.id)) return ['⏸ parked', '36'];
    if (s.sessionIds?.length) return ['↻', DIM];
    return [''];
  };
  const meta = (s: Story) => [data!.board.epics.find(e => e.id === s.epicId)?.title, s.points != null && `${s.points}pt`].filter(Boolean).join(' · ');
  const LABEL: Record<Status, string> = { todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' };
  function taskItems(W: number): Item[] {
    const st = pane.state(), items: Item[] = [];
    columns().forEach((list, c) => {
      if (!list.length) return;
      if (items.length) items.push({ segs: [['']] });
      items.push({ segs: [[LABEL[STATUSES[c]], BOLD], [` ${list.length}`, DIM]] });
      list.forEach((s, r) => {
        const cur = c === col && r === row, b = badge(s, st), m = meta(s);
        items.push({ cur, segs: [[cur ? '❯ ' : '  ', ORANGE], [fit(s.title, Math.max(8, W - 36)), cur ? ORANGE : ''], [` ${fit(m, 18)} `, DIM], b] });
      });
    });
    if (!items.length) items.push({ segs: [['  No tasks yet. Type one below.', DIM]] });
    return items;
  }

  /* ---------- prompt state ---------- */
  const pr = { value: '' };
  const hist: string[] = [];
  let hi = 0, menuAt = 0, pasting = false;
  // The / menu (while typing the command name) or @ suggestions (while typing a task name).
  type Entry = { label: string; help: string; fill: string; run?: boolean };
  function menu(): Entry[] {
    if (asks[0]) return [];
    const v = pr.value;
    if (/^\/\S*$/.test(v)) return complete(v, view).slice(0, 7).map(c => ({ label: `/${c.name}${c.args ? ` ${c.args}` : ''}`, help: c.help,
      fill: `/${c.name}${c.args ? ' ' : ''}`, run: !c.args || c.args.startsWith('[') }));
    const at = /(^|\s)@(\S*)$/.exec(v);
    if (at) return stories().filter(s => s.title.toLowerCase().includes(at[2].toLowerCase())).slice(0, 5)
      .map(s => ({ label: `@${s.title}`, help: s.status, fill: `${v.slice(0, v.length - at[2].length)}${s.title.split(/\s+/)[0]} ` }));
    return [];
  }

  /* ---------- drawing ---------- */
  function render() {
    if (quitting || suspended) return;
    const W = (out.columns || 80) - 1, H = out.rows || 24;
    if (!data) return live.draw([sgr(DIM, `${SPIN[tick % SPIN.length]} Loading board…`)]);
    clamp();
    const p = project(), a = asks[0];
    const bottom: string[] = [];
    if (a?.kind === 'choice') {
      bottom.push(...box([[[a.text, a.level === 'error' ? RED : a.level === 'warn' ? YELLOW : BOLD]], ...(a.detail ? [[[a.detail, DIM] as Seg]] : []), [['']],
        ...a.actions.map((x, i): Seg[] => [[i === a.cur ? '❯ ' : '  ', ORANGE], [`${i + 1}. ${x}`, i === a.cur ? ORANGE : '']])], W, ORANGE, 'esc later'));
    } else {
      const m = menu();
      menuAt = Math.max(0, Math.min(menuAt, m.length - 1));
      if (a) bottom.push(line([['  ', ''], [a.text, BOLD]], W));
      const ed = a ?? pr, lines = ed.value.split('\n');
      const rows = lines.map((l, i): Seg[] => [[i ? '  ' : '> ', ORANGE], [l], ...(i === lines.length - 1 ? [['▌', ORANGE] as Seg] : [])]);
      if (!ed.value) rows[0] = [['> ', ORANGE], ['▌', ORANGE], [view === 'tasks' ? ' Describe a story, or / for commands' : ' / for commands', DIM]];
      bottom.push(...box(rows.slice(-Math.max(1, H - 8)), W, a ? ORANGE : DIM));
      for (const [i, e] of m.entries()) bottom.push(line([[i === menuAt ? '  ❯ ' : '    ', ORANGE], [fit(e.label, 34), i === menuAt ? ORANGE : ''], [e.help, DIM]], W));
    }
    const needs = projects().reduce((n, x) => n + needsYou(x), 0);
    const hints = a ? (a.kind === 'choice' ? '↑↓ choose · ⏎ select · esc later' : '⏎ ok · esc cancel · ctrl+g editor')
      : pr.value ? '⏎ send · \\⏎ newline · tab complete · ctrl+g editor'
      : view === 'tasks' ? (selected() ? '⏎ attach · ←→ project · / commands' : '/ commands') : [...epicHints(), '←→ epic'].join(' · ');
    const right = `⏵⏵ ${view} · ${p?.name ?? 'no project'}${needs ? ` · ${needs} need you` : ''}`;
    bottom.push(line([[`  ${fit(hints, Math.max(0, W - width(right) - 3))} `, DIM], [right, needs ? YELLOW : ORANGE]], W));

    const head = p ? line([[projects().length > 1 ? '◂ ' : '', DIM], [p.name, BOLD], [projects().length > 1 ? ' ▸' : '', DIM],
      [`  ${view === 'epics' ? 'epics' : `${stories().length} tasks`}`, DIM]], W) : line([['No projects yet. /add-project tracks a folder.', DIM]], W);
    const items = !p ? [] : view === 'epics' ? epicItems(W) : taskItems(W);
    const room = Math.max(0, H - 2 - bottom.length - 1);
    const c = items.findIndex(i => i.cur);
    scroll = Math.max(0, Math.min(scroll, c < 0 ? 0 : c), c - room + 1);
    if (items.length <= room) scroll = 0;
    const shown = items.slice(scroll, scroll + room).map(i => line(i.segs, W));
    live.draw([head, ...shown, '', ...bottom]);
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
    view = 'epics';
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
    const here = spots.findIndex(x => x.pi === pi && (view === 'epics' ? x.epic === selEpic && x.row === selRow : x.story?.id === selId));
    // From the current spot on; otherwise the first one in or after the current project.
    const next = here >= 0 ? spots[(here + 1) % spots.length] : spots.find(x => x.pi >= pi) ?? spots[0];
    pi = next.pi;
    if (next.story) { view = 'tasks'; selId = next.story.id; }
    else { view = 'epics'; selEpic = next.epic; selRow = next.row; }
  }

  /* ---------- commands ---------- */
  const storyRef = (refs: string[]) => {
    if (!refs.length) return selected();
    const s = pick(stories(), x => x.title, refs[0]);
    if (!s) say('error', `No task matches @${refs[0]}.`);
    return s;
  };
  async function command(text: string) {
    const p = project();
    const { name, args, refs, flags } = parse(text);
    const epicAct = Object.entries(epicKeys()).find(([k, a]) => epicCommand(k, a.label) === name)?.[1];
    if (view === 'epics' && epicAct && !refs.length) return runAct(epicAct);
    const need = <T>(x: T | undefined, why: string) => { if (!x) say('error', why); return x; };
    switch (name) {
      case 'new': if (need(p, 'Add a project first: /add-project.') && args.length) core.handle({ type: 'add', id: p!.id, title: text.trim().replace(/^\/new\s+/i, '') }); return;
      case 'attach': { const s = storyRef(refs); if (need(s, 'No task selected.')) attach(s!, flags.includes('new')); return; }
      case 'move': {
        const to = args[0] as Status, s = storyRef(refs);
        if (!STATUSES.includes(to)) return say('error', `Status is one of ${STATUSES.join(', ')}.`);
        if (need(s, 'No task selected.')) { selId = s!.id; core.handle({ type: 'status', id: s!.id, status: to }); }
        return;
      }
      case 'delete': {
        const s = storyRef(refs);
        if (need(s, 'No task selected.') && await host.message('warn', `Delete "${s!.title}"?`, undefined, 'Delete')) core.handle({ type: 'delete', id: s!.id });
        return;
      }
      case 'epic': if (need(p, 'Add a project first: /add-project.')) await newEpic(p!); return;
      case 'tasks': case 'epics': view = name; scroll = 0; return;
      case 'project': { const x = pick(projects(), q => q.name, args[0] ?? ''); if (need(x, `No project matches "${args[0] ?? ''}".`)) { switchProject(projects().indexOf(x!) - pi); } return; }
      case 'next': nextNeeding(); scroll = 0; return;
      case 'shell': if (need(p, 'No project.')) shell(p!); return;
      case 'add-project': core.handle({ type: 'addProject' }); return;
      case 'import': if (need(p, 'No project.')) core.handle({ type: 'importTasks', id: p!.id }); return;
      case 'reload': store.reload(); push(); return;
      case 'quit': return quit();
      case 'help':
        live.print([sgr(BOLD, 'Commands'), ...COMMANDS.map(c => line([[`  /${fit(`${c.name}${c.args ? ` ${c.args}` : ''}`, 38)}`, ORANGE], [c.help + (c.view ? ` (${c.view} view)` : ''), DIM]], 100).trimEnd()),
          '', sgr(BOLD, 'Keys'), ...[['↑ ↓', 'move through the list (empty prompt), history otherwise'], ['← →', 'previous / next project, or epic in the epics view'],
            ['⏎', 'attach the selected task (empty prompt), or send'], ['\\⏎', 'new line'], ['shift+tab', 'switch view'], ['tab', 'complete / and @'],
            ['ctrl+g', 'edit the prompt in $EDITOR'], ['esc', 'clear the prompt'], ['ctrl+c', 'clear, then quit']].map(([k, h]) => `  ${sgr(ORANGE, fit(k, 12))}${sgr(DIM, h)}`)]);
        return;
    }
    if (COMMANDS.some(c => c.name === name)) return say('error', `/${name} isn't available ${view === 'epics' ? 'on the selected epic row' : 'here'}.`);
    say('error', `Unknown command /${name}. /help lists them.`);
  }

  async function submit(text: string) {
    const p = project();
    if (!text.trim()) { // empty prompt: ⏎ attaches
      if (view === 'epics') { const a = epicKeys().a; if (a) await runAct(a); return; }
      const s = selected();
      if (s) attach(s, false);
      return;
    }
    if (hist[hist.length - 1] !== text) hist.push(text);
    hi = hist.length;
    live.print(text.split('\n').map((l, i) => sgr(DIM, `${i ? ' ' : '>'} ${l}`)));
    if (text.startsWith('/')) return command(text);
    if (!p) return say('error', 'Add a project first: /add-project.');
    core.handle({ type: 'add', id: p.id, title: text.split('\n')[0] });
    say('info', `New story in ${p.name}: ${text.split('\n')[0]}`);
  }

  // A board update: agents whose state changed since the last one print a line.
  const seen = new Map<string, string>();
  function announce() {
    const ss = data!.board.stories;
    for (const ag of Object.values(data!.agents)) {
      const prev = seen.get(ag.sessionId);
      seen.set(ag.sessionId, ag.state);
      if (!prev || prev === ag.state) continue;
      const title = ss.find(s => storySessions(s).includes(ag.sessionId))?.title ?? ag.name ?? ag.id;
      const lvl = ag.state === 'blocked' ? 'warn' : ag.state === 'failed' ? 'error' : 'info';
      say(lvl, `${title} · ${ag.state === 'blocked' ? 'needs you' : ag.state}`);
    }
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

  const fail = (e: any) => say('error', e.message);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on('keypress', (str: string | undefined, key: readline.Key = {}) => {
    if (suspended) return;
    if (key.name === 'paste-start') { pasting = true; return; }
    if (key.name === 'paste-end') { pasting = false; return render(); }
    const a = asks[0], ed = a ?? pr;
    const done = (v?: string) => { asks.shift(); a!.resolve(v); render(); };
    if (key.ctrl && key.name === 'c') { if (a) return done(); if (pr.value) { pr.value = ''; return render(); } return quit(); }
    if (a?.kind === 'choice') {
      const n = Number(str);
      if (key.name === 'escape') return done();
      if (n >= 1 && n <= a.actions.length) return done(a.actions[n - 1]);
      if (key.name === 'return') return done(a.actions[a.cur]);
      if (key.name === 'up' || key.name === 'down') a.cur = (a.cur + (key.name === 'up' ? -1 : 1) + a.actions.length) % a.actions.length;
      return render();
    }
    if (!data) return;
    const m = menu();
    if (key.name === 'escape') { if (a) return done(); pr.value = ''; return render(); }
    if (key.ctrl && key.name === 'g') { editText(ed.value, 'Edit the prompt, then save and quit.').then(t => { if (t !== undefined) ed.value = t; render(); }); return; }
    if (key.name === 'tab' && key.shift) { if (!a) { view = view === 'tasks' ? 'epics' : 'tasks'; scroll = 0; } return render(); }
    if (key.name === 'tab') { if (m[menuAt]) ed.value = m[menuAt].fill; return render(); }
    if (key.name === 'return' || key.name === 'enter') {
      if (pasting || key.meta || ed.value.endsWith('\\')) { ed.value = ed.value.replace(/\\$/, '') + '\n'; return render(); }
      if (a) return done(ed.value);
      const e = m[menuAt];
      if (e && !e.run) { pr.value = e.fill; return render(); } // command with arguments, or @ pick: fill it in, keep typing
      const text = e ? e.fill.trim() : pr.value;
      pr.value = '';
      submit(text).catch(fail).finally(render);
      return render();
    }
    if (key.name === 'up' || key.name === 'down') {
      const d = key.name === 'up' ? -1 : 1;
      if (m.length) menuAt += d;
      else if (!ed.value && !a && hi === hist.length) { if (view === 'epics') epicStep(d); else step(d); }
      else if (!a && hist.length) { hi = Math.max(0, Math.min(hi + d, hist.length)); pr.value = hist[hi] ?? ''; }
      return render();
    }
    if (key.name === 'left' || key.name === 'right') {
      if (!ed.value && !a) { const d = key.name === 'left' ? -1 : 1; if (view === 'epics') epicSwitch(d); else switchProject(d); }
      return render();
    }
    if (key.name === 'backspace') ed.value = Array.from(ed.value).slice(0, -1).join('');
    else if (str && !key.ctrl && !key.meta && str >= ' ') { ed.value += str; menuAt = 0; if (!a) hi = hist.length; }
    else return;
    render();
  });
  out.on('resize', () => { live.reset(); render(); });
  // Spinners while anything runs; otherwise a slow refresh for pane state.
  setInterval(() => { tick++; if (data && Object.values(data.agents).some(x => !['done', 'stopped', 'failed', 'blocked'].includes(x.state))) render(); }, 200);
  setInterval(render, 3000);
  enter();
  push();
}
