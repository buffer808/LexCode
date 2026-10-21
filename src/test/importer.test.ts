import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Store } from '../store';
import { findTasksFile, parseTasks, importInto, syncSource } from '../importer';

test('skip list is configurable; dot-folders scanned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-skip-'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'TASKS.md'), '- [ ] a');
  assert.equal(findTasksFile(root), path.join(root, '.claude', 'TASKS.md'));
  assert.equal(findTasksFile(root, ['.claude']), undefined);
});

test('finds nested TASKS.md, follows links, imports idempotently', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-imp-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'TASKS.md'), '- [ ] wrong');
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, 'tasks.md'), [
    '# Tasks', '- [Epics](epics.md)', '- [Sprints](./sprints.md)', '- [Backlog](backlog.md)', '- [Old](archive.md)', '- [ ] Loose task',
  ].join('\n'));
  fs.writeFileSync(path.join(docs, 'epics.md'), '# Epics\n## Auth\n- [ ] Login\n  - with OAuth\n- [x] Logout\n## Billing\n## Search\n- [x] Index\n## Legacy (archived)\n- [ ] Old thing\n### Notes\n- [ ] still old\n## Reports\n- [ ] Export\n');
  fs.writeFileSync(path.join(docs, 'sprints.md'), '## Sprint 1\n- [ ] Signup\n- [~] login\n- ~~Dropped~~\n- Shipped (done)\n## Sprint 0 ✅\n- [ ] ancient\n');
  fs.writeFileSync(path.join(docs, 'archive.md'), '- [ ] Archived story\n');
  fs.writeFileSync(path.join(docs, 'backlog.md'), '- Invoices\n- [Tasks](tasks.md)\n');

  const file = findTasksFile(root)!;
  assert.equal(file, path.join(docs, 'tasks.md'));
  const parsed = parseTasks(file);
  assert.deepEqual(parsed.epics, ['Auth', 'Billing', 'Reports']); // Search all done, Legacy archived
  assert.deepEqual(parsed.sprints, ['Sprint 1']);
  assert.deepEqual(parsed.stories.map(s => s.title), ['Loose task', 'Login', 'Export', 'Signup', 'login', 'Invoices']);
  assert.equal(parsed.stories[4].status, 'doing');
  assert.equal(parsed.stories[1].description, '- with OAuth');

  const store = new Store(path.join(root, 'board.json'));
  const p = store.add('projects', { name: 'x', path: root });
  assert.deepEqual(importInto(store, p.id, parsed), { epics: 3, sprints: 1, stories: 5 }); // "login" dup of "Login"
  const login = store.all().stories.find(s => s.title === 'Login')!;
  assert.equal(login.epicId, store.all().epics.find(e => e.title === 'Auth')!.id);
  assert.ok(store.all().stories.find(s => s.title === 'Signup')!.sprintId);
  assert.deepEqual(importInto(store, p.id, parsed), { epics: 0, sprints: 0, stories: 0 });
});

test('format from reviewPrompt round-trips through parseTasks', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lex-rev-')), 'import.md');
  fs.writeFileSync(f, '## Epic: Auth\n- [ ] Login\n  - OAuth\n## Sprint 2\n- [~] Signup\n## Backlog\n- [ ] Invoices\n');
  const p = parseTasks(f);
  assert.deepEqual(p.epics, ['Auth']);
  assert.deepEqual(p.sprints, ['Sprint 2']);
  assert.deepEqual(p.stories.map(s => [s.title, s.status, s.sprint ?? null]),
    [['Login', 'todo', null], ['Signup', 'doing', 'Sprint 2'], ['Invoices', 'todo', null]]);
  assert.equal(p.stories[0].description, '- OAuth');
});

test('stories record source + refs; status writes back to the checkbox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-sync-'));
  const tasks = path.join(dir, 'TASKS.md'), epics = path.join(dir, 'epics.md'), stories = path.join(dir, 'stories.md');
  fs.writeFileSync(tasks, '- [Epics](epics.md)\n- [Stories](stories.md)\n');
  fs.writeFileSync(epics, '## Auth\n');
  fs.writeFileSync(stories, '## Epic: Auth\n- Login page\n- [ ] Logout\n');
  const parsed = parseTasks(tasks);
  const login = parsed.stories.find(s => s.title === 'Login page')!;
  assert.deepEqual(login.source, { file: stories, line: 2 });
  assert.deepEqual(login.refs, [tasks, stories, epics]);

  const store = new Store(path.join(dir, 'board.json'), s => { syncSource(s); });
  const p = store.add('projects', { name: 'x', path: dir });
  importInto(store, p.id, parsed);
  fs.writeFileSync(stories, '# moved\n## Epic: Auth\n- Login page\n- [ ] Logout\n'); // line shifted
  const ids = Object.fromEntries(store.all().stories.map(s => [s.title, s.id]));
  store.update('stories', ids['Login page'], { status: 'done' });
  store.update('stories', ids['Logout'], { status: 'doing' });
  assert.equal(fs.readFileSync(stories, 'utf8'), '# moved\n## Epic: Auth\n- [x] Login page\n- [~] Logout\n');

  fs.writeFileSync(path.join(dir, 'import.md'), `## Epic: Auth\n- [ ] Logout <!-- src: ${stories}:4 -->\n`);
  const rev = parseTasks(path.join(dir, 'import.md')).stories[0];
  assert.equal(rev.title, 'Logout');
  assert.deepEqual(rev.source, { file: stories, line: 4 });
});
