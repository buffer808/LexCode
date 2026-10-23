import * as fs from 'fs';
import * as os from 'os';
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

// Freshest ref for `branch`: origin's copy after a fetch (offline → whatever was fetched last), else the local branch.
export async function resolveBase(repo: string, branch: string) {
  try { await git(repo, ['fetch', '--quiet', 'origin', branch]); } catch { /* no remote / offline */ }
  for (const ref of [`origin/${branch}`, branch]) {
    try { await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref; } catch { /* next */ }
  }
  throw new Error(`branch "${branch}" was not found locally or on origin`);
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

// Safe delete (`-d`): git refuses unless `branch` is merged into what `cwd` has checked out (pass the epic worktree).
export const deleteBranch = (cwd: string, branch: string) => git(cwd, ['branch', '-d', branch]);

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

export const remoteUrl = (cwd: string) => git(cwd, ['remote', 'get-url', 'origin']);

// Opens the PR and returns its URL. gh: GitHub CLI. tea: Gitea REST API with the matching `tea` login, because
// `tea pr create` can't map a remote whose host differs from the login's (e.g. ssh to a raw IP).
export async function createPr(cwd: string, via: 'gh' | 'tea', base: string, head: string, title: string, body: string) {
  if (via === 'tea') return giteaPr(await remoteUrl(cwd), base, head, title, body);
  try {
    return (await exec('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body', body], { cwd })).stdout.trim().split('\n').pop()!;
  } catch (e: any) {
    throw new Error(e.code === 'ENOENT' ? 'GitHub CLI (gh) is not installed.' : `gh pr create: ${String(e.stderr || e.message).trim()}`);
  }
}

// `ssh://git@host:2222/owner/repo.git`, `git@host:owner/repo.git`, `https://host/owner/repo` → host + owner/repo.
export function parseRemote(url: string) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && m[2].split('/').length >= 2 ? { host: m[1], slug: m[2].split('/').slice(-2).join('/') } : undefined;
}

export interface TeaLogin { name: string; url: string; token: string; sshHost?: string; default?: boolean }

// The `logins:` list of tea's config.yml (flat `key: value` entries, which is all tea writes there).
export function parseTeaLogins(yaml: string): TeaLogin[] {
  const out: TeaLogin[] = [];
  for (const block of yaml.split(/^\s*- (?=name:)/m).slice(1)) {
    const f: Record<string, string> = {};
    for (const line of block.split('\n')) {
      const kv = /^\s*(name|url|token|ssh_host|default):\s*"?(.*?)"?\s*$/.exec(line);
      if (kv && !(kv[1] in f)) f[kv[1]] = kv[2];
      if (/^\S/.test(line) && !line.startsWith('name:')) break; // next top-level key (preferences:)
    }
    if (f.url && f.token) out.push({ name: f.name, url: f.url.replace(/\/$/, ''), token: f.token, sshHost: f.ssh_host || undefined, default: f.default === 'true' });
  }
  return out;
}

// Login whose web or ssh host is the remote's host, else the default (or only) login.
export const pickTeaLogin = (logins: TeaLogin[], host: string) =>
  logins.find(l => new URL(l.url).hostname === host || l.sshHost === host) ?? logins.find(l => l.default) ?? (logins.length === 1 ? logins[0] : undefined);

function teaConfig() {
  const home = os.homedir();
  for (const f of [path.join(home, 'Library', 'Application Support', 'tea', 'config.yml'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tea', 'config.yml')]) {
    try { return fs.readFileSync(f, 'utf8'); } catch { /* next */ }
  }
  throw new Error('No tea login found. Run `tea login add` first.');
}

async function giteaPr(remote: string, base: string, head: string, title: string, body: string) {
  const r = parseRemote(remote);
  if (!r) throw new Error(`Can't read owner/repo from the origin remote (${remote}).`);
  const login = pickTeaLogin(parseTeaLogins(teaConfig()), r.host);
  if (!login) throw new Error(`No tea login matches ${r.host} and none is the default. Run \`tea login default <name>\`.`);
  // The token only ever goes to the login's own server.
  const res = await fetch(`${login.url}/api/v1/repos/${r.slug}/pulls`, { method: 'POST',
    headers: { Authorization: `token ${login.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base, head, title, body }) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.html_url) throw new Error(`Gitea (${login.name}) ${res.status}: ${json.message ?? res.statusText}`);
  return json.html_url as string;
}

// Gitignore-style globs: `*` and `?` stay within a path segment, `**` spans segments,
// and a pattern without `/` matches the file name at any depth.
export function globMatch(file: string, glob: string) {
  const re = glob.split(/(\*\*\/?|\*|\?)/).map(t =>
    t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]' : t.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${re}$`).test(glob.includes('/') ? file : path.posix.basename(file));
}
export const sensitive = (files: string[], globs: string[]) => files.filter(f => globs.some(g => globMatch(f, g)));
