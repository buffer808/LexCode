import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// Thin git/gh wrappers for the factory. Never touches the user's main checkout's HEAD:
// epic and sprint branches are worked on in worktrees under <project>/.lexcode/worktrees/.

const exec = promisify(execFile);
const MAX = 64 * 1024 * 1024; // diffs can be big

async function git(cwd: string, args: string[]) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: MAX })).stdout.trim();
  } catch (e: any) {
    throw new Error(`git ${args[0]}: ${String(e.stderr || e.message).trim()}`);
  }
}

export const worktreeRoot = (repo: string) => path.join(repo, '.lexcode', 'worktrees');

export const currentBranch = (cwd: string) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const headCommit = (cwd: string) => git(cwd, ['rev-parse', 'HEAD']);

export async function branchExists(cwd: string, name: string) {
  try { await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; } catch { return false; }
}

// Creates `name` at `from` unless it already exists (no checkout).
export async function ensureBranch(cwd: string, name: string, from: string) {
  if (!await branchExists(cwd, name)) await git(cwd, ['branch', name, from]);
}

// Keeps .lexcode/ (worktrees, plans) out of `git status` without touching the tracked .gitignore.
export async function excludeLexcode(repo: string) {
  const common = path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir']));
  const file = path.join(common, 'info', 'exclude');
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur.split('\n').includes('/.lexcode/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}/.lexcode/\n`);
}

// Checks out `branch` at `dir`, creating the branch from `from` if needed. Reuses an existing worktree.
export async function addWorktree(repo: string, dir: string, branch: string, from: string) {
  await excludeLexcode(repo);
  if (fs.existsSync(path.join(dir, '.git'))) return;
  await git(repo, await branchExists(repo, branch) ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, from]);
}

// Only ever touches this one worktree (works even if its folder is already gone). No `git worktree prune`:
// that would also drop the user's own worktrees whose folders are temporarily missing (e.g. unmounted drive).
export async function removeWorktree(repo: string, dir: string) {
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.join(real(path.dirname(p)), path.basename(p)); } };
  const registered = (await git(repo, ['worktree', 'list', '--porcelain'])).split('\n').some(l => l === `worktree ${real(dir)}`);
  if (registered) await git(repo, ['worktree', 'remove', '--force', dir]);
  else fs.rmSync(dir, { recursive: true, force: true });
}

// Changes on `head` since it forked from `base` (merge-base diff, like a PR view).
export const diff = (cwd: string, base: string, head: string) => git(cwd, ['diff', `${base}...${head}`]);
export const changedFiles = async (cwd: string, base: string, head: string) =>
  (await git(cwd, ['diff', '--name-only', `${base}...${head}`])).split('\n').filter(Boolean);

export type MergeResult = { conflict: false } | { conflict: true; files: string[] };

// Merges `branch` into whatever `cwd` has checked out (the epic worktree). Conflicts are aborted, never left behind.
export async function merge(cwd: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await git(cwd, ['merge', '--no-ff', '--no-commit', branch]);
  } catch (e) {
    const files = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    if (!files.length) throw e; // failed for another reason (dirty tree, unknown branch)
    await git(cwd, ['merge', '--abort']);
    return { conflict: true, files };
  }
  try { await git(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']); } catch { return { conflict: false }; } // already up to date
  await git(cwd, ['commit', '-m', message]);
  return { conflict: false };
}

export const push = (cwd: string, branch: string) => git(cwd, ['push', '-u', 'origin', branch]);

// Returns the PR URL printed by gh.
export async function createPr(cwd: string, base: string, head: string, title: string, body: string) {
  try {
    return (await exec('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd })).stdout.trim();
  } catch (e: any) {
    throw new Error(`gh pr create: ${String(e.stderr || e.message).trim()}`);
  }
}

// Gitignore-style globs: `*` and `?` stay within a path segment, `**` spans segments,
// and a pattern without `/` matches the file name at any depth.
export function globMatch(file: string, glob: string) {
  const re = glob.split(/(\*\*\/?|\*|\?)/).map(t =>
    t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${re}$`).test(glob.includes('/') ? file : path.posix.basename(file));
}
export const sensitive = (files: string[], globs: string[]) => files.filter(f => globs.some(g => globMatch(f, g)));
