import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-tui-'));
const { fit } = require('../tui') as typeof import('../tui');
const { nvimExpr } = require('../panes') as typeof import('../panes');
const { launcher } = require('../server') as typeof import('../server');

const HOSTILE = `$(touch pwned)"; ]==] ' \`id\` \n#{pane_id} \\x`;

test('fit pads, cuts with an ellipsis, and blanks control characters', () => {
  assert.strictEqual(fit('abc', 5), 'abc  ');
  assert.strictEqual(fit('abcdef', 4), 'abc…');
  assert.strictEqual(fit('a\nb', 3), 'a b');
  assert.strictEqual(fit('x', 0), '');
});

test('fit counts wide characters as two columns', () => {
  assert.strictEqual(fit('日本', 6), '日本  ');
  assert.strictEqual(fit('日本語テスト', 6), '日本… '); // 語 would land on the … column: padded instead
  assert.strictEqual(fit('🚀 go', 6), '🚀 go ');
});

test('releaseLocks deletes only the locks this owner holds', () => {
  const { tryLock, releaseLocks } = require('../factory') as typeof import('../factory');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-locks-'));
  assert.ok(tryLock(path.join(dir, 'a.lock'), 'me'));
  assert.ok(tryLock(path.join(dir, 'b.lock'), 'other'));
  releaseLocks(dir, 'me');
  assert.deepStrictEqual(fs.readdirSync(dir), ['b.lock']);
  assert.ok(tryLock(path.join(dir, 'a.lock'), 'next'), 'freed lock is taken at once');
});

test('launcher script passes story text through as one literal argument (tmux and nvim both run it)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-cwd-'));
  const file = launcher('t', cwd, ['printf', '%s', HOSTILE]);
  const out = execFileSync('sh', [file], { encoding: 'utf8' }).replace(/^\x1b\]0;t\x07/, '');
  assert.strictEqual(out, HOSTILE);
  assert.ok(!fs.existsSync(path.join(cwd, 'pwned')));
  assert.ok(!fs.existsSync(file), 'script deletes itself');
});

test('nvim --remote-expr carries only hex digits from outside', () => {
  const e = nvimExpr('/tmp/x.lua', 'open', HOSTILE, HOSTILE);
  const args = e.slice(e.lastIndexOf("', [") + 4, -2);
  assert.match(args, /^'[0-9a-f]+'(, '[0-9a-f]*')*$/);
  assert.ok(!e.includes(HOSTILE));
});

test('ideArgs adds --ide only when exactly one live IDE covers the folder and it is Neovim', () => {
  const { ideArgs } = require('../panes') as typeof import('../panes');
  const nv = { ideName: 'Neovim', workspaceFolders: ['/w/app'] }, devin = { ideName: 'Devin', workspaceFolders: ['/w'] };
  const argv = ['/bin/claude', '--resume', 's1'];
  assert.deepStrictEqual(ideArgs(argv, '/bin/claude', [nv], '/w/app/src').argv, ['/bin/claude', '--ide', '--resume', 's1']);
  assert.deepStrictEqual(ideArgs(argv, '/bin/claude', [nv, devin], '/w/app').argv, argv, 'two candidates: Claude could pick Devin');
  assert.deepStrictEqual(ideArgs(argv, '/bin/claude', [devin], '/w/app').argv, argv);
  assert.deepStrictEqual(ideArgs(['/bin/claude', 'attach', 'x'], '/bin/claude', [nv], '/w/app').argv, ['/bin/claude', 'attach', 'x']);
  assert.deepStrictEqual(ideArgs(['zsh'], '/bin/claude', [nv], '/w/app').argv, ['zsh']);
  const other = ideArgs(argv, '/bin/claude', [nv], '/w/application');
  assert.deepStrictEqual(other.argv, argv);
  assert.match(other.hint ?? '', /:cd \/w\/application/);
});

test('slash commands: parse splits args, @refs and --flags; complete and pick prefer prefixes', () => {
  const { parse, complete, pick } = require('../commands') as typeof import('../commands');
  assert.deepStrictEqual(parse('/Move review @log --new'), { name: 'move', args: ['review'], refs: ['log'], flags: ['new'] });
  assert.deepStrictEqual(complete('/a', 'tasks').map(c => c.name).slice(0, 3), ['attach', 'add-project', 'tasks']);
  assert.ok(!complete('/', 'tasks').some(c => c.name === 'approve'), 'epics-only commands stay out of the tasks view');
  const names = ['Dialog fix', 'Fix login redirect', 'Login page'];
  assert.strictEqual(pick(names, n => n, 'pag'), 'Login page');
  assert.strictEqual(pick(names, n => n, 'redir'), 'Fix login redirect');
});

test('render line and box keep every row at the given width', () => {
  const { line, box, width } = require('../render') as typeof import('../render');
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  assert.strictEqual(plain(line([['> ', '33'], ['日本語 text']], 8)), '> 日本… ');
  for (const r of box([[['a']], [['much too long for the box']]], 12, '2', 'esc')) assert.strictEqual(width(plain(r)), 12);
});
