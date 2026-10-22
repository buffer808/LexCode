import * as fs from 'fs';
import * as path from 'path';
import { Board, Epic, EpicStage, ModelChoice, ModelRole, Project, Role, Sprint, Story, Store } from './store';
import { AgentDef } from './agents';
import { Plan, Verdict, extractJson, validatePlan, validateVerdict, renderPlanMd } from './plan';
import { globMatch } from './git';

// Software factory core (no vscode): what each planning stage runs, and what happens with its result.
// factoryRunner.ts drives it from the extension.

export const PLANNING: EpicStage[] = ['planning', 'revalidating', 'securityCheck'];
export const STAGE_ROLE: Partial<Record<EpicStage, Role>> = { planning: 'orchestrator', revalidating: 'revalidator', securityCheck: 'security' };
export const NEXT_STAGE: Partial<Record<EpicStage, EpicStage>> = { planning: 'revalidating', revalidating: 'securityCheck', securityCheck: 'awaitingPlanApproval' };
export const STAGE_LABEL: Record<EpicStage, string> = {
  planning: 'Planning', revalidating: 'Revalidating', securityCheck: 'Security check', awaitingPlanApproval: 'Awaiting plan approval',
  ready: 'Ready to build', building: 'Building', paused: 'Paused', awaitingPrApproval: 'Awaiting PR approval',
  done: 'Done', failed: 'Failed', cancelled: 'Cancelled',
};
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_MODELS: Partial<Record<ModelRole, ModelChoice>> = { planner: { model: 'opus', effort: 'high' } };
export const modelRole = (r: Role): ModelRole => r === 'builder' || r === 'reviewer' ? r : 'planner';

// Epic choice > mapped agent's own frontmatter model > settings > built-in default.
// With `--agent`, leaving --model off lets the agent's frontmatter model apply.
export function modelArgs(epic: Epic, role: Role, settings: Partial<Record<ModelRole, ModelChoice>> = {}, agent?: AgentDef): string[] {
  const mr = modelRole(role);
  const e = epic.models?.[mr] ?? {}, s = { ...DEFAULT_MODELS[mr], ...settings[mr] };
  const model = e.model ?? (agent?.model ? undefined : s.model);
  const effort = e.effort ?? s.effort;
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

const PLAN_SCHEMA = `{
  "summary": "what will be built and any assumptions you made",
  "sprints": [{
    "key": "S1", "name": "short name", "dependsOn": ["keys of sprints that must be merged first"], "parallel": true,
    "stories": [{ "title": "...", "description": "what to do + acceptance criteria (incl. tests)", "points": 3, "refs": ["project/relative/path.ts"] }]
  }],
  "reuse": ["existing code the plan reuses"],
  "dependencies": [{ "name": "library/service/tool", "available": true, "note": "optional" }],
  "affectedFiles": ["existing files the plan changes"],
  "security": [{ "severity": "low|medium|high", "sprint": "S1", "story": "story title", "finding": "risk and how to prevent it" }]
}`;

export interface StageContext {
  plan?: Plan;               // current plan (revalidate/security, or planning after "request changes")
  feedback?: string;         // human feedback from the plan gate
  roleBody?: string;         // bundled role prompt when no project agent is mapped
  collaborators: AgentDef[]; // every discovered agent, offered for delegation
}

export function stagePrompt(stage: EpicStage, epic: Epic, ctx: StageContext): string {
  const task: Record<string, string> = {
    planning: ctx.plan ? 'Revise the plan below for this epic, applying the human feedback.' : 'Plan this epic: break it into sprints and stories.',
    revalidating: 'Revalidate the plan below against the codebase: reuse existing code, check dependencies are available, list affected files. Return the full corrected plan.',
    securityCheck: 'Security-review the plan below and the code it touches. Return the full plan with `security` findings filled in.',
  };
  const others = ctx.collaborators.filter(a => a.name !== epic.roleAgents?.[STAGE_ROLE[stage]!]);
  return [
    ctx.roleBody,
    `# Epic: ${epic.title}`, epic.description,
    `## Task\n${task[stage]}`,
    ctx.plan && `## Current plan\n\`\`\`json\n${JSON.stringify(ctx.plan, null, 2)}\n\`\`\``,
    ctx.feedback && `## Human feedback\n${ctx.feedback}`,
    others.length && `## Available project subagents\nDelegate to these where their expertise fits:\n${others.map(a => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}`,
    `## Output\nYou are running unattended in read-only plan mode: do not ask questions and do not try to exit plan mode. ` +
    `Make reasonable assumptions and state them in \`summary\`. End your final message with exactly one \`\`\`json block in this shape:\n\`\`\`json\n${PLAN_SCHEMA}\n\`\`\``,
  ].filter(Boolean).join('\n\n');
}

// Args for `claude --bg` (launchBackground adds --bg). resumeId: continue that session with `prompt`.
export function stageArgs(stage: EpicStage, epic: Epic, prompt: string, settings: Partial<Record<ModelRole, ModelChoice>>, agent?: AgentDef, resumeId?: string): string[] {
  const role = STAGE_ROLE[stage]!;
  // --disallowedTools is variadic: keep an option right after it so it can't swallow the prompt.
  return ['--disallowedTools', 'ExitPlanMode', '--permission-mode', 'plan',
    ...(agent ? ['--agent', agent.name] : []), ...modelArgs(epic, role, settings, agent),
    ...(resumeId ? ['--resume', resumeId] : ['-n', `LexCode · ${epic.title} · ${STAGE_LABEL[stage]}`]), prompt];
}

/* ---------- plan files: <project>/.lexcode/epics/<epicId>/plan.{json,md} ---------- */

export const epicDir = (projectPath: string, epicId: string) => path.join(projectPath, '.lexcode', 'epics', epicId);
export const planFile = (projectPath: string, epicId: string, ext: 'json' | 'md' = 'json') => path.join(epicDir(projectPath, epicId), `plan.${ext}`);

export function writePlan(projectPath: string, epic: Epic, plan: Plan) {
  fs.mkdirSync(epicDir(projectPath, epic.id), { recursive: true });
  fs.writeFileSync(planFile(projectPath, epic.id), JSON.stringify(plan, null, 2));
  fs.writeFileSync(planFile(projectPath, epic.id, 'md'), renderPlanMd(epic.title, plan));
}

export function readPlan(projectPath: string, epicId: string): Plan | undefined {
  try { return validatePlan(JSON.parse(fs.readFileSync(planFile(projectPath, epicId), 'utf8'))); } catch { return undefined; }
}

// Stage output → validated plan; throws with a message the agent can act on.
export function parseStageOutput(text: string | undefined): Plan {
  if (!text) throw new Error('the session ended without a final message');
  return validatePlan(extractJson(text));
}

// Approved plan → board: one sprint per plan sprint (tied to the epic), stories in TODO.
export function applyPlan(store: Store, project: Project, epic: Epic, plan: Plan) {
  const ids = new Map<string, string>();
  plan.sprints.forEach((s, order) => {
    const sp = store.add('sprints', { projectId: project.id, name: `${s.key}: ${s.name}`, active: false, epicId: epic.id, key: s.key, order,
      dependsOn: s.dependsOn.map(k => ids.get(k)!), parallel: s.parallel, state: 'waiting' });
    ids.set(s.key, sp.id);
    for (const t of s.stories) {
      store.add('stories', { projectId: project.id, title: t.title, status: 'todo', epicId: epic.id, sprintId: sp.id,
        // refs[0] = the epic's plan (story detail labels it "plan"), then the story's own files.
        points: t.points, description: t.description, refs: [planFile(project.path, epic.id, 'md'), ...(t.refs ?? []).map(r => path.join(project.path, r))] });
    }
  });
  store.update('epics', epic.id, { stage: 'ready', pending: undefined, feedback: undefined, stageSessionId: undefined, error: undefined });
}

// One window drives each epic: lock = {owner, at} refreshed on every tick; stale after `staleMs`.
// ponytail: read-then-write race between two windows in the same instant; re-read confirms who won.
export function tryLock(file: string, owner: string, staleMs = 60_000, now = Date.now()): boolean {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur.owner !== owner && now - cur.at < staleMs) return false;
  } catch { /* missing or corrupt: take it */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ owner, at: now }));
  return JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner;
}

/* ---------- new epic input (dashboard form / command); webview input is untrusted ---------- */

export interface EpicInput {
  title: string; description?: string; targetBranch?: string;
  builderMode: 'acceptEdits' | 'auto';
  models?: Partial<Record<ModelRole, ModelChoice>>;
  roleAgents: Partial<Record<Role, string>>;
}

const MODEL_ROLES: ModelRole[] = ['planner', 'builder', 'reviewer'];
const ROLE_NAMES: Role[] = ['orchestrator', 'revalidator', 'security', 'builder', 'reviewer'];
// git check-ref-format, roughly: no spaces/control chars, no "..", no leading "-" or "/", no trailing "/" or ".lock".
export const validBranch = (b: string) => /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*(?:\/|\.lock)$)[\w./-]{1,200}$/.test(b);

// roleAgents: absent → `detected` (auto mapping); present → exactly what was picked ('' = LexCode default).
export function parseEpicInput(raw: any, agents: AgentDef[], detected: Partial<Record<Role, string>>): EpicInput {
  const title = typeof raw?.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  if (!title) throw new Error('Epic title is required');
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 20000) : undefined;
  const tb = typeof raw.targetBranch === 'string' ? raw.targetBranch.trim() : '';
  if (tb && !validBranch(tb)) throw new Error(`Invalid target branch "${tb}"`);

  const models: Partial<Record<ModelRole, ModelChoice>> = {};
  for (const r of MODEL_ROLES) {
    const m = raw.models?.[r];
    const model = typeof m?.model === 'string' && /^[\w.\-[\]]{1,80}$/.test(m.model) ? m.model : undefined;
    const effort = EFFORTS.find(e => e === m?.effort);
    if (model || effort) models[r] = { ...(model && { model }), ...(effort && { effort }) };
  }

  let roleAgents: Partial<Record<Role, string>> = detected;
  if (raw.roleAgents && typeof raw.roleAgents === 'object') {
    roleAgents = {};
    for (const r of ROLE_NAMES) {
      const name = raw.roleAgents[r];
      if (typeof name === 'string' && agents.some(a => a.name === name)) roleAgents[r] = name;
    }
  }
  return { title, description, targetBranch: tb || undefined, builderMode: raw.builderMode === 'auto' ? 'auto' : 'acceptEdits',
    models: Object.keys(models).length ? models : undefined, roleAgents };
}

/* ---------- build loop: sprints → stories → builder → reviewer → merge ---------- */

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
export const epicBranch = (e: Epic) => `lexcode/${slug(e.title)}-${e.id.slice(0, 6)}`;
// "--" not "/": git can't hold both refs/heads/a and refs/heads/a/b.
export const sprintBranch = (e: Epic, sp: Sprint) => `${e.branch ?? epicBranch(e)}--${slug(sp.key ?? sp.name)}`;
export const worktreeDir = (projectPath: string, id: string) => path.join(projectPath, '.lexcode', 'worktrees', id);

export interface AgentState { state: string; startedAt?: number }
// Session finished its current run (not a stale `done` from before it was resumed).
export const finished = (agents: Record<string, AgentState>, sid: string | undefined, since = 0) =>
  !!sid && agents[sid]?.state === 'done' && (agents[sid].startedAt ?? 0) >= since;

export type Action =
  | { kind: 'startSprint'; sprint: Sprint }
  | { kind: 'build'; sprint: Sprint; story: Story }     // start (or restart) the story's builder
  | { kind: 'review'; sprint: Sprint; story: Story }    // builder finished: check commits, start reviewer
  | { kind: 'verdict'; sprint: Sprint; story: Story }   // reviewer finished: pass → done, fail → back to builder
  | { kind: 'reviewSprint'; sprint: Sprint }            // all stories done, or a fix finished
  | { kind: 'sprintVerdict'; sprint: Sprint }           // sprint review finished: merge, gate, or fix
  | { kind: 'finish' };                                 // every sprint merged: PR gate

export const sprintsOf = (b: Board, e: Epic) => b.sprints.filter(s => s.epicId === e.id).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
export const storiesOf = (b: Board, sp: Sprint) => b.stories.filter(s => s.sprintId === sp.id && !s.archived);

// What to do next for a building epic. Pure: the runner executes the actions.
// Sprints start when their dependencies are merged and a worker is free; a sequential (non-parallel) sprint
// only runs alone. Stories inside a sprint run one at a time on the sprint's branch.
export function nextActions(b: Board, e: Epic, agents: Record<string, AgentState>, busy: Set<string> = new Set()): Action[] {
  if (e.stage !== 'building') return [];
  const sprints = sprintsOf(b, e);
  if (sprints.length && sprints.every(s => s.state === 'merged')) return [{ kind: 'finish' }];
  const out: Action[] = [];
  const running = sprints.filter(s => s.state && !['waiting', 'merged'].includes(s.state));

  for (const sp of sprints) {
    if (busy.has(sp.id) || sp.blocked) continue;
    if (sp.state === 'building') {
      const story = storiesOf(b, sp).find(s => s.status !== 'done');
      if (!story) { out.push({ kind: 'reviewSprint', sprint: sp }); continue; }
      if (busy.has(story.id) || story.blocked) continue;
      if (story.status === 'todo' || (story.status === 'doing' && !story.builderSessionId)) out.push({ kind: 'build', sprint: sp, story });
      else if (story.status === 'doing' && finished(agents, story.builderSessionId, story.runStartedAt)) out.push({ kind: 'review', sprint: sp, story });
      else if (story.status === 'review' && !story.reviewerSessionId) out.push({ kind: 'review', sprint: sp, story });
      else if (story.status === 'review' && finished(agents, story.reviewerSessionId, story.runStartedAt)) out.push({ kind: 'verdict', sprint: sp, story });
    } else if (sp.state === 'reviewing') {
      if (!sp.sessionId) out.push({ kind: 'reviewSprint', sprint: sp });
      else if (finished(agents, sp.sessionId, sp.runStartedAt)) out.push({ kind: 'sprintVerdict', sprint: sp });
    } else if (sp.state === 'fixing' && finished(agents, sp.sessionId, sp.runStartedAt)) {
      out.push({ kind: 'reviewSprint', sprint: sp });
    }
  }

  const workers = Math.max(1, e.workers ?? 1);
  const merged = new Set(sprints.filter(s => s.state === 'merged').map(s => s.id));
  for (const sp of sprints) {
    if ((sp.state ?? 'waiting') !== 'waiting' || busy.has(sp.id) || sp.blocked) continue;
    if (!(sp.dependsOn ?? []).every(d => merged.has(d))) continue;
    if (running.length >= workers) break;
    if (running.length && (!sp.parallel || running.some(r => !r.parallel))) continue;
    out.push({ kind: 'startSprint', sprint: sp });
    running.push(sp);
  }
  return out;
}

const MAX_DIFF = 150_000;
const clip = (diff: string, base: string) => diff.length <= MAX_DIFF ? diff
  : `${diff.slice(0, MAX_DIFF)}\n\n[diff truncated at ${MAX_DIFF} characters; read the changed files for the rest (base ${base})]`;
const collaboratorList = (agents: AgentDef[], self?: string) => {
  const others = agents.filter(a => a.name !== self);
  return others.length ? `## Available project subagents\nDelegate to these where their expertise fits:\n${others.map(a => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}` : '';
};
export const commitMessage = (s: Story) => `story(${s.id.slice(0, 8)}): ${s.title}`;

export interface BuildContext { roleBody?: string; collaborators: AgentDef[]; projectPath: string }

export function builderPrompt(e: Epic, sp: Sprint, s: Story, ctx: BuildContext): string {
  // .lexcode/ is git-excluded, so it isn't in the worktree: the plan file stays out of the builder's reading list.
  const refs = (s.refs ?? []).map(r => path.relative(ctx.projectPath, r)).filter(r => !r.startsWith('..') && !r.startsWith('.lexcode'));
  return [
    ctx.roleBody,
    `# Story: ${s.title}`, s.description,
    refs.length && `Related files (read them first):\n${refs.map(r => `- ${r}`).join('\n')}`,
    `## Context\nEpic: ${e.title}${e.description ? `\n${e.description}` : ''}\nSprint: ${sp.name}`,
    collaboratorList(ctx.collaborators, e.roleAgents?.builder),
    `## Rules\nYou work unattended. Your current directory already is a git worktree on branch \`${sp.branch}\`: work here, do not create or enter other worktrees. Do not switch branches, push, merge or rebase. ` +
    `Implement only this story, add or update tests, run the tests, then commit all your changes with the message \`${commitMessage(s)}\`. ` +
    `A reviewer checks your commits next.`,
  ].filter(Boolean).join('\n\n');
}

export const fixPrompt = (s: Story, issues: string[]) =>
  `The reviewer rejected your work on "${s.title}". Fix every issue below, rerun the tests, and commit with the message \`${commitMessage(s)} (fix)\`.\n\n${issues.map(i => `- ${i}`).join('\n')}`;

const VERDICT_SCHEMA = `{ "pass": true, "risk": "minor|critical", "issues": ["specific, actionable problem (file:line, what to change)"] }`;
const verdictRules = `## Output\nYou are running unattended in read-only plan mode: do not ask questions and do not try to exit plan mode. ` +
  `End your final message with exactly one \`\`\`json block:\n\`\`\`json\n${VERDICT_SCHEMA}\n\`\`\`\n` +
  `A failing verdict must list issues. Use risk "critical" for security-sensitive code, migrations, public API/config changes, or anything you are unsure is safe to merge.`;

export function reviewPrompt(e: Epic, sp: Sprint, s: Story, diff: string, ctx: BuildContext): string {
  return [ctx.roleBody, `# Review story: ${s.title}`, s.description,
    `Epic: ${e.title} · Sprint: ${sp.name} · Branch: \`${sp.branch}\``,
    `## Diff (${s.baseCommit?.slice(0, 8)}...HEAD)\n\`\`\`diff\n${clip(diff, s.baseCommit ?? '')}\n\`\`\``,
    collaboratorList(ctx.collaborators, e.roleAgents?.reviewer), verdictRules].filter(Boolean).join('\n\n');
}

export function sprintReviewPrompt(e: Epic, sp: Sprint, stories: Story[], diff: string, ctx: BuildContext): string {
  return [ctx.roleBody, `# Review sprint: ${sp.name}`,
    `Epic: ${e.title}${e.description ? `\n${e.description}` : ''}`,
    `The sprint's stories each passed review. Check the sprint as a whole before it merges into \`${e.branch}\`: ` +
    `do the stories fit together, is anything missing, do the tests cover it, is it safe to merge?`,
    `## Stories\n${stories.map(s => `- ${s.title}`).join('\n')}`,
    `## Diff (${e.branch}...${sp.branch})\n\`\`\`diff\n${clip(diff, e.branch ?? '')}\n\`\`\``,
    collaboratorList(ctx.collaborators, e.roleAgents?.reviewer), verdictRules].filter(Boolean).join('\n\n');
}

export const sprintFixPrompt = (e: Epic, sp: Sprint, issues: string[]) =>
  `# Fix sprint: ${sp.name}\n\nYou work unattended. Your current directory already is a git worktree on branch \`${sp.branch}\` (epic branch \`${e.branch}\`): work here, do not create or enter other worktrees. ` +
  `Do not switch branches, push or rebase. Resolve every issue below, run the tests, and commit with the message \`sprint(${slug(sp.key ?? sp.name)}): fix review issues\`.\n\n` +
  issues.map(i => `- ${i}`).join('\n');

export const conflictIssue = (e: Epic, files: string[]) =>
  `Merging into \`${e.branch}\` conflicts in: ${files.join(', ')}. Run \`git merge ${e.branch}\` on your branch, resolve the conflicts keeping both sides' intent, run the tests, and commit the merge.`;

export function parseVerdict(text: string | undefined): Verdict {
  if (!text) throw new Error('the session ended without a final message');
  return validateVerdict(extractJson(text));
}

// Why a reviewed sprint's merge needs a human. Empty = merge automatically.
export function criticalReasons(sp: Sprint, verdict: Verdict, changed: string[], sensitiveGlobs: string[], plan?: Plan): string[] {
  const out: string[] = [];
  if (verdict.risk === 'critical') out.push('reviewer flagged the sprint as critical');
  const hits = changed.filter(f => sensitiveGlobs.some(g => globMatch(f, g)));
  if (hits.length) out.push(`sensitive paths changed: ${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ', …' : ''}`);
  for (const f of plan?.security ?? []) {
    if (f.sprint === sp.key && f.severity !== 'low') out.push(`${f.severity} security finding: ${f.finding}`);
  }
  return out;
}

// Sessions already run inside the sprint worktree; Claude Code's own worktree tools would stop to ask for approval.
const NO_WORKTREE_TOOLS = ['EnterWorktree', 'ExitWorktree'];

export interface SessionArgs { mode: string; agent?: AgentDef; extra: string[]; name?: string; resumeId?: string }
// Args for builder/reviewer sessions (launchBackground adds --bg). Reviewers are read-only.
export function sessionArgs(e: Epic, role: 'builder' | 'reviewer', prompt: string, settings: Partial<Record<ModelRole, ModelChoice>>, a: SessionArgs): string[] {
  return ['--disallowedTools', ...(a.mode === 'plan' ? ['ExitPlanMode'] : []), ...NO_WORKTREE_TOOLS, '--permission-mode', a.mode,
    ...(a.agent ? ['--agent', a.agent.name] : []), ...modelArgs(e, role, settings, a.agent), ...a.extra,
    ...(a.resumeId ? ['--resume', a.resumeId] : a.name ? ['-n', a.name] : []), prompt];
}
