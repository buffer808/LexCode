#!/usr/bin/env node
// LexCode outside VS Code:
//   lexcode [tui]                                          board in the terminal; Claude opens in a tmux/Neovim pane
//   lexcode ui [--port 7420] [--no-open] [--verbose]       dashboard at http://127.0.0.1:7420
//   lexcode sync [projectPath] [--dry-run] [--epic <name>]  TASKS.md -> board, for Claude skills and scripts
//   lexcode epic new [projectPath] --title … | --from -     start a factory epic (the /lexcode-factory skill uses --from -)
// Board file: $LEXCODE_BOARD, else the newest VS Code-family globalStorage copy, else ~/.lexcode/board.json.
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { syncFrom, syncSource, syncSourceOf } from './importer';
import { boardFile, setting } from './config';

const USAGE = `usage: lexcode [tui]
       lexcode ui [--port 7420] [--no-open] [--verbose]
       lexcode sync [projectPath] [--dry-run] [--epic <name>]
       lexcode epic new [projectPath] --title <t> [--description <d> | --description-file <f|->] [--target-branch <b>]
                        [--mode accept-edits|auto] [--{planner,builder,reviewer}-{model,effort} <v>] [--attach <file>]... [--json] [--verbose]
       lexcode epic new [projectPath] --from -     (one JSON object on stdin, same fields as the dashboard form)
       lexcode --version`;

// --name value pairs (repeatable ones collect), bare words are positionals, these are flags without a value.
const FLAGS = ['--dry-run', '--json', '--verbose', '--no-open'];
function parseArgs(args: string[]) {
  const opts: Record<string, string[]> = {}, pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (FLAGS.includes(a)) opts[a] = ['true'];
    else if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    else (opts[a] ??= []).push(args[++i]);
  }
  return { opts, pos, one: (k: string) => opts[k]?.[opts[k].length - 1] };
}

const readStdin = () => fs.readFileSync(0, 'utf8');
const ROLES = ['planner', 'builder', 'reviewer'];

async function epicNew(rest: string[]) {
  const { opts, pos, one } = parseArgs(rest);
  for (const k of Object.keys(opts)) {
    if (![...FLAGS, '--title', '--description', '--description-file', '--target-branch', '--mode', '--attach', '--from',
      ...ROLES.flatMap(r => [`--${r}-model`, `--${r}-effort`])].includes(k)) throw new Error(`Unknown option ${k}\n${USAGE}`);
  }
  // Input in the dashboard's addEpic shape; dashboardCore validates it exactly like dashboard input.
  let raw: any;
  if (one('--from')) {
    if (one('--from') !== '-') throw new Error('--from only reads stdin: --from -');
    try { raw = JSON.parse(readStdin()); } catch (e: any) { throw new Error(`--from -: invalid JSON (${e.message})`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--from -: expected one JSON object');
    if (raw.builderMode !== undefined && raw.builderMode !== 'auto' && raw.builderMode !== 'acceptEdits') throw new Error('builderMode must be "acceptEdits" or "auto"');
  } else {
    const df = one('--description-file');
    const mode = one('--mode') ?? 'accept-edits';
    if (mode !== 'accept-edits' && mode !== 'auto') throw new Error('--mode is accept-edits or auto');
    raw = {
      title: one('--title'), targetBranch: one('--target-branch'), builderMode: mode === 'auto' ? 'auto' : 'acceptEdits',
      description: df ? (df === '-' ? readStdin() : fs.readFileSync(df, 'utf8')) : one('--description'),
      models: Object.fromEntries(ROLES.map(r => [r, { model: one(`--${r}-model`), effort: one(`--${r}-effort`) }])),
      attachments: (opts['--attach'] ?? []).map(f => {
        const st = fs.statSync(f, { throwIfNoEntry: false });
        if (!st?.isFile()) throw new Error(`--attach ${f}: not a file`);
        if (st.size > 25 * 1024 * 1024) throw new Error(`--attach ${f}: over 25 MB`);
        return { name: path.basename(f), mime: '', data: fs.readFileSync(f).toString('base64') };
      }),
    };
  }
  if (Array.isArray(raw.attachments) && raw.attachments.length > 20) throw new Error('At most 20 reference files.');

  const { setHost } = await import('./host');
  const verbose = !!one('--verbose');
  const errors: string[] = [];
  setHost({
    message: (level, text, o) => { (level === 'error' ? errors : []).push(text); console.error(`[${level}] ${text}${o?.detail ? `: ${o.detail}` : ''}`); return Promise.resolve(undefined); },
    input: () => Promise.resolve(undefined), // non-interactive
    setting,
    terminal: (_t, cwd, argv) => console.error(`Run this yourself in ${cwd}: ${argv.join(' ')}`),
    openFile: file => console.error(`See ${file}`),
    openExternal: url => console.error(url),
    log: line => { if (verbose) console.error(line); },
  });
  const file = boardFile();
  const store = new Store(file);
  const p = store.projectFor(pos[0] ?? process.cwd());
  if (!p) throw new Error(`${path.resolve(pos[0] ?? '.')} is not a LexCode project (board: ${file}). Add it first: lexcode → A, or the Board's +.`);

  const { AgentWatcher } = await import('./claude');
  const { FactoryRunner } = await import('./factoryRunner');
  const { dashboardCore } = await import('./dashboardCore');
  const agents = new AgentWatcher(store);
  const factory = new FactoryRunner(store, agents, path.join(path.dirname(file), 'locks'), path.join(__dirname, '..', 'agents'), () => {}, { drive: false });
  const before = new Set(store.all().epics.map(e => e.id));
  try {
    const core = dashboardCore(store, agents, factory, () => {}, '', () => {}, { add() {}, remove() {}, importTasks() {}, open() {} });
    await core.handle({ ...raw, type: 'addEpic', id: p.id, start: true });
  } finally {
    agents.dispose();
    factory.dispose(); // gives the new epic's lock back: a running LexCode app takes it over at once
  }
  store.reload();
  const epic = store.all().epics.find(e => !before.has(e.id) && e.projectId === p.id && e.stage);
  if (!epic) {
    if (!errors.length) throw new Error('The epic was not created.');
    process.exitCode = 1; // the reason is already on stderr
    return;
  }
  if (one('--json')) console.log(JSON.stringify({ epicId: epic.id, branch: epic.branch, stage: epic.stage, project: p.path, error: epic.error }));
  else if (!epic.error) console.log(`Planning "${epic.title}" (epic ${epic.id}, branch ${epic.branch}) in ${p.name}.\n`
    + 'Planning runs as a Claude background session. Approve the plan in VS Code, `lexcode ui`, or `lexcode`; one of them must be running for the epic to reach the plan gate.');
  if (epic.error) { console.error(`Epic ${epic.id} was created but planning didn't start: ${epic.error}`); process.exitCode = 1; }
}

async function main(argv: string[]) {
  const [cmd = 'tui', ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') return console.log(require('../package.json').version);
  if (cmd === 'tui') return (await import('./tui')).tui(boardFile());
  if (cmd === 'ui') {
    const pi = rest.indexOf('--port'), port = pi >= 0 ? Number(rest[pi + 1]) : 7420;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port needs a port number');
    const { serve } = await import('./server'); // keeps ws/node-pty out of `sync` and `epic new`
    return serve(boardFile(), { port, open: !rest.includes('--no-open'), verbose: rest.includes('--verbose') });
  }
  if (cmd === 'epic' && rest[0] === 'new') return epicNew(rest.slice(1));
  if (cmd !== 'sync') throw new Error(USAGE);
  const dryRun = rest.includes('--dry-run');
  const ei = rest.indexOf('--epic');
  const epic = ei >= 0 ? rest[ei + 1] : undefined;
  if (ei >= 0 && !epic) throw new Error('--epic needs a name');
  const dir = path.resolve(rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--epic') ?? process.cwd());
  const file = boardFile();
  // Same write-back as the extension: status changes tick the source checkbox.
  const store = new Store(file, s => { if (s.source) syncSource(s); });
  const p = store.projectFor(dir);
  if (!p) throw new Error(`${dir} is not a LexCode project (board: ${file})`);
  const src = syncSourceOf(p.path);
  if (!src) throw new Error(`No TASKS.md in ${p.path}`);
  const r = syncFrom(store, p.id, src.parsed, { dryRun, epic });
  console.log(`${dryRun ? '[dry run] ' : ''}${p.name}${epic ? ` (epic ${epic})` : ''}: ${path.relative(p.path, src.file)} -> ${file}`);
  for (const [k, xs] of Object.entries(r)) for (const x of xs) console.log(`${k}\t${x}`);
  if (!r.added.length && !r.updated.length && !r.archived.length) console.log('in sync');
}

main(process.argv.slice(2)).catch((e: any) => { console.error(e.message); process.exit(1); });
