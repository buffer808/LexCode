import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as git from '../git';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};
const commit = (dir: string, msg: string) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', msg); };

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-git-')));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't');
  write(dir, 'a.txt', 'one\n');
  commit(dir, 'init');
  return dir;
}

test('epic + sprint worktrees, clean merge, main checkout untouched', async () => {
  const r = repo();
  const root = git.worktreeRoot(r);
  const epicWt = path.join(root, 'epic'), sprintWt = path.join(root, 's1');
  await git.ensureBranch(r, 'lexcode/epic', 'main');
  await git.ensureBranch(r, 'lexcode/epic', 'main'); // idempotent
  await git.addWorktree(r, epicWt, 'lexcode/epic', 'main');
  await git.addWorktree(r, sprintWt, 'lexcode/s1', 'lexcode/epic');
  await git.addWorktree(r, sprintWt, 'lexcode/s1', 'lexcode/epic'); // reuse existing
  assert.equal(await git.currentBranch(sprintWt), 'lexcode/s1');
  assert.equal(sh(r, 'status', '--porcelain'), ''); // .lexcode/ excluded
  assert.equal(fs.readFileSync(path.join(r, '.git', 'info', 'exclude'), 'utf8').match(/\/\.lexcode\//g)?.length, 1);

  const base = await git.headCommit(sprintWt);
  write(sprintWt, 'src/auth/login.ts', 'x\n');
  commit(sprintWt, 'story(1): login');
  assert.deepEqual(await git.changedFiles(sprintWt, base, 'HEAD'), ['src/auth/login.ts']);
  assert.match(await git.diff(sprintWt, 'lexcode/epic', 'lexcode/s1'), /\+x/);

  assert.deepEqual(await git.merge(epicWt, 'lexcode/s1', 'Merge sprint S1'), { conflict: false });
  assert.ok(fs.existsSync(path.join(epicWt, 'src/auth/login.ts')));
  assert.equal(sh(epicWt, 'log', '-1', '--format=%s'), 'Merge sprint S1');
  assert.deepEqual(await git.merge(epicWt, 'lexcode/s1', 'again'), { conflict: false }); // already up to date

  assert.equal(await git.currentBranch(r), 'main');
  assert.ok(!fs.existsSync(path.join(r, 'src')));

  // A user worktree with a missing folder must survive our cleanup (no global prune).
  const mine = path.join(path.dirname(r), path.basename(r) + '-user-wt');
  sh(r, 'worktree', 'add', '-q', mine, '-b', 'user');
  fs.rmSync(mine, { recursive: true });
  await git.removeWorktree(r, sprintWt);
  assert.ok(!fs.existsSync(sprintWt));
  const list = sh(r, 'worktree', 'list', '--porcelain');
  assert.ok(!list.includes(sprintWt) && list.includes(mine));
  // Folder already gone: still unregisters just that worktree.
  fs.rmSync(epicWt, { recursive: true });
  await git.removeWorktree(r, epicWt);
  assert.ok(!sh(r, 'worktree', 'list', '--porcelain').includes(epicWt));
  await git.removeWorktree(r, path.join(root, 'never-existed')); // no-op
});

test('conflicting merge is detected and aborted', async () => {
  const r = repo();
  const root = git.worktreeRoot(r);
  const epicWt = path.join(root, 'epic'), s1 = path.join(root, 's1'), s2 = path.join(root, 's2');
  await git.addWorktree(r, epicWt, 'lexcode/epic', 'main');
  await git.addWorktree(r, s1, 'lexcode/s1', 'lexcode/epic');
  await git.addWorktree(r, s2, 'lexcode/s2', 'lexcode/epic');
  write(s1, 'a.txt', 'from s1\n'); commit(s1, 's1');
  write(s2, 'a.txt', 'from s2\n'); commit(s2, 's2');

  assert.deepEqual(await git.merge(epicWt, 'lexcode/s1', 'm1'), { conflict: false });
  assert.deepEqual(await git.merge(epicWt, 'lexcode/s2', 'm2'), { conflict: true, files: ['a.txt'] });
  assert.equal(sh(epicWt, 'status', '--porcelain'), ''); // nothing left half-merged
  assert.equal(fs.readFileSync(path.join(epicWt, 'a.txt'), 'utf8'), 'from s1\n');
  await assert.rejects(git.merge(epicWt, 'nope', 'm'), /git merge/);
});

test('globMatch / sensitive', () => {
  const globs = ['**/auth/**', '**/migrations/**', '.github/**', 'package.json', '*lock*', '**/*.env*', 'Dockerfile'];
  assert.deepEqual(git.sensitive([
    'src/auth/login.ts', 'auth/x.ts', 'db/migrations/001.sql', '.github/workflows/ci.yml', 'package.json',
    'web/package.json', 'package-lock.json', 'config/.env.local', 'Dockerfile',
    'src/author.ts', 'src/app.ts', 'github/x.yml', 'docs/Dockerfile.md',
  ], globs), [
    'src/auth/login.ts', 'auth/x.ts', 'db/migrations/001.sql', '.github/workflows/ci.yml', 'package.json',
    'web/package.json', 'package-lock.json', 'config/.env.local', 'Dockerfile',
  ]);
  assert.ok(git.globMatch('src/a.ts', 'src/*.ts') && !git.globMatch('src/x/a.ts', 'src/*.ts'));
  assert.ok(git.globMatch('a1.ts', 'a?.ts') && !git.globMatch('a.b+c', 'a.b?c+'));
});
