import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Role } from './store';

// Claude Code subagents (.claude/agents/*.md) a project already has. The factory runs the one mapped
// to each role as the session's main agent (`claude --agent <name>`) and offers the rest as collaborators.

export interface AgentDef { name: string; description: string; model?: string; tools?: string; scope: 'project' | 'user'; file: string }

export const ROLES: Role[] = ['orchestrator', 'revalidator', 'security', 'builder', 'reviewer'];

// Matched against name tokens (split on - _ space). Checked in this order, so "qa-engineer" is a reviewer.
const KEYWORDS: [Role, string[]][] = [
  ['orchestrator', ['orchestrat', 'planner', 'architect', 'lead']],
  ['revalidator', ['revalidat', 'validat', 'analys']],
  ['security', ['secur', 'audit']],
  ['reviewer', ['review', 'qa']],
  ['builder', ['build', 'implement', 'develop', 'engineer', 'coder']],
];

// Flat `key: value` frontmatter only; that's all Claude Code agent files use for these fields.
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readDir(dir: string, scope: AgentDef['scope']): AgentDef[] {
  let files: string[];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  return files.flatMap(f => {
    const file = path.join(dir, f);
    const fm = frontmatter(fs.readFileSync(file, 'utf8'));
    const name = fm.name || f.slice(0, -3);
    return [{ name, description: fm.description ?? '', model: fm.model || undefined, tools: fm.tools || undefined, scope, file }];
  });
}

// Project agents shadow user agents of the same name (same precedence as Claude Code).
export function discoverAgents(projectPath: string, home = os.homedir()): AgentDef[] {
  const project = readDir(path.join(projectPath, '.claude', 'agents'), 'project');
  const names = new Set(project.map(a => a.name));
  return [...project, ...readDir(path.join(home, '.claude', 'agents'), 'user').filter(a => !names.has(a.name))];
}

// .lexcode/factory.json: { "roles": { "orchestrator": "tech-lead", ... } } for agents whose names don't say their role.
export function factoryConfig(projectPath: string): { roles: Partial<Record<Role, string>> } {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(path.join(projectPath, '.lexcode', 'factory.json'), 'utf8')); } catch (e: any) {
    if (e.code === 'ENOENT') return { roles: {} };
    throw new Error(`.lexcode/factory.json: ${e.message}`);
  }
  const roles: Partial<Record<Role, string>> = {};
  for (const [k, v] of Object.entries(raw?.roles ?? {})) {
    if (ROLES.includes(k as Role) && typeof v === 'string' && v) roles[k as Role] = v;
  }
  return { roles };
}

// role → agent name. Explicit config wins (if that agent exists), then name keywords; project agents before user agents.
// Roles left unmapped fall back to LexCode's bundled prompts.
export function mapRoles(agents: AgentDef[], explicit: Partial<Record<Role, string>> = {}): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const r of ROLES) if (explicit[r] && agents.some(a => a.name === explicit[r])) out[r] = explicit[r];
  const taken = new Set(Object.values(out));
  for (const a of agents) {
    if (taken.has(a.name)) continue;
    const tokens = a.name.toLowerCase().split(/[-_\s]+/);
    const role = KEYWORDS.find(([r, kws]) => !out[r] && tokens.some(t => kws.some(k => t.startsWith(k))))?.[0];
    if (role) { out[role] = a.name; taken.add(a.name); }
  }
  return out;
}

export function resolveRoles(projectPath: string, home?: string) {
  const agents = discoverAgents(projectPath, home);
  return { agents, roles: mapRoles(agents, factoryConfig(projectPath).roles) };
}

// LexCode's own role prompt, used when no project agent is mapped. `bundled` = extension's agents/ folder.
export const bundledRolePrompt = (bundled: string, role: Role) =>
  fs.readFileSync(path.join(bundled, `${role}.md`), 'utf8').replace(/^---[\s\S]*?---\s*/, '');

// A git worktree only has committed files. Project agents/settings that aren't committed are passed on the
// command line instead of copied in, so a builder's `git add -A` can never commit them.
export function worktreeArgs(projectPath: string, worktree: string): string[] {
  const have = new Set(readDir(path.join(worktree, '.claude', 'agents'), 'project').map(a => a.name));
  const missing = readDir(path.join(projectPath, '.claude', 'agents'), 'project').filter(a => !have.has(a.name));
  const out: string[] = [];
  if (missing.length) {
    out.push('--agents', JSON.stringify(Object.fromEntries(missing.map(a => {
      const body = fs.readFileSync(a.file, 'utf8').replace(/^---[\s\S]*?---\s*/, '');
      return [a.name, { description: a.description, prompt: body,
        ...(a.tools && { tools: a.tools.split(',').map(t => t.trim()).filter(Boolean) }), ...(a.model && { model: a.model }) }];
    }))));
  }
  // ponytail: shallow merge of settings.json + settings.local.json; deep-merge permissions if that matters.
  let settings: Record<string, unknown> = {};
  for (const f of ['settings.json', 'settings.local.json']) {
    if (fs.existsSync(path.join(worktree, '.claude', f))) continue;
    try { settings = { ...settings, ...JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', f), 'utf8')) }; } catch { /* absent or invalid */ }
  }
  if (Object.keys(settings).length) out.push('--settings', JSON.stringify(settings));
  return out;
}
