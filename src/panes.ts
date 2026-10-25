// Where Claude opens next to the board: one pane on the right (tmux split or Neovim window), other cards parked.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import { HOME } from './config';

/* ---------- the right-hand pane ---------- */
// key: which card the pane belongs to (story id, or a hash of the command for anything else).
// make: writes the launcher script; only called when a new pane is actually started.
export interface Pane {
  show(key: string): boolean;                  // bring an existing pane for key to the right; false = none
  open(key: string, label: string, make: () => string): void;
  edit?(file: string, line?: number): void;   // absent: $EDITOR in the pane
  focus(): void;
  state(): { open?: string; parked: string[] };
  // Short-lived overlay (editor for long text, plan pager); Claude panes stay as they are.
  // edit: Neovim edits file in a floating window instead of running the script. done is written when it closes
  // (tmux/inline: the script itself writes it), so callers wait on that file whatever the backend.
  popup(make: () => string, edit?: { file: string; done: string }): void;
}

export function tmuxPane(self: string): Pane {
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
    popup(make, edit) {
      // Older tmux takes one shell-command string here, so the script path (from mkdtemp) is single-quoted.
      const script = make();
      execFile('tmux', ['display-popup', '-E', '-w', '90%', '-h', '85%', `sh '${script.replace(/'/g, `'\\''`)}'`], err => {
        if (!err) return;
        // e.g. tmux < 3.2 or no attached client: the script never ran, so clean up and don't leave the caller waiting.
        fs.rm(path.dirname(script), { recursive: true, force: true }, () => {});
        if (edit) fs.writeFile(edit.done, '', () => {});
      });
    },
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
  if op == 'float' then
    local w, h = math.floor(vim.o.columns * 0.85), math.floor(vim.o.lines * 0.8)
    local buf = vim.fn.bufadd(key)
    vim.fn.bufload(buf)
    local win = api.nvim_open_win(buf, true, { relative = 'editor', width = w, height = h, border = 'rounded',
      row = math.floor((vim.o.lines - h) / 2), col = math.floor((vim.o.columns - w) / 2), title = ' LexCode: :wq sends, :q! cancels ' })
    api.nvim_create_autocmd('WinClosed', { pattern = tostring(win), once = true, callback = function()
      vim.fn.writefile({}, script)
      vim.schedule(function() pcall(api.nvim_buf_delete, buf, { force = true }) end)
    end })
    vim.schedule(function() vim.cmd('stopinsert') end)
    return 1
  end
  if op == 'term' then
    vim.cmd('tabnew')
    if vim.fn.has('nvim-0.11') == 1 then vim.fn.jobstart({ 'sh', script }, { term = true })
    else vim.fn.termopen({ 'sh', script }) end
    vim.cmd('startinsert')
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

export function nvimPane(server: string): Pane {
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
    popup(make, edit) { if (edit) call('float', edit.file, edit.done); else call('term', '', make()); },
    state() { refresh(); return cached; },
  };
}

/* ---------- claudecode.nvim: Claude's edits as Neovim diffs ---------- */
// The plugin writes ~/.claude/ide/<port>.lock like the VS Code-family extensions do; `claude --ide` connects to the one
// IDE whose workspace covers its folder. Only add --ide when that is unambiguously a Neovim, else Claude might pick
// (or refuse between) other open editors. Never for `claude attach`, which joins a running session.
export interface IdeLock { pid?: number; ideName?: string; workspaceFolders?: string[] }
export function ideArgs(argv: string[], bin: string, locks: IdeLock[], cwd: string): { argv: string[]; hint?: string } {
  if (argv[0] !== bin || argv[1] === 'attach' || argv.includes('--ide')) return { argv };
  const covers = (l: IdeLock) => (l.workspaceFolders ?? []).some(f => cwd === f || cwd.startsWith(f + path.sep));
  const nvim = locks.filter(l => l.ideName === 'Neovim');
  const hits = locks.filter(covers);
  if (hits.length === 1 && hits[0].ideName === 'Neovim') return { argv: [argv[0], '--ide', ...argv.slice(1)] };
  if (nvim.length && !nvim.some(covers)) return { argv, hint: `claudecode.nvim is open on another folder: :cd ${cwd} for diffs in Neovim` };
  return { argv };
}

// Live lock files only: a crashed editor leaves its file behind.
export function ideLocks(): IdeLock[] {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'ide');
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.lock')); } catch { return []; }
  return files.flatMap(f => {
    try {
      const l: IdeLock = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (l.pid) process.kill(l.pid, 0); // throws when the process is gone
      return [l];
    } catch { return []; }
  });
}

// No multiplexer: hand the terminal to Claude until it exits.
export function inlinePane(suspend: () => void, resume: () => void): Pane {
  return {
    show: () => false,
    open(_key, _label, make) {
      suspend();
      spawn('sh', [make()], { stdio: 'inherit' }).on('exit', resume).on('error', resume);
    },
    focus() {},
    state: () => ({ parked: [] }),
    popup(make) { this.open('', '', make); },
  };
}
