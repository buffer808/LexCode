// A program (Claude) running inside LexCode's own screen: node-pty runs it, @xterm/headless keeps its screen,
// and `lines()` hands that screen back as styled lines to draw in a box (the modal, or the right half in split view).
import * as pty from 'node-pty';
import { Terminal, IBufferCell as Cell } from '@xterm/headless';
import { Pane } from './panes';

export class Embedded {
  private p: pty.IPty;
  private t: Terminal;
  private cursorOn = true;
  exited = false;

  constructor(argv: string[], cwd: string, public cols: number, public rows: number, changed: () => void, exit: () => void) {
    this.t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    // DECTCEM (show/hide cursor) isn't in term.modes, so watch for it.
    for (const final of ['h', 'l']) this.t.parser.registerCsiHandler({ prefix: '?', final }, ps => {
      if (ps.includes(25)) this.cursorOn = final === 'h';
      return false; // let xterm handle the rest
    });
    this.p = pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string> });
    this.p.onData(d => this.t.write(d, changed));
    this.p.onExit(() => { this.exited = true; exit(); });
  }

  // Keys from our terminal, as raw bytes. Our terminal always sends normal-mode arrows and bracketed pastes;
  // translate to what the program asked for.
  write(data: string) {
    if (this.exited) return;
    if (this.t.modes.applicationCursorKeysMode) data = data.replace(/\x1b\[([ABCDHF])/g, '\x1bO$1');
    if (!this.t.modes.bracketedPasteMode) data = data.replace(/\x1b\[20[01]~/g, '');
    this.p.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.t.resize(cols, rows);
    if (!this.exited) this.p.resize(cols, rows);
  }

  kill() { if (!this.exited) this.p.kill(); }

  // The visible screen as `rows` strings of exactly `cols` columns, with SGR styling and the cursor drawn in.
  lines(showCursor = true): string[] {
    const b = this.t.buffer.active, cell = b.getNullCell(), out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const row = b.getLine(b.viewportY + y);
      let s = '', style = '';
      for (let x = 0; x < this.cols; x++) {
        row?.getCell(x, cell);
        if (row && cell.getWidth() === 0) continue; // right half of a wide character
        const cur = showCursor && this.cursorOn && y === b.cursorY && x === b.cursorX;
        const st = row ? sgrOf(cell, cur) : cur ? '7' : '';
        if (st !== style) { s += `\x1b[0${st ? `;${st}` : ''}m`; style = st; }
        s += (row && cell.getChars()) || ' ';
      }
      out.push(s + '\x1b[0m');
    }
    return out;
  }
}

function color(mode: 'fg' | 'bg', c: Cell): string {
  const fg = mode === 'fg';
  if (fg ? c.isFgDefault() : c.isBgDefault()) return '';
  const n = fg ? c.getFgColor() : c.getBgColor();
  if (fg ? c.isFgRGB() : c.isBgRGB()) return `${fg ? 38 : 48};2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  return `${fg ? 38 : 48};5;${n}`;
}
function sgrOf(c: Cell, cursor: boolean): string {
  const a: string[] = [];
  if (c.isBold()) a.push('1');
  if (c.isDim()) a.push('2');
  if (c.isItalic()) a.push('3');
  if (c.isUnderline()) a.push('4');
  if (!!c.isInverse() !== cursor) a.push('7');
  if (c.isStrikethrough()) a.push('9');
  const fg = color('fg', c), bg = color('bg', c);
  if (fg) a.push(fg);
  if (bg) a.push(bg);
  return a.join(';');
}

/* ---------- as a Pane: one shown at a time, the others keep running hidden (parked) ---------- */
export interface Shown { key: string; label: string; e: Embedded }
// size: inner box size for a new program. changed: its screen changed or it exited; shown = one was just brought up.
export function modalPane(size: () => [number, number], changed: (shown?: boolean) => void) {
  const all = new Map<string, Shown>();
  let cur: string | undefined, n = 0;
  const start = (key: string, label: string, script: string) => {
    const [c, r] = size();
    const e = new Embedded(['sh', script], process.cwd(), c, r, () => changed(), () => { all.delete(key); if (cur === key) cur = undefined; changed(); });
    all.set(key, { key, label, e });
    cur = key;
    changed(true);
  };
  const pane: Pane & { shown(): Shown | undefined; hide(): void; running(): Shown[] } = {
    show(key) { if (!all.has(key)) return false; cur = key; changed(true); return true; },
    open(key, label, make) { if (!pane.show(key)) start(key, label, make()); },
    popup(make) { start(`popup:${++n}`, 'LexCode', make()); }, // editor / pager: closes itself when it exits
    focus() { if (!cur && all.size) pane.show([...all.keys()].pop()!); },
    state: () => ({ open: cur, parked: [...all.keys()].filter(k => k !== cur) }),
    shown: () => cur ? all.get(cur) : undefined,
    hide() { cur = undefined; changed(); },
    running: () => [...all.values()],
  };
  return pane;
}
