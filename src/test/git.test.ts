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
  // Merged sprint branch: deleted from the epic worktree. An unmerged branch is refused (no work lost).
  sh(r, 'branch', 'lexcode/s2', 'main');
  sh(r, 'checkout', '-q', 'lexcode/s2'); write(r, 'b.txt', 'b\n'); commit(r, 'unmerged'); sh(r, 'checkout', '-q', 'main');
  await assert.rejects(git.deleteBranch(epicWt, 'lexcode/s2'), /not fully merged/);
  await git.deleteBranch(epicWt, 'lexcode/s1');
  assert.ok(!await git.branchExists(r, 'lexcode/s1') && await git.branchExists(r, 'lexcode/s2'));
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

test('resolveBase: origin copy of the target after a fetch, else the local branch', async () => {
  const origin = repo();
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-git-')));
  sh(r, 'clone', '-q', origin, '.');
  sh(r, 'checkout', '-qb', 'feature');
  write(origin, 'b.txt', 'new upstream work\n');
  commit(origin, 'upstream');
  assert.equal(await git.resolveBase(r, 'main'), 'origin/main');
  assert.equal(sh(r, 'rev-parse', 'origin/main'), sh(origin, 'rev-parse', 'main')); // fetched, not stale
  assert.equal(await git.resolveBase(origin, 'main'), 'main');                         // no remote
  await assert.rejects(git.resolveBase(r, 'nope'), /"nope" was not found/);
});

test('Gitea PR target: remote → host + slug, tea login picked by host, else default', () => {
  assert.deepEqual(git.parseRemote('ssh://git@134.209.105.104:2222/eLibromo/elibromo.git'), { host: '134.209.105.104', slug: 'eLibromo/elibromo' });
  assert.deepEqual(git.parseRemote('git@github.com:me/app.git'), { host: 'github.com', slug: 'me/app' });
  assert.deepEqual(git.parseRemote('https://gitea.example.com/org/repo/'), { host: 'gitea.example.com', slug: 'org/repo' });
  assert.equal(git.parseRemote('/local/path'), undefined);

  const logins = git.parseTeaLogins(`logins:
    - name: work
      url: https://gitea.work.com/
      token: t1
      default: false
      ssh_host: git.work.com
    - name: home
      url: https://gitea.home.com
      token: t2
      default: true
preferences:
    editor: false
`);
  assert.deepEqual(logins.map(l => [l.name, l.url, l.token, l.sshHost, l.default]),
    [['work', 'https://gitea.work.com', 't1', 'git.work.com', false], ['home', 'https://gitea.home.com', 't2', undefined, true]]);
  assert.equal(git.pickTeaLogin(logins, 'git.work.com')?.name, 'work');      // ssh host
  assert.equal(git.pickTeaLogin(logins, 'gitea.work.com')?.name, 'work');    // web host
  assert.equal(git.pickTeaLogin(logins, '134.209.105.104')?.name, 'home');   // raw IP → default login
  assert.equal(git.pickTeaLogin(logins.slice(0, 1), '10.0.0.1')?.name, 'work'); // only login
  assert.equal(git.pickTeaLogin([], 'x'), undefined);
});
