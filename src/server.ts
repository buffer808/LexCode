// `lexcode ui`: the dashboard as a localhost web app. Claude sessions (attach, resume, new) open in the OS terminal app,
// or in browser terminal tabs with "lexCode.ui.terminal": "browser".
// Same board.json, factory locks and dashboard code as the extension, so both can run at once.
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { execFile, spawn } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, Project } from './store';
import { AgentWatcher } from './claude';
import { FactoryRunner } from './factoryRunner';
import { dashboardCore, ProjectActions } from './dashboardCore';
import { Host, setHost, host } from './host';
import { findTasksFile, parseTasks, importInto, syncSource } from './importer';

import { HOME, setting } from './config';
const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'media');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Kept across restarts so an open tab's cookie stays valid.
function token(): string {
  const file = path.join(HOME, 'ui-token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* first run */ }
  const t = randomBytes(24).toString('base64url');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
export const onPath = (bin: string) => (process.env.PATH ?? '').split(path.delimiter).some(d => fs.existsSync(path.join(d, bin)));
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Unix: a self-deleting script that runs argv in cwd, so prompts with quotes/newlines survive and never meet a shell
// unquoted. Also keeps long prompts off tmux/nvim command lines. ext: '.command' makes macOS open it in the terminal app.
export function launcher(title: string, cwd: string, argv: string[], ext = '.sh') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-'));
  const file = path.join(dir, `claude${ext}`);
  fs.writeFileSync(file, ['#!/bin/sh', `rm -rf ${shellQuote(dir)}`, `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `cd ${shellQuote(cwd)} || exit 1`, argv.map(shellQuote).join(' '), ''].join('\n'), { mode: 0o700, flag: 'wx' });
  return file;
}

// Runs argv in a new window of the user's terminal app.
// macOS opens .command files with whatever app owns them (Terminal, or iTerm/Ghostty/… if set as the default).
function nativeTerminal(title: string, cwd: string, argv: string[]) {
  const run = (cmd: string, args: string[]) => spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
    .on('error', e => console.error(`Couldn't open a terminal (${cmd}): ${e.message}`)).unref();
  if (process.platform === 'win32') {
    // ponytail: cmd.exe quoting; multi-line story prompts get cut at the first newline there.
    const q = (a: string) => `"${a.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    return run('cmd.exe', ['/c', 'start', q(title), '/D', q(cwd), 'cmd', '/k', argv.map(q).join(' ')]);
  }
  const file = launcher(title, cwd, argv, process.platform === 'darwin' ? '.command' : '.sh');
  if (process.platform === 'darwin') return run('open', [file]);
  const term = [process.env.TERMINAL, 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find(t => t && onPath(t));
  if (!term) return console.error('No terminal app found; set $TERMINAL.');
  run(term, [...(term === 'gnome-terminal' ? ['--'] : ['-e']), 'sh', file]);
}

// npm can skip node-pty's postinstall (allow-scripts), leaving its macOS spawn-helper non-executable.
function ptyHelper() {
  for (const dir of ['prebuilds', 'build/Release']) {
    const base = path.join(path.dirname(require.resolve('node-pty/package.json')), dir);
    for (const f of [path.join(base, 'spawn-helper'), ...(fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d, 'spawn-helper')) : [])]) {
      try { fs.chmodSync(f, 0o755); } catch { /* not there */ }
    }
  }
}

// Inside `root`, or undefined (blocks ../ escapes).
function within(root: string, rel: string) {
  const f = path.resolve(root, '.' + path.sep + rel);
  return f.startsWith(root + path.sep) ? f : undefined;
}

// Project actions for the apps outside VS Code (`lexcode ui`, `lexcode tui`); prompts go through host().
export function cliProjects(store: Store, open: (p: Project) => unknown): ProjectActions {
  const importTasks = async (p: Project, quiet: boolean) => {
    const file = findTasksFile(p.path, setting<string[] | undefined>('tasksScanSkip', undefined));
    if (!file) return quiet || host().message('info', `No TASKS.md found in ${p.name}`);
    const parsed = parseTasks(file);
    const n = parsed.epics.length + parsed.sprints.length + parsed.stories.length;
    if (!n) return quiet || host().message('info', `${path.relative(p.path, file)}: nothing open to import`);
    const go = await host().message('info', `${p.name}: found ${path.relative(p.path, file)} (${parsed.epics.length} epics, ${parsed.sprints.length} sprints, ${parsed.stories.length} open stories). Import them?`,
      { modal: true }, 'Import all');
    if (!go) return;
    const r = importInto(store, p.id, parsed);
    host().message('info', `Imported ${r.epics} epics, ${r.sprints} sprints, ${r.stories} stories (duplicates skipped)`);
  };
  return {
    async add() {
      const raw = (await host().input('Project folder (absolute path)'))?.trim();
      if (!raw) return;
      const dir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return host().message('error', `${dir} is not a folder`);
      if (store.all().projects.some(p => p.path === dir)) return;
      await importTasks(store.add('projects', { name: path.basename(dir), path: dir }), true);
    },
    async remove(p) {
      const keep = 'Remove, keep tasks', del = 'Remove and delete tasks';
      const ok = await host().message('warn', `Remove ${p.name} from LexCode?`, { modal: true,
        detail: 'Kept tasks (epics, sprints, stories, attachments) come back when this folder is added again.' }, keep, del);
      if (ok) store.remove('projects', p.id, ok === keep);
    },
    importTasks: p => importTasks(p, false),
    open,
  };
}

export async function serve(boardFile: string, { port = 7420, open = true, verbose = false } = {}) {
  ptyHelper();
  const secret = token();
  const store = new Store(boardFile, s => { try { if (s.source) syncSource(s); } catch (e: any) { console.error(e.message); } });
  let origins: string[] = []; // set once listening (port 0 = any free port)

  /* ---------- browser-backed host ---------- */
  const clients: WebSocket[] = [];
  const pending = new Map<string, { ws: WebSocket; resolve: (v: any) => void }>();
  const terms = new Map<string, { cwd: string; argv: string[]; at: number }>(); // one-shot, opened by /pty?id=
  // ponytail: prompts go to the most recently opened tab only; fan out + first-answer-wins if several tabs is common.
  const ask = (m: object) => new Promise<any>(resolve => {
    const ws = clients[clients.length - 1];
    if (!ws) return resolve(undefined);
    const reqId = randomUUID();
    pending.set(reqId, { ws, resolve });
    ws.send(JSON.stringify({ type: 'host', reqId, ...m }));
  });
  const openPath = (target: string, line?: number) =>
    onPath('code') ? execFile('code', line ? ['-g', `${target}:${line}`] : [target]) : execFile(opener, [target]);

  const web: Host = {
    message(level, text, opts, ...actions) {
      (level === 'error' ? console.error : console.log)(`[${level}] ${text}`);
      return ask({ op: 'message', level, text, detail: opts?.detail, modal: !!opts?.modal, actions });
    },
    input: (prompt, value) => ask({ op: 'input', prompt, value }),
    setting,
    terminal(title, cwd, argv) {
      if (setting<string>('ui.terminal', 'native') !== 'browser') return nativeTerminal(title, cwd, argv);
      const id = randomUUID();
      terms.set(id, { cwd, argv, at: Date.now() });
      if (!clients.length) console.log(`Terminal requested (${title}) but no browser tab is open.`);
      ask({ op: 'terminal', id, title });
    },
    openFile: (file, opts) => openPath(file, opts?.line),
    showMarkdown: (title, markdown, source) => { ask({ op: 'markdown', title, markdown, source: !!source }); },
    openExternal: url => { if (/^https?:\/\//.test(url)) execFile(opener, [url]); },
    log: line => { if (verbose) console.log(line); },
  };
  setHost(web);

  const agents = new AgentWatcher(store);
  let push = () => {};
  const factory = new FactoryRunner(store, agents, path.join(path.dirname(boardFile), 'locks'), path.join(ROOT, 'agents'), () => push());

  const core = dashboardCore(store, agents, factory, m => { const s = JSON.stringify(m); for (const c of clients) c.send(s); },
    '/attachments', () => push(), cliProjects(store, p => openPath(p.path)));
  push = core.push;
  agents.onDidChange(push);
  // Other windows (VS Code, the CLI sync) write the same file.
  fs.watchFile(boardFile, { interval: 1000 }, () => { store.reload(); push(); });

  /* ---------- HTTP ---------- */
  const cookieOk = (req: http.IncomingMessage) => {
    const got = Buffer.from(/(?:^|;\s*)lexcode=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '');
    return got.length === secret.length && timingSafeEqual(got, Buffer.from(secret));
  };
  // Host check stops DNS rebinding; the SameSite cookie stops other sites' requests.
  const hostOk = (req: http.IncomingMessage) => origins.includes(`http://${req.headers.host}`);
  const csp = () => `default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' ${origins.map(o => o.replace('http', 'ws')).join(' ')}`;
  const file = (res: http.ServerResponse, f: string | undefined) => {
    if (!f || !fs.statSync(f, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': csp(), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  };
  const xterm = (f: string) => require.resolve(f);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!hostOk(req)) return res.writeHead(403).end();
    if (url.searchParams.get('t') === secret) {
      res.writeHead(302, { 'Set-Cookie': `lexcode=${secret}; HttpOnly; SameSite=Strict; Path=/`, Location: url.pathname });
      return res.end();
    }
    if (!cookieOk(req)) return res.writeHead(401, { 'Content-Type': 'text/plain' }).end('Open the URL printed by `lexcode ui`.');
    const p = decodeURIComponent(url.pathname);
    if (p === '/') return file(res, path.join(MEDIA, 'index.html'));
    if (p === '/term') return file(res, path.join(MEDIA, 'term.html'));
    if (p.startsWith('/media/')) return file(res, within(MEDIA, p.slice(7)));
    if (p.startsWith('/attachments/')) return file(res, within(store.attachmentsDir(), p.slice(13)));
    if (p === '/xterm/xterm.js') return file(res, xterm('@xterm/xterm/lib/xterm.js'));
    if (p === '/xterm/xterm.css') return file(res, xterm('@xterm/xterm/css/xterm.css'));
    if (p === '/xterm/addon-fit.js') return file(res, xterm('@xterm/addon-fit/lib/addon-fit.js'));
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 200 * 1024 * 1024 }); // attachments arrive base64 (25 MB each, several per new epic)
  server.on('upgrade', (req, sock, head) => {
    if (!hostOk(req) || !origins.includes(req.headers.origin ?? '') || !cookieOk(req)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, sock, head, ws => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/ws') return dashboard(ws);
      if (url.pathname === '/pty') return pty(ws, url);
      ws.close();
    });
  });

  const dashboard = (ws: WebSocket) => {
    clients.push(ws);
    ws.on('message', raw => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m?.type === 'hostReply') {
        const p = pending.get(m.reqId);
        if (p?.ws === ws) { pending.delete(m.reqId); p.resolve(typeof m.value === 'string' ? m.value : undefined); }
        return;
      }
      core.handle(m);
    });
    ws.on('close', () => {
      clients.splice(clients.indexOf(ws), 1);
      for (const [id, p] of pending) if (p.ws === ws) { pending.delete(id); p.resolve(undefined); }
    });
  };

  // Only runs what the server queued via host.terminal (story/epic-linked sessions): the browser never names a command.
  const pty = (ws: WebSocket, url: URL) => {
    const id = url.searchParams.get('id') ?? '';
    const t = terms.get(id);
    terms.delete(id);
    if (!t || Date.now() - t.at > 120_000) { ws.send('\r\nThis terminal link expired. Start it again from the dashboard.\r\n'); return ws.close(); }
    const size = (v: unknown, d: number) => Math.min(500, Math.max(10, Math.floor(Number(v)) || d));
    let p: import('node-pty').IPty;
    try {
      p = require('node-pty').spawn(t.argv[0], t.argv.slice(1), { name: 'xterm-256color', cwd: t.cwd,
        cols: size(url.searchParams.get('cols'), 100), rows: size(url.searchParams.get('rows'), 30), env: { ...process.env, TERM: 'xterm-256color' } });
    } catch (e: any) { ws.send(`\r\nCouldn't start ${t.argv[0]}: ${e.message}\r\n`); return ws.close(); }
    p.onData(d => ws.readyState === ws.OPEN && ws.send(d));
    p.onExit(() => ws.close());
    ws.on('message', raw => {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (typeof m?.d === 'string') p.write(m.d);
      else if (Array.isArray(m?.r)) p.resize(size(m.r[0], 100), size(m.r[1], 30));
    });
    ws.on('close', () => { try { p.kill(); } catch { /* exited */ } }); // a background run survives: only its attach client ends
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: any) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is in use (lexcode ui already running?). Try --port.`) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  port = (server.address() as import('net').AddressInfo).port;
  origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const link = `${origins[0]}/?t=${secret}`;
  console.log(`LexCode dashboard: ${link}\nBoard: ${boardFile}\nCtrl+C to stop.`);
  if (open) execFile(opener, [link]);
  return { port, secret, close: () => { fs.unwatchFile(boardFile); agents.dispose(); factory.dispose(); wss.close(); server.close(); } };
}
