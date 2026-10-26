// Claude Code style drawing on the normal screen: printed lines go to scrollback once; the live area under them
// (list, prompt, status line) is redrawn in place.

// Terminal columns for one code point: East Asian wide/fullwidth and emoji take 2, combining marks and ZWJ 0.
// ponytail: range check, not full Unicode width tables; rare scripts may be off by one.
const cols = (c: string) => {
  const n = c.codePointAt(0)!;
  if (/[̀-ͯ​-‏︀-️]/.test(c)) return 0;
  return (n >= 0x1100 && n <= 0x115f) || (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) || (n >= 0xf900 && n <= 0xfaff)
    || (n >= 0xfe30 && n <= 0xfe4f) || (n >= 0xff00 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6)
    || (n >= 0x1f300 && n <= 0x1faff) || (n >= 0x20000 && n <= 0x3fffd) ? 2 : 1;
};
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ');
export const width = (s: string) => Array.from(clean(s)).reduce((n, c) => n + cols(c), 0);
// Padded/cut to exactly w columns; control characters become spaces.
export function fit(s: string, w: number) {
  if (w <= 0) return '';
  const cs = Array.from(clean(s));
  const total = cs.reduce((n, c) => n + cols(c), 0);
  if (total <= w) return cs.join('') + ' '.repeat(w - total);
  let r = '', used = 0;
  for (const c of cs) { if (used + cols(c) > w - 1) break; r += c; used += cols(c); }
  return r + '…' + ' '.repeat(w - 1 - used); // pad when a wide char didn't fit before the …
}
export const sgr = (code: string, s: string) => code ? `\x1b[${code}m${s}\x1b[0m` : s;

export const ORANGE = '38;5;173', DIM = '2', GREEN = '32', YELLOW = '33', RED = '31', BLUE = '34', BOLD = '1';

// One styled line: [text, sgr] segments, cut and padded to w columns as a whole.
export type Seg = [string, string?];
export function line(segs: Seg[], w: number) {
  let r = '', used = 0;
  for (const [t, st] of segs) {
    const n = width(t);
    if (used + n > w) { r += sgr(st ?? '', fit(t, w - used)); return r; }
    r += sgr(st ?? '', clean(t)); used += n;
  }
  return r + ' '.repeat(w - used);
}

// Rounded box w columns wide around rows of segments (or ready-styled strings exactly w - 4 wide);
// title sits on the top border, footer on the bottom one.
export function box(rows: (Seg[] | string)[], w: number, color = DIM, footer = '', title: Seg[] = []) {
  const inner = Math.max(1, w - 4), side = sgr(color, '│');
  const bottom = footer ? `─ ${footer} ` : '';
  const tw = Math.min(width(title.map(t => t[0]).join('')), Math.max(0, w - 6));
  const top = tw ? sgr(color, '╭─ ') + line(title, tw) + sgr(color, ` ${'─'.repeat(Math.max(0, w - 5 - tw))}╮`) : sgr(color, `╭${'─'.repeat(w - 2)}╮`);
  return [top,
    ...rows.map(r => `${side} ${typeof r === 'string' ? r : line(r, inner)} ${side}`),
    sgr(color, `╰${bottom}${'─'.repeat(Math.max(0, w - 2 - width(bottom)))}╯`)];
}

export const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

export class Live {
  private height = 0; // rows the live area takes; the cursor rests on its last row
  private frame: string[] = [];
  constructor(private out: NodeJS.WriteStream) {}
  private clear() {
    if (!this.height) return '\r';
    return `\r${this.height > 1 ? `\x1b[${this.height - 1}A` : ''}\x1b[J`;
  }
  // Into scrollback above the live area; lines may wrap.
  print(lines: string[]) {
    this.out.write(this.clear() + lines.map(l => `${l}\x1b[0m\r\n`).join(''));
    this.height = 0;
    this.draw(this.frame);
  }
  // Lines must fit the width (no wrapping), and there must be fewer of them than terminal rows.
  draw(lines: string[]) {
    this.frame = lines;
    this.out.write(this.clear() + lines.join('\r\n'));
    this.height = lines.length;
  }
  // After a resize the old frame has re-wrapped, so its height is unknown: wipe the visible screen.
  reset() { this.out.write('\x1b[2J\x1b[H'); this.height = 0; }
  // Program took over the terminal (or we quit): leave what's there, start a new frame below.
  detach(keep = false) { this.out.write(keep ? '\r\n' : this.clear()); this.height = 0; }
}
