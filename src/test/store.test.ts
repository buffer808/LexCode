import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from '../store';

test('store round-trip and cascade delete', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-')), 'board.json');
  const a = new Store(file);
  const p = a.add('projects', { name: 'x', path: '/x' });
  const s = a.add('stories', { projectId: p.id, title: 't', status: 'todo' });
  a.update('stories', s.id, { status: 'doing' });

  const b = new Store(file); // second "window"
  assert.equal(b.all().stories[0].status, 'doing');
  b.add('epics', { projectId: p.id, title: 'e' });
  a.add('sprints', { projectId: p.id, name: 's1', active: true }); // a must not drop b's epic
  assert.equal(new Store(file).all().epics.length, 1);

  a.remove('projects', p.id);
  const c = new Store(file).all();
  assert.deepEqual([c.projects.length, c.epics.length, c.sprints.length, c.stories.length], [0, 0, 0, 0]);
});

test('corrupt file throws instead of wiping', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-')), 'board.json');
  fs.writeFileSync(file, '{bad');
  assert.throws(() => new Store(file));
});

test('migrates single sessionId to sessionIds; story delete removes attachments', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-')), 'board.json');
  fs.writeFileSync(file, JSON.stringify({ projects: [], stories: [{ id: 's', projectId: 'p', title: 't', status: 'todo', sessionId: 'abc' }] }));
  const st = new Store(file);
  assert.deepEqual(st.all().stories[0].sessionIds, ['abc']);
  assert.equal('sessionId' in st.all().stories[0], false);
  fs.mkdirSync(st.attachmentsDir('s'), { recursive: true });
  fs.writeFileSync(path.join(st.attachmentsDir('s'), 'a.png'), 'x');
  st.remove('stories', 's');
  assert.equal(fs.existsSync(st.attachmentsDir('s')), false);
});

test('remove project keeping tasks restores them on re-add of same path', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-')), 'board.json');
  const st = new Store(file);
  const p = st.add('projects', { name: 'x', path: '/x' });
  const e = st.add('epics', { projectId: p.id, title: 'e' });
  const s = st.add('stories', { projectId: p.id, title: 't', status: 'doing', epicId: e.id });
  fs.mkdirSync(st.attachmentsDir(s.id), { recursive: true });
  st.remove('projects', p.id, true);
  assert.equal(st.all().stories.length, 0);
  assert.equal(fs.existsSync(st.attachmentsDir(s.id)), true);
  const q = st.add('projects', { name: 'x', path: '/x' });
  const [r] = st.all().stories;
  assert.deepEqual([r.projectId, r.epicId, r.status, st.all().epics[0].projectId], [q.id, e.id, 'doing', q.id]);
  st.remove('projects', q.id);
  st.add('projects', { name: 'x', path: '/x' });
  assert.equal(st.all().stories.length, 0); // archive consumed; plain remove deletes
});

test('removing an epic deletes its attachment folder', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-')), 'board.json');
  const st = new Store(file);
  const e = st.add('epics', { projectId: 'p', title: 'e' });
  fs.mkdirSync(st.attachmentsDir(e.id), { recursive: true });
  fs.writeFileSync(path.join(st.attachmentsDir(e.id), 'x.png'), 'x');
  st.remove('epics', e.id);
  assert.equal(fs.existsSync(st.attachmentsDir(e.id)), false);
});
