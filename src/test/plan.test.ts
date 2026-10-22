import { test } from 'node:test';
import * as assert from 'node:assert';
import { extractJson, validatePlan, validateVerdict, renderPlanMd } from '../plan';

const story = (title: string, extra = {}) => ({ title, ...extra });
const good = () => ({
  summary: 'Add health endpoint',
  sprints: [
    { key: 'S1', name: 'Core', dependsOn: [], parallel: true, stories: [story('Route', { points: 2, refs: ['src/app.ts'] })] },
    { key: 'S2', name: 'Docs', dependsOn: ['S1'], stories: [story('README')] },
  ],
  dependencies: [{ name: 'express', available: true }],
  security: [{ severity: 'medium', sprint: 'S1', story: 'Route', finding: 'Do not leak versions' }],
  extra: 'ignored',
});

test('extractJson takes the last json block, or bare JSON', () => {
  assert.deepEqual(extractJson('draft\n```json\n{"a":1}\n```\nfinal\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson(' {"a":3} '), { a: 3 });
  assert.throws(() => extractJson('no json here'), /no ```json block/);
  assert.throws(() => extractJson('```json\n{bad\n```'), /invalid JSON/);
});

test('validatePlan normalizes a good plan', () => {
  const p = validatePlan(good());
  assert.equal(p.sprints[1].parallel, false); // default sequential
  assert.deepEqual(p.reuse, []);
  assert.equal((p as any).extra, undefined);
  assert.deepEqual(p.sprints[0].stories[0], { title: 'Route', description: undefined, points: 2, refs: ['src/app.ts'] });
  assert.match(renderPlanMd('Health', p), /## S2: Docs\n\n_sequential · after S1_[\s\S]*\*\*medium\*\* \[S1\] Route: Do not leak/);
});

test('validatePlan rejects bad structure', () => {
  const bad = (mut: (p: any) => void, re: RegExp) => { const p = good(); mut(p); assert.throws(() => validatePlan(p), re); };
  bad(p => { p.sprints = []; }, /no sprints/);
  bad(p => { p.sprints[0].stories = []; }, /no stories/);
  bad(p => { p.sprints[1].key = 'S1'; }, /duplicate key/);
  bad(p => { p.sprints[1].dependsOn = ['S9']; }, /unknown sprint "S9"/);
  bad(p => { p.sprints[0].dependsOn = ['S2']; }, /cycle S1 → S2 → S1/);
  bad(p => { p.sprints[0].stories[0].title = ' '; }, /title: expected non-empty/);
  bad(p => { p.sprints[0].stories[0].points = -1; }, /points/);
  bad(p => { p.sprints[0].stories[0].refs = ['../secrets']; }, /project-relative/);
  bad(p => { p.sprints[0].stories[0].refs = ['/etc/passwd']; }, /project-relative/);
  bad(p => { p.security[0].severity = 'critical'; }, /severity/);
  bad(p => { p.security[0].sprint = 'S7'; }, /unknown sprint "S7"/);
  assert.throws(() => validatePlan([]), /plan: expected object/);
});

test('validateVerdict', () => {
  assert.deepEqual(validateVerdict({ pass: true }), { pass: true, risk: 'minor', issues: [] });
  assert.deepEqual(validateVerdict({ pass: false, risk: 'critical', issues: ['x'] }), { pass: false, risk: 'critical', issues: ['x'] });
  assert.throws(() => validateVerdict({ pass: false }), /must list issues/);
  assert.throws(() => validateVerdict({ pass: 'yes' }), /boolean/);
  assert.throws(() => validateVerdict({ pass: true, risk: 'huge' }), /minor\|critical/);
});
