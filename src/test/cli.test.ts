import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { Store } from '../store';

const CLI = path.join(__dirname, '..', 'cli.js');

test('Store.projectFor picks the deepest tracked project containing the folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-pf-'));
  const store = new Store(path.join(dir, 'board.json'));
  const outer = store.add('projects', { name: 'outer', path: '/w/app' } as any);
  const inner = store.add('projects', { name: 'inner', path: '/w/app/packages/ui' } as any);
  assert.strictEqual(store.projectFor('/w/app')?.id, outer.id);
  assert.strictEqual(store.projectFor('/w/app/src')?.id, outer.id);
  assert.strictEqual(store.projectFor('/w/app/packages/ui/src')?.id, inner.id);
  assert.strictEqual(store.projectFor('/w/application'), undefined); // prefix, not a parent
  assert.strictEqual(store.projectFor('/elsewhere'), undefined);
});

// A git repo tracked on a temp board, and a fake claude: `--bg` prints a short id, `agents --json --all` lists it.
function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-cli-')));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo'), board = path.join(dir, 'board.json');
  fs.mkdirSync(path.join(home, '.lexcode'), { recursive: true });
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh
if [ "$1" = "--bg" ]; then echo "backgrounded · abc123"; exit 0; fi
if [ "$1" = "agents" ]; then echo '[{"kind":"background","id":"abc123","sessionId":"s-abc123","state":"working"}]'; exit 0; fi
exit 1
`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.lexcode', 'settings.json'), JSON.stringify({ 'lexCode.claudePath': claude }));
  fs.writeFileSync(board, JSON.stringify({
    projects: [{ id: 'p1', name: 'repo', path: repo }],
    epics: [{ id: 'busy', projectId: 'p1', title: 'Other', stage: 'building', branch: 'epic/other' }], sprints: [], stories: [],
  }));
  const run = (args: string[], input?: string) => spawnSync(process.execPath, [CLI, ...args],
    { cwd: path.join(repo), input, encoding: 'utf8', env: { ...process.env, HOME: home, LEXCODE_BOARD: board } });
  return { dir, repo, board, run, read: () => JSON.parse(fs.readFileSync(board, 'utf8')) };
}

test('lexcode epic new --from - starts planning and hands the lock back', () => {
  const t = setup();
  const r = t.run(['epic', 'new', '--from', '-', '--json'], JSON.stringify({ title: 'Add hello.txt', description: "it's \"quoted\" $(nope)" }));
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const b = t.read(), epic = b.epics.find((e: any) => e.id === out.epicId);
  assert.strictEqual(epic.stage, 'planning');
  assert.strictEqual(epic.stageSessionId, 's-abc123');
  assert.strictEqual(epic.description, "it's \"quoted\" $(nope)");
  assert.strictEqual(epic.builderMode, 'acceptEdits');
  assert.ok(epic.branch && out.branch === epic.branch);
  assert.deepStrictEqual(b.epics.find((e: any) => e.id === 'busy'), { id: 'busy', projectId: 'p1', title: 'Other', stage: 'building', branch: 'epic/other' });
  const locks = path.join(t.dir, 'locks');
  assert.deepStrictEqual(fs.existsSync(locks) ? fs.readdirSync(locks) : [], [], 'no lock left behind');
});

test('lexcode epic new flags, and bad input exits 1 without creating anything', () => {
  const t = setup();
  const ok = t.run(['epic', 'new', t.repo, '--title', 'Flags', '--description', 'd', '--mode', 'auto', '--builder-model', 'haiku']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Planning "Flags"/);
  const e = t.read().epics.find((x: any) => x.title === 'Flags');
  assert.strictEqual(e.builderMode, 'auto');
  assert.deepStrictEqual(e.models, { builder: { model: 'haiku' } });

  const count = t.read().epics.length;
  for (const [args, input, msg] of [
    [['--from', '-'], '{"description":"no title"}', /title is required/i],
    [['--from', '-'], '{"title":"x","targetBranch":"../evil"}', /Invalid target branch/],
    [['--from', '-'], 'not json', /invalid JSON/],
    [['--from', '-'], '{"title":"x","builderMode":"bypassPermissions"}', /builderMode/],
    [['--title', 'x', '--mode', 'yolo'], undefined, /--mode/],
    [['--title', 'x', '--bogus', '1'], undefined, /Unknown option --bogus/],
    [['/', '--title', 'x'], undefined, /is not a LexCode project/],
  ] as [string[], string | undefined, RegExp][]) {
    const r = t.run(['epic', 'new', ...args], input);
    assert.strictEqual(r.status, 1, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stderr, msg);
  }
  assert.strictEqual(t.read().epics.length, count);
});

test('lexcode --version prints the package version', () => {
  const r = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.strictEqual(r.stdout.trim(), require('../../package.json').version);
});
