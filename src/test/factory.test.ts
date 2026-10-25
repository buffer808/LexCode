import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Epic, Store } from '../store';
import { AgentDef } from '../agents';
import { validatePlan } from '../plan';
import {
  modelArgs, stagePrompt, stageArgs, parseStageOutput, applyPlan, tryLock, parseEpicInput, validBranch, writePlan, readPlan, planFile,
} from '../factory';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const epic = (extra: Partial<Epic> = {}): Epic => ({ id: 'e1', projectId: 'p1', title: 'Health', description: 'Add /health', ...extra });
const agent = (name: string, model?: string): AgentDef => ({ name, description: `${name} desc`, model, scope: 'project', file: '' });
const plan = validatePlan({
  summary: 's',
  sprints: [
    { key: 'S1', name: 'Core', parallel: true, stories: [{ title: 'Route', points: 2, refs: ['src/app.ts'] }, { title: 'Test' }] },
    { key: 'S2', name: 'Docs', dependsOn: ['S1'], stories: [{ title: 'README', description: 'docs' }] },
  ],
});

test('modelArgs: epic > agent frontmatter > settings > default', () => {
  assert.deepEqual(modelArgs(epic(), 'orchestrator'), ['--model', 'opus', '--effort', 'high']); // planner default
  assert.deepEqual(modelArgs(epic(), 'security', { planner: { model: 'sonnet' } }), ['--model', 'sonnet', '--effort', 'high']);
  assert.deepEqual(modelArgs(epic(), 'orchestrator', {}, agent('lead', 'haiku')), ['--effort', 'high']); // agent's own model applies
  assert.deepEqual(modelArgs(epic(), 'orchestrator', {}, agent('lead')), ['--model', 'opus', '--effort', 'high']);
  assert.deepEqual(modelArgs(epic({ models: { planner: { model: 'fable', effort: 'max' } } }), 'revalidator', {}, agent('x', 'haiku')),
    ['--model', 'fable', '--effort', 'max']);
  assert.deepEqual(modelArgs(epic(), 'builder'), []); // CLI default
  assert.deepEqual(modelArgs(epic(), 'builder', { builder: { effort: 'low' } }), ['--effort', 'low']);
});

test('stage prompt and args', () => {
  const e = epic({ roleAgents: { orchestrator: 'lead' } });
  const p = stagePrompt('planning', e, { collaborators: [agent('lead'), agent('db-expert')], roleBody: undefined });
  assert.match(p, /# Epic: Health\n\nAdd \/health/);
  assert.match(p, /Plan this epic/);
  assert.match(p, /- db-expert: db-expert desc/);
  assert.doesNotMatch(p, /- lead:/); // the stage's own agent isn't offered to itself
  assert.match(p, /exactly one ```json block/);

  const r = stagePrompt('revalidating', e, { plan, collaborators: [], roleBody: 'You revalidate.' });
  assert.ok(r.startsWith('You revalidate.'));
  assert.match(r, /## Current plan\n```json\n\{\n  "summary": "s"/);
  assert.match(stagePrompt('planning', e, { plan, feedback: 'smaller stories', collaborators: [] }), /Revise the plan[\s\S]*## Human feedback\nsmaller stories/);

  const args = stageArgs('planning', e, 'PROMPT', {}, agent('lead'));
  assert.deepEqual(args, ['--disallowedTools', 'ExitPlanMode', 'Write', 'Edit', 'NotebookEdit', '--permission-mode', 'plan', '--agent', 'lead',
    '--model', 'opus', '--effort', 'high', '-n', 'LexCode · Health · Planning', 'PROMPT']);
  const resume = stageArgs('securityCheck', e, 'FIX', {}, undefined, 'sid');
  assert.deepEqual(resume.slice(-3), ['--resume', 'sid', 'FIX']);
  assert.ok(!resume.includes('--agent') && !resume.includes('-n'));
});

test('parseStageOutput', () => {
  assert.throws(() => parseStageOutput(undefined), /without a final message/);
  assert.throws(() => parseStageOutput('no json'), /no ```json block/);
  assert.equal(parseStageOutput('done:\n```json\n' + JSON.stringify(plan) + '\n```').sprints.length, 2);
});

test('writePlan/readPlan and applyPlan put sprints + stories on the board', () => {
  const projectPath = tmp('lex-proj-');
  const store = new Store(path.join(tmp('lex-'), 'board.json'));
  const project = store.add('projects', { name: 'x', path: projectPath });
  const e = store.add('epics', { projectId: project.id, title: 'Health', stage: 'awaitingPlanApproval', pending: { kind: 'plan' }, feedback: 'f' });

  assert.equal(readPlan(projectPath, e.id), undefined);
  writePlan(projectPath, e, plan);
  assert.deepEqual(readPlan(projectPath, e.id), plan);
  assert.match(fs.readFileSync(planFile(projectPath, e.id, 'md'), 'utf8'), /^# Plan: Health/);

  applyPlan(store, project, e, plan);
  const b = new Store(path.join(path.dirname((store as any).file), 'board.json')).all();
  const [s1, s2] = b.sprints;
  assert.deepEqual([s1.name, s1.key, s1.epicId, s1.parallel, s1.state, s1.active, s1.order], ['S1: Core', 'S1', e.id, true, 'waiting', false, 0]);
  assert.deepEqual(s2.dependsOn, [s1.id]);
  assert.deepEqual(b.stories.map(s => [s.title, s.status, s.sprintId === s1.id ? 'S1' : 'S2', s.epicId === e.id]),
    [['Route', 'todo', 'S1', true], ['Test', 'todo', 'S1', true], ['README', 'todo', 'S2', true]]);
  assert.deepEqual(b.stories[0].refs, [planFile(projectPath, e.id, 'md'), path.join(projectPath, 'src/app.ts')]); // plan first
  assert.deepEqual(b.stories[1].refs, [planFile(projectPath, e.id, 'md')]);
  const after = b.epics[0];
  assert.deepEqual([after.stage, after.pending, after.feedback], ['ready', undefined, undefined]);
});

test('tryLock: one owner until stale', () => {
  const file = path.join(tmp('lex-lock-'), 'locks', 'e.lock');
  assert.ok(tryLock(file, 'a', 1000, 0));
  assert.ok(!tryLock(file, 'b', 1000, 500));
  assert.ok(tryLock(file, 'a', 1000, 900)); // heartbeat
  assert.ok(!tryLock(file, 'b', 1000, 1500));
  assert.ok(tryLock(file, 'b', 1000, 2000)); // a went quiet
  fs.writeFileSync(file, '{corrupt');
  assert.ok(tryLock(file, 'c', 1000, 2001));
});

test('parseEpicInput validates untrusted form input', () => {
  const agents = [agent('lead'), agent('qa')];
  const detected = { orchestrator: 'lead' };
  const ok = parseEpicInput({ title: '  Health  ', description: ' ', targetBranch: 'release/1.2', builderMode: 'auto',
    models: { planner: { model: 'sonnet', effort: 'max' }, builder: { model: 'rm -rf /', effort: 'huge' }, reviewer: { model: '', effort: '' } } }, agents, detected);
  assert.deepEqual(ok, { title: 'Health', description: undefined, targetBranch: 'release/1.2', builderMode: 'auto',
    models: { planner: { model: 'sonnet', effort: 'max' } }, roleAgents: { orchestrator: 'lead' }, reviewers: [''] });

  // Explicit role picks replace detection; unknown agents and '' (LexCode default) are dropped.
  assert.deepEqual(parseEpicInput({ title: 't', roleAgents: { orchestrator: '', reviewer: 'qa', builder: 'ghost', bogus: 'lead' } }, agents, detected).roleAgents,
    { reviewer: 'qa' });
  assert.equal(parseEpicInput({ title: 't', builderMode: 'bypassPermissions' }, agents, {}).builderMode, 'acceptEdits');
  // Reviewers: known agents or '' (LexCode reviewer), deduped; the first also reviews stories.
  const r = parseEpicInput({ title: 't', reviewers: ['qa', 'ghost', '', 'qa', 7] }, agents, {});
  assert.deepEqual([r.reviewers, r.roleAgents.reviewer], [['qa', ''], 'qa']);
  assert.deepEqual(parseEpicInput({ title: 't', reviewers: ['ghost'] }, agents, { reviewer: 'qa' }).reviewers, ['']);
  assert.deepEqual(parseEpicInput({ title: 't' }, agents, { reviewer: 'qa' }).reviewers, ['qa']);
  assert.throws(() => parseEpicInput({ title: ' ' }, agents, {}), /title is required/);
  assert.throws(() => parseEpicInput({ title: 't', targetBranch: 'main; rm -rf' }, agents, {}), /Invalid target branch/);
});

test('validBranch', () => {
  for (const b of ['main', 'release/1.2', 'feat/x_y-z']) assert.ok(validBranch(b), b);
  for (const b of ['', '-x', '/x', 'x/', 'a..b', 'a//b', 'x.lock', 'has space', 'a~1', 'a:b']) assert.ok(!validBranch(b), b);
});

/* ---------- build loop ---------- */
import { nextActions, criticalReasons, sessionArgs, builderPrompt, reviewPrompt, sprintBranch, epicBranch, finished, reviewPanel, mergeVerdicts, sprintReviewPrompt } from '../factory';
import { worktreeArgs } from '../agents';
import { Board, Sprint, Story } from '../store';

const sp = (id: string, extra: Partial<Sprint> = {}): Sprint => ({ id, projectId: 'p1', name: id, active: false, epicId: 'e1', key: id, order: +id.slice(1), state: 'waiting', ...extra });
const st = (id: string, sprintId: string, extra: Partial<Story> = {}): Story => ({ id, projectId: 'p1', title: id, status: 'todo', epicId: 'e1', sprintId, ...extra });
const board = (sprints: Sprint[], stories: Story[]): Board => ({ projects: [], epics: [], sprints, stories });
const building = (extra: Partial<Epic> = {}) => epic({ stage: 'building', branch: 'lexcode/health-e1', workers: 1, ...extra });
const kinds = (b: Board, e: Epic, agents = {}, busy = new Set<string>()) => nextActions(b, e, agents, busy).map(a => `${a.kind}:${'story' in a ? a.story.id : 'sprint' in a ? a.sprint.id : ''}`);

test('scheduler: dependencies, worker cap, parallel vs sequential sprints', () => {
  const stories = [st('a', 'S1'), st('b', 'S2'), st('c', 'S3')];
  // S1, S2 parallel; S3 sequential after S1.
  const sprints = () => [sp('S1', { parallel: true }), sp('S2', { parallel: true }), sp('S3', { dependsOn: ['S1'] })];
  assert.deepEqual(kinds(board(sprints(), stories), building()), ['startSprint:S1']);              // 1 worker
  assert.deepEqual(kinds(board(sprints(), stories), building({ workers: 3 })), ['startSprint:S1', 'startSprint:S2']);
  assert.deepEqual(kinds(board(sprints(), stories), building({ stage: 'paused' })), []);
  assert.deepEqual(kinds(board(sprints(), stories), epic({ stage: 'ready' })), []);

  // S1 merged: S3 is ready but sequential, so it waits while parallel S2 runs.
  const s = sprints(); s[0].state = 'merged'; s[1].state = 'building';
  assert.deepEqual(kinds(board(s, [st('b', 'S2', { status: 'doing', builderSessionId: 'x', runStartedAt: 5 }), stories[2]]), building({ workers: 3 })), []);
  s[1].state = 'merged';
  assert.deepEqual(kinds(board(s, stories), building({ workers: 3 })), ['startSprint:S3']);
  s[2].state = 'merged';
  assert.deepEqual(kinds(board(s, stories), building()), ['finish:']);

  // A running sequential sprint blocks parallel ones too.
  const q = [sp('S1', { state: 'building' }), sp('S2', { parallel: true })];
  assert.deepEqual(kinds(board(q, [st('a', 'S1', { status: 'doing', builderSessionId: 'x' })]), building({ workers: 4 })), []);
  // Blocked or busy sprints are skipped.
  assert.deepEqual(kinds(board([sp('S1', { blocked: 'x' })], []), building()), []);
  assert.deepEqual(kinds(board([sp('S1')], []), building(), {}, new Set(['S1'])), []);
});

test('scheduler: story loop inside a building sprint', () => {
  const S = sp('S1', { state: 'building', worktree: '/wt', branch: 'b' });
  const run = (story: Partial<Story>, agents = {}) => kinds(board([S], [st('done', 'S1', { status: 'done' }), st('s', 'S1', story), st('next', 'S1')]), building(), agents);
  const done = (startedAt: number) => ({ sid: { state: 'done', startedAt } });
  assert.deepEqual(run({}), ['build:s']);                                                         // first non-done story only
  assert.deepEqual(run({ status: 'doing' }), ['build:s']);                                        // launch was lost
  assert.deepEqual(run({ status: 'doing', builderSessionId: 'sid', runStartedAt: 10 }, { sid: { state: 'busy', startedAt: 10 } }), []);
  assert.deepEqual(run({ status: 'doing', builderSessionId: 'sid', runStartedAt: 10 }, done(5)), []); // stale done from before resume
  assert.deepEqual(run({ status: 'doing', builderSessionId: 'sid', runStartedAt: 10 }, done(11)), ['review:s']);
  assert.deepEqual(run({ status: 'review' }), ['review:s']);
  assert.deepEqual(run({ status: 'review', reviewerSessionId: 'sid', runStartedAt: 10 }, done(12)), ['verdict:s']);
  assert.deepEqual(run({ status: 'doing', blocked: 'Review failed 3 times', builderSessionId: 'sid' }, done(99)), []);
  assert.deepEqual(kinds(board([S], [st('x', 'S1', { status: 'done' }), st('y', 'S1', { status: 'todo', archived: true })]), building()), ['reviewSprint:S1']);

  const R = (extra: Partial<Sprint>, agents = {}) => kinds(board([sp('S1', { worktree: '/wt', ...extra })], [st('x', 'S1', { status: 'done' })]), building(), agents);
  assert.deepEqual(R({ state: 'reviewing' }), ['reviewSprint:S1']);
  // Review panel: act when any reviewer finishes (read it) or when every verdict is in (decide); idle while they run.
  const v = { pass: true, risk: 'minor' as const, issues: [] };
  assert.deepEqual(R({ state: 'reviewing', reviews: [{ lens: 'security', sessionId: 'sid', startedAt: 1 }, { lens: 'reviewer', sessionId: 'b', startedAt: 1 }] },
    { sid: { state: 'busy', startedAt: 1 }, b: { state: 'busy', startedAt: 1 } }), []);
  assert.deepEqual(R({ state: 'reviewing', reviews: [{ lens: 'security', sessionId: 'sid', startedAt: 1 }, { lens: 'reviewer', sessionId: 'b', startedAt: 1 }] },
    { ...done(2), b: { state: 'busy', startedAt: 1 } }), ['sprintVerdict:S1']);
  assert.deepEqual(R({ state: 'reviewing', reviews: [{ lens: 'security', sessionId: 'sid', startedAt: 1, verdict: v }, { lens: 'reviewer', sessionId: 'b', startedAt: 1 }] },
    { ...done(2), b: { state: 'busy', startedAt: 1 } }), []); // only already-read ones finished
  assert.deepEqual(R({ state: 'reviewing', reviews: [{ lens: 'security', verdict: v }, { lens: 'reviewer', verdict: v }] }), ['sprintVerdict:S1']);
  assert.deepEqual(R({ state: 'fixing', sessionId: 'sid', runStartedAt: 1 }, done(2)), ['reviewSprint:S1']);
  assert.deepEqual(R({ state: 'awaitingMerge' }), []);
  assert.ok(!finished({}, undefined) && !finished({ a: { state: 'blocked', startedAt: 9 } }, 'a'));
});

test('criticalReasons', () => {
  const v = (risk: 'minor' | 'critical') => ({ pass: true, risk, issues: [] });
  const S1 = sp('S1');
  const globs = ['package.json', '**/auth/**'];
  const withSec = validatePlan({ summary: 's', sprints: [{ key: 'S1', name: 'n', stories: [{ title: 't' }] }, { key: 'S2', name: 'n', stories: [{ title: 't' }] }],
    security: [{ severity: 'low', sprint: 'S1', finding: 'meh' }, { severity: 'high', sprint: 'S1', finding: 'XSS' }, { severity: 'high', sprint: 'S2', finding: 'other' }] });
  assert.deepEqual(criticalReasons(S1, [{ lens: 'reviewer', verdict: v('minor') }], ['src/a.ts'], globs), []);
  assert.deepEqual(criticalReasons(S1, [{ lens: 'security', agent: 'sec-arch', verdict: v('critical') }, { lens: 'reviewer', verdict: v('minor') }],
    ['src/auth/x.ts', 'package.json'], globs, withSec), [
    'sec-arch flagged the sprint as critical', 'sensitive paths changed: src/auth/x.ts, package.json', 'high security finding: XSS']);
});

test('sprint review panel', () => {
  // Revalidator + security again, then every picked reviewer ('' = LexCode reviewer); legacy epics fall back to roleAgents.reviewer.
  assert.deepEqual(reviewPanel(building({ roleAgents: { security: 'sec' }, reviewers: ['qa', ''] })),
    [{ lens: 'revalidator', agent: undefined }, { lens: 'security', agent: 'sec' }, { lens: 'reviewer', agent: 'qa' }, { lens: 'reviewer', agent: undefined }]);
  assert.deepEqual(reviewPanel(building({ roleAgents: { reviewer: 'old' } })).map(r => r.agent), [undefined, undefined, 'old']);
  const m = mergeVerdicts([{ lens: 'security', agent: 'sec', verdict: { pass: false, risk: 'critical', issues: ['SQL injection in x.py:3'] } },
    { lens: 'reviewer', verdict: { pass: true, risk: 'minor', issues: [] } }]);
  assert.deepEqual(m, { pass: false, risk: 'critical', issues: ['[sec] SQL injection in x.py:3'] });
  assert.equal(mergeVerdicts([{ lens: 'reviewer', verdict: { pass: true, risk: 'minor', issues: ['nit'] } }]).pass, true);
  const p = sprintReviewPrompt(building({ branch: 'lexcode/e' }), sp('S1', { branch: 'lexcode/e--s1' }), [], '+x', 'security',
    { collaborators: [agent('sec'), agent('db')], projectPath: '/p', self: 'sec' });
  assert.match(p, /# Security sprint: S1[\s\S]*tenant\/data isolation[\s\S]*- db: db desc[\s\S]*"pass": true/);
  assert.doesNotMatch(p, /- sec:/);
});

test('builder/reviewer prompts and args', () => {
  const e = building({ roleAgents: { builder: 'dev' }, builderMode: 'auto' });
  const S = sp('S1', { branch: 'lexcode/health-e1--s1' });
  const s = st('story-1234567890', 'S1', { title: 'Route', description: 'Add GET /health', refs: ['/proj/.lexcode/epics/e1/plan.md', '/proj/src/app.ts', '/elsewhere/x.ts'], baseCommit: 'abc123456789' });
  const p = builderPrompt(e, S, s, { collaborators: [agent('dev'), agent('db')], projectPath: '/proj' });
  assert.match(p, /# Story: Route\n\nAdd GET \/health\n\nRelated files \(read them first\):\n- src\/app\.ts\n\n## Context/);
  assert.doesNotMatch(p, /elsewhere|\.lexcode/); // outside the project / not in the worktree
  assert.match(p, /- db: db desc/);
  assert.doesNotMatch(p, /- dev:/);
  assert.match(p, /already is a git worktree on branch `lexcode\/health-e1--s1`[\s\S]*commit all your changes with the message `story\(story-12\): Route`/);
  assert.match(reviewPrompt(e, S, s, '+line', { collaborators: [], projectPath: '/proj', roleBody: 'Be strict.' }),
    /^Be strict\.[\s\S]*## Diff \(abc12345\.\.\.HEAD\)\n```diff\n\+line\n```[\s\S]*"pass": true/);
  const big = reviewPrompt(e, S, s, 'x'.repeat(200_000), { collaborators: [], projectPath: '/proj' });
  assert.match(big, /diff truncated at 150000/);

  assert.deepEqual(sessionArgs(e, 'builder', 'P', {}, { mode: 'auto', agent: agent('dev'), extra: ['--settings', '{}'], name: 'n' }),
    ['--disallowedTools', 'EnterWorktree', 'ExitWorktree', '--permission-mode', 'auto', '--agent', 'dev', '--settings', '{}', '-n', 'n', 'P']);
  assert.deepEqual(sessionArgs(e, 'reviewer', 'P', { reviewer: { model: 'sonnet' } }, { mode: 'plan', extra: [], resumeId: 'sid' }),
    ['--disallowedTools', 'ExitPlanMode', 'Write', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', '--permission-mode', 'plan', '--model', 'sonnet', '--resume', 'sid', 'P']);

  assert.equal(epicBranch(epic({ title: 'Add /health — v2!' })), 'lexcode/add-health-v2-e1');
  assert.equal(sprintBranch(building(), sp('S1', { key: 'S 1' })), 'lexcode/health-e1--s-1');
});

test('worktreeArgs passes uncommitted agents/settings, skips what the worktree has', () => {
  const proj = tmp('lex-proj-'), wt = tmp('lex-wt-');
  agentFile(path.join(proj, '.claude', 'agents'), 'dev.md', 'name: dev\ndescription: builds\ntools: Read, Edit\nmodel: sonnet');
  agentFile(path.join(proj, '.claude', 'agents'), 'qa.md', 'name: qa\ndescription: reviews');
  agentFile(path.join(wt, '.claude', 'agents'), 'qa.md', 'name: qa\ndescription: committed copy');
  fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(npm test)"]}}');
  const args = worktreeArgs(proj, wt);
  assert.equal(args[0], '--agents');
  assert.deepEqual(JSON.parse(args[1]), { dev: { description: 'builds', prompt: 'body', tools: ['Read', 'Edit'], model: 'sonnet' } });
  assert.deepEqual(args.slice(2), ['--settings', '{"permissions":{"allow":["Bash(npm test)"]}}']);
  assert.deepEqual(worktreeArgs(wt, wt), []);
});

function agentFile(dir: string, file: string, fm: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), `---\n${fm}\n---\nbody`);
}

import { epicRefs, refArgs } from '../factory';

test('epic reference files: listed in every prompt, readable via a leading --add-dir', () => {
  const e = epic({ attachments: [{ id: 'a1', name: 'mock.png', file: 'a1-mock.png', mime: 'image/png' }] });
  const refs = epicRefs(e, '/att/e1');
  assert.deepEqual(refs, [path.join('/att/e1', 'a1-mock.png')]);
  assert.match(stagePrompt('planning', e, { collaborators: [], refs }), /## Reference files from the human[\s\S]*- \/att\/e1\/a1-mock\.png/);
  const sp = { id: 's', projectId: 'p1', name: 'S1', active: false, branch: 'b' };
  const st = { id: 't', projectId: 'p1', title: 'T', status: 'todo' as const };
  for (const p of [builderPrompt(e, sp, st, { collaborators: [], projectPath: '/p', refs }), reviewPrompt(e, sp, st, '', { collaborators: [], projectPath: '/p', refs }),
    sprintReviewPrompt(e, sp, [st], '', 'reviewer', { collaborators: [], projectPath: '/p', refs })]) assert.match(p, /a1-mock\.png/);
  assert.doesNotMatch(stagePrompt('planning', epic(), { collaborators: [] }), /Reference files/);
  // --add-dir is variadic: it must come first, followed by an option, never right before the prompt.
  const args = [...refArgs(e, '/att/e1'), ...stageArgs('planning', e, 'PROMPT', {})];
  assert.deepEqual(args.slice(0, 3), ['--add-dir', '/att/e1', '--disallowedTools']);
  assert.deepEqual(refArgs(epic(), '/att/e1'), []);
});
