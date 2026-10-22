// Headless TASKS.md -> board sync, for Claude skills and scripts:
//   node out/cli.js sync [projectPath] [--dry-run]
// Board file: $LEXCODE_BOARD, else the first existing VS Code-family globalStorage copy.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from './store';
import { syncFrom, syncSource, syncSourceOf } from './importer';

function boardFile(): string {
  if (process.env.LEXCODE_BOARD) return process.env.LEXCODE_BOARD;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const hits = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Devin']
    .map(app => path.join(base, app, 'User', 'globalStorage', 'lex.lex-code', 'board.json'))
    .filter(f => fs.existsSync(f));
  if (!hits.length) throw new Error('LexCode board.json not found; set LEXCODE_BOARD');
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'sync') throw new Error('usage: lexcode sync [projectPath] [--dry-run]');
  const dryRun = rest.includes('--dry-run');
  const dir = path.resolve(rest.find(a => !a.startsWith('--')) ?? process.cwd());
  const file = boardFile();
  // Same write-back as the extension: status changes tick the source checkbox.
  const store = new Store(file, s => { if (s.source) syncSource(s); });
  // Deepest registered project containing dir.
  const p = store.all().projects
    .filter(p => dir === p.path || dir.startsWith(p.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!p) throw new Error(`${dir} is not a LexCode project (board: ${file})`);
  const src = syncSourceOf(p.path);
  if (!src) throw new Error(`No TASKS.md in ${p.path}`);
  const r = syncFrom(store, p.id, src.parsed, dryRun);
  console.log(`${dryRun ? '[dry run] ' : ''}${p.name}: ${path.relative(p.path, src.file)} -> ${file}`);
  for (const [k, xs] of Object.entries(r)) for (const x of xs) console.log(`${k}\t${x}`);
  if (!r.added.length && !r.updated.length && !r.archived.length) console.log('in sync');
}

try { main(process.argv.slice(2)); } catch (e: any) { console.error(e.message); process.exit(1); }
