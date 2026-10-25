import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-tui-'));
const { fit, nvimExpr } = require('../tui') as typeof import('../tui');
const { launcher } = require('../server') as typeof import('../server');

const HOSTILE = `$(touch pwned)"; ]==] ' \`id\` \n#{pane_id} \\x`;

test('fit pads, cuts with an ellipsis, and blanks control characters', () => {
  assert.strictEqual(fit('abc', 5), 'abc  ');
  assert.strictEqual(fit('abcdef', 4), 'abc…');
  assert.strictEqual(fit('a\nb', 3), 'a b');
  assert.strictEqual(fit('x', 0), '');
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
