// Paths and settings for the CLI apps. No ws/node-pty here: the extension's bundled cli.js runs `sync` and `epic new`
// without node_modules.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const HOME = path.join(os.homedir(), '.lexcode');

// Settings use the VS Code names ("lexCode.claudePath", "lexCode.factory.models", ...) so they can be copied over.
export function setting<T>(key: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'settings.json'), 'utf8'))[`lexCode.${key}`] ?? fallback; }
  catch { return fallback; }
}

// $LEXCODE_BOARD, else the newest VS Code-family globalStorage copy, else ~/.lexcode/board.json.
export function boardFile(): string {
  if (process.env.LEXCODE_BOARD) return process.env.LEXCODE_BOARD;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const hits = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium', 'Devin']
    .map(app => path.join(base, app, 'User', 'globalStorage', 'lex.lex-code', 'board.json'))
    .filter(f => fs.existsSync(f));
  if (!hits.length) return path.join(HOME, 'board.json'); // no IDE: standalone board
  return hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
