import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Board, Epic, Sprint, Story } from '../store';
import { epicView, epicNeeds, pipeline, cutHelp, SCISSORS } from '../epicView';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-ev-'));
const { readRefs } = require('../tui') as typeof import('../tui');

const epic = (stage: Epic['stage'], extra: Partial<Epic> = {}): Epic => ({ id: 'e1', projectId: 'p1', title: 'T', stage, branch: 'epic/t', ...extra });
const board = (e: Epic, sprints: Partial<Sprint>[] = [], stories: Partial<Story>[] = []): Board => ({
  projects: [{ id: 'p1', name: 'P', path: '/x' } as any], epics: [e],
  sprints: sprints.map((s, i) => ({ id: `s${i}`, projectId: 'p1', name: `S${i}`, active: false, epicId: 'e1', order: i, ...s })),
  stories: stories.map((s, i) => ({ id: `t${i}`, projectId: 'p1', title: `story ${i}`, status: 'doing', epicId: 'e1', sprintId: 's0', ...s })),
});
const keys = (b: Board, agents: any = {}, plan?: string) => Object.keys(epicView(b, b.epics[0], agents, plan).keys).sort().join('');
const rowKeys = (b: Board, agents: any = {}, i = 0) => Object.keys(epicView(b, b.epics[0], agents).rows[i].keys).sort().join('');

test('epic keys follow the stage, like the dashboard buttons', () => {
  assert.strictEqual(keys(board(epic('planning'))), 'x'); // no live session yet: nothing to attach
  assert.strictEqual(keys(board(epic('planning', { stageSessionId: 'a1' })), { a1: { state: 'working' } }), 'ax');
  assert.strictEqual(keys(board(epic('planning', { error: 'boom' }))), 'Rx');
  assert.strictEqual(keys(board(epic('awaitingPlanApproval')), {}, 'plan.md'), 'CVXvy'); // no cancel at the plan gate (reject is it)
  assert.strictEqual(keys(board(epic('ready'))), 'sx');
  assert.strictEqual(keys(board(epic('building'))), 'pwx');
  assert.strictEqual(epicView(board(epic('paused')), epic('paused'), {}).keys.p.label, 'resume');
  assert.strictEqual(keys(board(epic('awaitingPrApproval'))), 'Px');
  assert.strictEqual(keys(board(epic('awaitingPrApproval', { pending: { kind: 'pr', skill: 'git-release' } }))), 'Pux');
  assert.strictEqual(keys(board(epic('awaitingPrApproval', { pending: { kind: 'pr', busy: Date.now() } }))), 'x'); // creating: no double PR
  assert.strictEqual(keys(board(epic('done', { prUrl: 'https://x/pr/1' }))), 'Ao');
  assert.strictEqual(keys(board(epic('cancelled'))), 'r');
  assert.strictEqual(keys(board(epic('failed'))), 'rx');
});

test('sprint rows offer the actions for their state', () => {
  const e = epic('building');
  assert.strictEqual(rowKeys(board(e, [{ state: 'awaitingMerge', critical: ['package.json'] }])), 'bm');
  assert.strictEqual(rowKeys(board(e, [{ state: 'building', blocked: 'launch failed' }])), 'R');
  assert.strictEqual(rowKeys(board(e, [{ state: 'building' }], [{ builderSessionId: 'b1' }]), { b1: { state: 'working' } }), 'a');
  assert.strictEqual(rowKeys(board(e, [{ state: 'building' }], [{ builderSessionId: 'b1', blocked: 'review failed 3 times' }]), { b1: { state: 'idle' } }), 'RSa');
  assert.strictEqual(rowKeys(board(e, [{ state: 'fixing', sessionId: 'f1', issues: ['x'] }]), { f1: { state: 'working' } }), 'a');
  assert.strictEqual(rowKeys(board(e, [{ state: 'merged' }])), '');
  // Review panel: one row per reviewer; finished ones can't be attached.
  const rv = epicView(board(e, [{ state: 'reviewing', reviews: [{ lens: 'security', sessionId: 'r1' }, { lens: 'reviewer', verdict: { pass: true, risk: 'minor', issues: [] } }] }]),
    e, { r1: { state: 'blocked' } } as any);
  assert.deepStrictEqual(rv.rows.map(r => Object.keys(r.keys).join('')), ['', 'a', '']);
  assert.ok(rv.rows[1].needs, 'a reviewer asking for permission needs you');
});

test('epicNeeds and pipeline', () => {
  assert.ok(!epicNeeds(board(epic('building')), epic('building')));
  assert.ok(epicNeeds(board(epic('awaitingPlanApproval')), epic('awaitingPlanApproval')));
  const b = board(epic('building'), [{ state: 'building' }], [{ builderSessionId: 'b1' }]);
  assert.ok(epicNeeds(b, b.epics[0], { b1: { state: 'blocked' } } as any), 'builder permission prompt');
  assert.strictEqual(pipeline(board(epic('awaitingPlanApproval')), epic('awaitingPlanApproval')), 'Planning ✓ ─ Approval ◉ ─ Build ○ ─ Review ○ ─ PR ○');
  assert.match(pipeline(board(epic('cancelled')), epic('cancelled')), /\(cancelled\)$/);
});

test('cutHelp drops the help below the scissors and keeps markdown headings', () => {
  assert.strictEqual(cutHelp(`# Goal\nShip it\n\n${SCISSORS}\n# help`), '# Goal\nShip it');
  assert.strictEqual(cutHelp(`\n\n${SCISSORS}\n# help`), '');
});

test('readRefs checks paths and limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-refs-'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'png');
  const [r] = readRefs(' a.png ', dir);
  assert.deepStrictEqual(r, { name: 'a.png', mime: 'image/png', data: Buffer.from('png').toString('base64') });
  assert.deepStrictEqual(readRefs('', dir), []);
  assert.throws(() => readRefs('missing.txt', dir), /isn't a file/);
  assert.throws(() => readRefs('.', dir), /isn't a file/);
  assert.throws(() => readRefs(Array(21).fill('a.png').join(','), dir), /At most 20/);
});
