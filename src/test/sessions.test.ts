import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listSessions, sessionDir, sessionTitle, sessionExists, editedFiles, finalMessage, turnEnded } from '../sessions';

const rec = (o: object) => JSON.stringify(o);

test('title priority: custom > ai > first real prompt', () => {
  const user = (content: unknown, extra = {}) => rec({ type: 'user', message: { content }, ...extra });
  const base = [user('<command-name>/x</command-name>'), user('meta', { isMeta: true }),
    user([{ type: 'text', text: 'fix login\nmore' }]), '{"partial'];
  assert.equal(sessionTitle(base.join('\n')), 'fix login');
  assert.equal(sessionTitle([...base, rec({ type: 'ai-title', aiTitle: 'AI' })].join('\n')), 'AI');
  assert.equal(sessionTitle([...base, rec({ type: 'ai-title', aiTitle: 'AI' }), rec({ type: 'custom-title', customTitle: 'Mine' })].join('\n')), 'Mine');
  assert.equal(sessionTitle(''), '(untitled)');
});

test('lists sessions for project path, newest first', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const proj = '/Users/me/My Proj.v2';
  const dir = sessionDir(proj, home);
  assert.ok(dir.endsWith('-Users-me-My-Proj-v2'));
  assert.deepEqual(listSessions(proj, home), []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.jsonl'), rec({ type: 'ai-title', aiTitle: 'Old' }));
  fs.writeFileSync(path.join(dir, 'new.jsonl'), rec({ type: 'ai-title', aiTitle: 'New' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  fs.utimesSync(path.join(dir, 'old.jsonl'), 1, 1);
  assert.deepEqual(listSessions(proj, home).map(s => [s.id, s.title]), [['new', 'New'], ['old', 'Old']]);
  assert.ok(sessionExists(proj, 'new', home) && !sessionExists(proj, 'nope', home));
});

test('editedFiles aggregates successful edits across sessions', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const dir = sessionDir('/p', home);
  fs.mkdirSync(dir, { recursive: true });
  const use = (id: string, name: string, input: object, ts: string) =>
    rec({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, is_error = false) => rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    use('1', 'Edit', { file_path: '/p/a.ts' }, '2026-01-01T00:00:00Z'), result('1'),
    use('2', 'Write', { file_path: '/p/b.ts' }, '2026-01-02T00:00:00Z'), result('2', true), // rejected
    use('3', 'Read', { file_path: '/p/c.ts' }, '2026-01-02T00:00:00Z'),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 's2.jsonl'), use('4', 'Edit', { file_path: '/p/a.ts' }, '2026-01-03T00:00:00Z'));
  const r = editedFiles('/p', ['s1', 's2', 'missing'], home);
  assert.deepEqual(r.map(e => [e.file, e.edits, e.sessionIds]), [['/p/a.ts', 2, ['s1', 's2']]]);
  assert.equal(r[0].last, Date.parse('2026-01-03T00:00:00Z'));
});

test('finalMessage returns last main-thread assistant text', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const dir = sessionDir('/p', home);
  fs.mkdirSync(dir, { recursive: true });
  const say = (content: unknown, extra = {}) => rec({ type: 'assistant', message: { content }, ...extra });
  fs.writeFileSync(path.join(dir, 's.jsonl'), [
    say([{ type: 'text', text: 'first' }]),
    say([{ type: 'text', text: 'plan:' }, { type: 'text', text: '```json\n{}\n```' }]),
    say([{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
    say([{ type: 'tool_use', id: 'x', name: 'Read', input: {} }]), // no text: skipped
    '{"partial',
  ].join('\n'));
  assert.equal(finalMessage('/p', 's', home), 'plan:\n```json\n{}\n```');
  assert.equal(finalMessage('/p', 'missing', home), undefined);
});

test('finalMessage since: ignores replies older than the current run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const dir = sessionDir('/p', home);
  fs.mkdirSync(dir, { recursive: true });
  const say = (text: string, ts: string) => rec({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });
  fs.writeFileSync(path.join(dir, 's.jsonl'), say('old', '2026-01-01T00:00:00Z'));
  const since = Date.parse('2026-01-02T00:00:00Z');
  assert.equal(finalMessage('/p', 's', home, since), undefined);
  fs.appendFileSync(path.join(dir, 's.jsonl'), '\n' + say('new', '2026-01-03T00:00:00Z'));
  assert.equal(finalMessage('/p', 's', home, since), 'new');
});

test('turnEnded: finished turn vs waiting mid-turn on a permission prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-home-'));
  const dir = sessionDir('/p', home);
  fs.mkdirSync(dir, { recursive: true });
  const write = (...lines: object[]) => fs.writeFileSync(path.join(dir, 's.jsonl'), lines.map(rec).join('\n') + '\n');
  const ask = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash' }] } };
  write({ type: 'user', message: { content: 'go' } }, ask);
  assert.equal(turnEnded('/p', 's', home), false);
  write(ask, { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }, { type: 'system', subtype: 'turn_duration' }, { type: 'ai-title', aiTitle: 'x' });
  assert.equal(turnEnded('/p', 's', home), true);
  write({ type: 'system', subtype: 'turn_duration' }, { type: 'user', message: { content: 'follow-up' } });
  assert.equal(turnEnded('/p', 's', home), false);
  assert.equal(turnEnded('/p', 'missing', home), false);
});
