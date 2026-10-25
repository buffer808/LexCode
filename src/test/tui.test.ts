import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-tui-'));
const { fit } = require('../tui') as typeof import('../tui');
const { launcher } = require('../server') as typeof import('../server');

const HOSTILE = `$(touch pwned)"; ' \`id\` \n#{pane_id} \\x`;

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

test('launcher script passes story text through as one literal argument', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-cwd-'));
  const file = launcher('t', cwd, ['printf', '%s', HOSTILE]);
  const out = execFileSync('sh', [file], { encoding: 'utf8' }).replace(/^\x1b\]0;t\x07/, '');
  assert.strictEqual(out, HOSTILE);
  assert.ok(!fs.existsSync(path.join(cwd, 'pwned')));
  assert.ok(!fs.existsSync(file), 'script deletes itself');
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

test('Embedded keeps a program\'s screen: styled lines of exactly cols columns, and it reports exit', async () => {
  const { Embedded } = require('../modal') as typeof import('../modal');
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  await new Promise<void>((resolve, reject) => {
    const e = new Embedded(['sh', '-c', `printf '\\033[31mred\\033[0m 日本 %s' "$(tput cols)"`], os.tmpdir(), 20, 3, () => {}, () => {
      setTimeout(() => {
        try {
          const ls = e.lines(false);
          assert.strictEqual(ls.length, 3);
          assert.strictEqual(plain(ls[0]), 'red 日本 20         ');
          assert.match(ls[0], /\x1b\[0;38;5;1mred/);
          assert.ok(e.exited);
          resolve();
        } catch (err) { reject(err); }
      }, 50);
    });
  });
});
