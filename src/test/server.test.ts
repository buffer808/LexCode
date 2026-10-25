import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { WebSocket } from 'ws';

// ui-token lives under ~/.lexcode: point HOME at a temp dir before server.ts loads.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexcode-ui-'));
process.env.HOME = tmp;
const { serve } = require('../server') as typeof import('../server');

const get = (port: number, p: string, headers: Record<string, string> = {}) => new Promise<http.IncomingMessage>((resolve, reject) =>
  http.get({ host: '127.0.0.1', port, path: p, headers }, r => { r.resume(); resolve(r); }).on('error', reject));

const ws = (port: number, p: string, headers: Record<string, string>) => new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers });
const firstMessage = (s: WebSocket) => new Promise<string>((resolve, reject) => { s.once('message', d => resolve(String(d))); s.once('error', reject); });

test('lexcode ui: auth, origin and path checks; board over websocket', async () => {
  const board = path.join(tmp, 'board.json');
  fs.writeFileSync(board, JSON.stringify({ projects: [{ id: 'p1', name: 'demo', path: tmp }], epics: [], sprints: [], stories: [] }));
  const { port, secret, close } = await serve(board, { port: 0, open: false });
  const origin = `http://127.0.0.1:${port}`, cookie = `lexcode=${secret}`;
  try {
    assert.strictEqual((await get(port, '/')).statusCode, 401);
    assert.strictEqual((await get(port, '/', { cookie: 'lexcode=wrong' })).statusCode, 401);
    const login = await get(port, `/?t=${secret}`);
    assert.strictEqual(login.statusCode, 302);
    assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.strictEqual((await get(port, '/', { cookie })).statusCode, 200);
    assert.strictEqual((await get(port, '/media/vendor/marked.umd.js', { cookie })).statusCode, 200);
    assert.strictEqual((await get(port, '/', { cookie, host: 'evil.example' })).statusCode, 403); // DNS rebinding
    assert.strictEqual((await get(port, '/media/..%2Fpackage.json', { cookie })).statusCode, 404);
    assert.strictEqual((await get(port, '/media/../package.json', { cookie })).statusCode, 404);

    const foreign = ws(port, '/ws', { cookie, origin: 'http://evil.example' });
    await assert.rejects(new Promise((resolve, reject) => { foreign.once('open', resolve); foreign.once('error', reject); }));

    const s = ws(port, '/ws', { cookie, origin });
    await new Promise(r => s.once('open', r));
    s.send(JSON.stringify({ type: 'ready' }));
    const m = JSON.parse(await firstMessage(s));
    assert.strictEqual(m.type, 'board');
    assert.strictEqual(m.board.projects[0].name, 'demo');
    assert.strictEqual(m.attachBase, '/attachments');
    s.close();

    // The browser can't name a command: an id the server never queued only gets an error.
    const t = ws(port, '/pty?id=nope', { cookie, origin });
    assert.match(await firstMessage(t), /expired/);
  } finally { close(); }
});
