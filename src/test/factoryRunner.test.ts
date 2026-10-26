import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from '../store';
import { AgentWatcher } from '../claude';
import { FactoryRunner } from '../factoryRunner';

test('driver lock: heartbeat keeps it past staleness while building, releases it at a gate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-runner-')), locks = path.join(dir, 'locks');
  const store = new Store(path.join(dir, 'board.json'));
  const p = store.add('projects', { name: 'p', path: dir } as any);
  const epic = store.add('epics', { projectId: p.id, title: 'e', stage: 'building' } as any);
  const agents = { agents: {}, onDidChange: () => ({ dispose() {} }), poll() {} } as unknown as AgentWatcher;
  const [a, b]: any[] = [new FactoryRunner(store, agents, locks, dir, () => {}, { drive: false }),
    new FactoryRunner(store, agents, locks, dir, () => {}, { drive: false })];
  const file = path.join(locks, `${epic.id}.lock`);

  assert.ok(a.lock(epic) && !b.lock(epic));
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), at: Date.now() - 55_000 }));
  a.heartbeat(); // a slow tick would have let this go stale
  assert.ok(Date.now() - JSON.parse(fs.readFileSync(file, 'utf8')).at < 1000);
  assert.ok(!b.lock(epic));

  store.update('epics', epic.id, { stage: 'awaitingPlanApproval' });
  a.heartbeat();
  assert.ok(!fs.existsSync(file) && b.lock(epic), 'the other window can act on the gate at once');
});
