// What the TUI's epics screen shows for one factory epic, and which keys each row allows.
// Mirrors the dashboard's factory strip (media/dashboard.js: epicStrip, sprintRows, reviewPanel, prGate): same states, same actions.
import { Board, Epic, Sprint } from './store';
import { Agent } from './claude';

// What a key does: a message for dashboardCore, or something the TUI asks for first (text, a number, PR options).
export type Act =
  | { label: string; msg: Record<string, unknown> }
  | { label: string; ask: 'changes' | 'sendBack' | 'start' | 'workers' | 'createPr' | 'prOpened'; sprintId?: string }
  | { label: string; plan: 'rendered' | 'source' }
  | { label: string; url: string };
export type Keys = Record<string, Act>;
export interface Row { id: string; text: string; badge: string; lines: string[]; needs: boolean; keys: Keys }

const SPRINT_STATE = { waiting: 'waiting', building: 'building', reviewing: 'sprint review', fixing: 'fixing', awaitingMerge: 'merge needs approval', merged: 'merged' };
const STAGE_ROLE: Record<string, string> = { planning: 'orchestrator', revalidating: 'revalidator', securityCheck: 'security' };
const STAGE_VERB: Record<string, string> = { planning: 'is planning sprints and stories', revalidating: 'is revalidating the plan', securityCheck: 'is checking security' };
const ORDER = ['planning', 'revalidating', 'securityCheck', 'awaitingPlanApproval', 'ready', 'building', 'paused', 'awaitingPrApproval', 'done'];
const LENS = { revalidator: 'Revalidate', security: 'Security', reviewer: 'Review' };
const ENDED = ['done', 'stopped', 'failed'];

// Waiting on a human: a gate, an error, a blocked sprint or story, or one of its sessions asking for permission.
export function epicNeeds(b: Board, e: Epic, agents: Record<string, Agent> = {}) {
  const sprints = b.sprints.filter(s => s.epicId === e.id), stories = b.stories.filter(s => s.epicId === e.id && !s.archived);
  const sessions = [e.stageSessionId, ...stories.flatMap(s => [s.builderSessionId, s.reviewerSessionId]),
    ...sprints.flatMap(s => [s.sessionId, ...(s.reviews ?? []).map(r => r.sessionId)])];
  return !!(e.error || e.pending?.reason || e.stage?.startsWith('awaiting')
    || sprints.some(s => s.blocked || s.state === 'awaitingMerge') || stories.some(s => s.blocked)
    || sessions.some(sid => sid && agents[sid]?.state === 'blocked'));
}

// One line: Planning ✓ ─ Approval ◉ ─ Build ○ ─ Review ○ ─ PR ○
export function pipeline(b: Board, e: Epic) {
  const at = ORDER.indexOf(e.stage!);
  const sp = b.sprints.filter(s => s.epicId === e.id);
  const inBuild = ['ready', 'building', 'paused'].includes(e.stage!);
  const built = sp.length > 0 && sp.every(s => ['reviewing', 'awaitingMerge', 'merged'].includes(s.state ?? ''));
  const reviewing = sp.some(s => ['reviewing', 'awaitingMerge'].includes(s.state ?? ''));
  const mark = (done: boolean, cur: boolean) => done ? '✓' : cur ? '◉' : '○';
  return [
    `Planning ${mark(at > 2, at >= 0 && at <= 2)}`,
    `Approval ${mark(at > 3, at === 3)}`,
    `Build ${mark(at > 6 || built, inBuild && !built)}`,
    `Review ${mark(at > 6, inBuild && (reviewing || built))}`,
    `PR ${mark(e.stage === 'done', e.stage === 'awaitingPrApproval')}`,
  ].join(' ─ ') + (at < 0 ? `   (${e.stage})` : '');
}

export function progress(b: Board, e: Epic) {
  const sp = b.sprints.filter(s => s.epicId === e.id), st = b.stories.filter(s => s.epicId === e.id && !s.archived);
  return sp.length ? `${st.filter(s => s.status === 'done').length}/${st.length} stories · ${sp.filter(s => s.state === 'merged').length}/${sp.length} sprints merged` : '';
}

// keys: valid for the epic whatever row is selected. rows: its sprints (and their reviewers), each with its own keys.
export function epicView(b: Board, e: Epic, agents: Record<string, Agent>, plan?: string) {
  const st = (sid?: string) => sid ? agents[sid]?.state : undefined;
  const live = (sid?: string) => !!st(sid) && !ENDED.includes(st(sid)!);
  const attach = (sid: string | undefined, label = 'attach'): Keys => live(sid) ? { a: { label: st(sid) === 'blocked' ? 'approve…' : label, msg: { type: 'attachEpic', epicId: e.id, sessionId: sid } } } : {};
  const gate = (decision: string, extra: Record<string, unknown> = {}) => ({ type: 'factoryGate', epicId: e.id, decision, ...extra });
  const stage = e.stage!;
  const role = STAGE_ROLE[stage];
  const lines: string[] = [];

  const keys: Keys = {};
  if (plan) { keys.v = { label: 'plan', plan: 'rendered' }; keys.V = { label: 'plan source', plan: 'source' }; }
  if (role && !e.error) {
    Object.assign(keys, attach(e.stageSessionId));
    lines.push(`${live(e.stageSessionId) && st(e.stageSessionId) === 'blocked' ? '!' : '◉'} ${e.roleAgents?.[role as 'orchestrator'] ?? `LexCode ${role}`} ${STAGE_VERB[stage]} · ${st(e.stageSessionId) ?? 'starting…'}`);
  }
  if (e.error) { lines.push(`✗ ${e.error}`); keys.R = { label: 'retry', msg: gate('retry') }; }
  if (stage === 'awaitingPlanApproval') {
    lines.push('The plan is ready: read it, then approve or ask for changes.');
    Object.assign(keys, { y: { label: 'approve', msg: gate('approve') }, C: { label: 'changes…', ask: 'changes' }, X: { label: 'reject', msg: gate('reject') } });
  }
  if (stage === 'ready') keys.s = { label: 'start build', ask: 'start' };
  if (stage === 'building' || stage === 'paused') {
    keys.p = { label: stage === 'paused' ? 'resume' : 'pause', msg: gate(stage === 'paused' ? 'resume' : 'pause') };
    keys.w = { label: 'builders', ask: 'workers' };
    if (stage === 'paused') lines.push('Paused: no new sessions start.');
  }
  if (stage === 'awaitingPrApproval') {
    const pend = e.pending ?? { kind: 'pr' };
    lines.push(`All sprints are merged into ${e.branch}.`);
    if (pend.skill) {
      lines.push(`/${pend.skill} is running in a terminal. Paste the PR URL once it's open.`);
      keys.u = { label: 'PR opened…', ask: 'prOpened' };
      keys.P = { label: 'run skill again', msg: gate('createPr', { targetBranch: e.targetBranch, via: 'skill', skill: pend.skill }) };
    } else if (pend.busy && Date.now() - pend.busy < 120000) lines.push('Creating the PR…');
    else {
      keys.P = { label: 'create PR…', ask: 'createPr' };
      if (pend.reason) lines.push(`⚠ ${pend.reason}`);
    }
  }
  if (stage === 'done' && e.prUrl) { lines.push(`PR: ${e.prUrl}`); keys.o = { label: 'open PR', url: e.prUrl }; }
  if (stage === 'cancelled' || stage === 'failed') keys.r = { label: 'restart', msg: gate('restart') };
  if (stage === 'done') keys.A = { label: 'archive', msg: gate('archive') };
  if (!['done', 'cancelled', 'awaitingPlanApproval'].includes(stage)) keys.x = { label: 'cancel', msg: gate('cancel') };

  const rows: Row[] = [];
  if (['building', 'paused', 'awaitingPrApproval'].includes(stage)) {
    const sprints = b.sprints.filter(s => s.epicId === e.id).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    for (const sp of sprints) rows.push(...sprintRows(b, e, sp, st, attach, gate));
  }
  return { keys, lines, rows };
}

function sprintRows(b: Board, e: Epic, sp: Sprint, st: (sid?: string) => string | undefined,
  attach: (sid: string | undefined, label?: string) => Keys, gate: (d: string, x?: Record<string, unknown>) => Record<string, unknown>): Row[] {
  const own = b.stories.filter(s => s.sprintId === sp.id && !s.archived);
  const done = own.filter(s => s.status === 'done').length;
  const cur = own.find(s => s.status !== 'done');
  const curSid = cur && (cur.status === 'review' ? cur.reviewerSessionId : cur.builderSessionId);
  const name = sp.key && sp.name.startsWith(sp.key + ': ') ? sp.name.slice(sp.key.length + 2) : sp.name;
  const state = sp.state ?? 'waiting';
  const after = (sp.dependsOn ?? []).map(id => b.sprints.find(x => x.id === id)).filter(d => d && d.state !== 'merged').map(d => d!.key ?? d!.name);
  const lines: string[] = [];
  let keys: Keys = {};
  if (state === 'building' && cur && !cur.blocked) {
    lines.push(`${cur.status === 'review' ? 'Reviewing' : 'Building'} “${cur.title}”${cur.attempts ? ` · attempt ${cur.attempts + 1}` : ''} · ${st(curSid) ?? 'starting…'}`);
    keys = { ...attach(curSid) };
  }
  if (state === 'fixing') {
    lines.push(`Fixing sprint review issues · ${st(sp.sessionId) ?? 'starting…'}`, ...(sp.issues ?? []).map(i => `  • ${i}`));
    keys = { ...attach(sp.sessionId) };
  }
  if (sp.blocked) { lines.push(`✗ ${sp.blocked}`); keys.R = { label: 'retry sprint', msg: gate('retrySprint', { sprintId: sp.id }) }; }
  if (cur?.blocked) {
    lines.push(`✗ “${cur.title}”: ${cur.blocked}`);
    Object.assign(keys, attach(cur.builderSessionId, 'take over'),
      { R: { label: 'retry story', msg: gate('retryStory', { storyId: cur.id }) }, S: { label: 'skip story', msg: gate('skipStory', { storyId: cur.id }) } });
  }
  if (state === 'awaitingMerge') {
    lines.push('This merge needs your approval:', ...(sp.critical ?? []).map(r => `  ⚠ ${r}`));
    Object.assign(keys, { m: { label: 'approve merge', msg: gate('approveMerge', { sprintId: sp.id }) }, b: { label: 'send back…', ask: 'sendBack', sprintId: sp.id } });
  }
  const row: Row = {
    id: sp.id, text: `${sp.key ?? ''}  ${name}`,
    needs: !!(sp.blocked || cur?.blocked || state === 'awaitingMerge' || keys.a?.label === 'approve…'),
    badge: `${SPRINT_STATE[state]}${state === 'waiting' && after.length ? ` · after ${after.join(', ')}` : ''}   ${done}/${own.length}`,
    lines, keys,
  };
  // Sprint review panel: one selectable row per reviewer.
  const reviews = state === 'reviewing' ? (sp.reviews ?? []).map((r, i): Row => {
    const v = r.verdict;
    return {
      id: `${sp.id}:${i}`, text: `    ${v ? (v.pass ? '✓' : '✗') : '◉'} ${LENS[r.lens]} · ${r.agent ?? `LexCode ${r.lens}`}`, needs: st(r.sessionId) === 'blocked',
      badge: v ? (v.pass ? 'passed' : `${v.issues.length} issue${v.issues.length === 1 ? '' : 's'}`) + (v.risk === 'critical' ? ' · ⚠ critical' : '') : st(r.sessionId) ?? 'starting…',
      lines: v && !v.pass ? v.issues.map(x => `      • ${x}`) : [], keys: v ? {} : attach(r.sessionId),
    };
  }) : [];
  return [row, ...reviews];
}

// Text from $EDITOR: everything from the scissors line down is help, not content (lets markdown keep its # headings).
export const SCISSORS = '# ------------------------ >8 ------------------------';
export const cutHelp = (text: string) => { const i = text.indexOf(SCISSORS); return (i < 0 ? text : text.slice(0, i)).trim(); };
