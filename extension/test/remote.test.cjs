// Phone view server: nothing without the key; the key moves from the link into a cookie; sessions,
// a conversation and sending (Steer / Queue / Send now) work with it.
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-remote-build');
execSync(`npx esbuild src/remote.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const Rm = require(path.join(out, 'remote.js'));

const session = (id, title, updated, events = []) => ({ info: { id, title, project: '/home/me/app', state: 'idle', updated, model: 'claude-opus-5-5' }, t: { events } });
const sessions = [
  session('s1', 'Older', '2026-11-01T10:00:00Z', [{ ts: '1', kind: 'prompt', text: 'hi' }]),
  session('s2', 'Newer', '2026-11-08T10:00:00Z', [
    { ts: '1', kind: 'prompt', text: 'fix the bug' },
    { ts: '2', kind: 'tool', text: 'Edit app.ts', tool: 'Edit' },
    { ts: '3', kind: 'text', text: 'sub-agent note', agentId: 'a1' },
    { ts: '4', kind: 'text', text: 'Done.' },
  ]),
];

test('remote: key required, moved into a cookie, then sessions / detail / send work', async () => {
  const sent = [];
  const srv = new Rm.RemoteServer({ sessions: () => sessions, send: async (id, text, mode) => (sent.push({ id, text, mode }), 'steered') });
  const port = await srv.start('127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.strictEqual((await fetch(base + '/api/sessions')).status, 401, 'no key');
    assert.strictEqual((await fetch(base + '/api/sessions', { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'wrong key');

    const first = await fetch(`${base}/?k=${srv.key}`, { redirect: 'manual' });
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.get('location'), '/', 'the key leaves the address bar');
    const cookie = first.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const h = { cookie: cookie.split(';')[0] };

    const page = await fetch(base + '/', { headers: h });
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /<title>AgentLens<\/title>/);

    const list = await (await fetch(base + '/api/sessions', { headers: h })).json();
    assert.deepStrictEqual(list.map((s) => s.title), ['Newer', 'Older'], 'newest first');
    assert.strictEqual(list[0].project, 'app');

    const d = await (await fetch(base + '/api/sessions/s2', { headers: h })).json();
    assert.deepStrictEqual(d.events.map((e) => e.text), ['fix the bug', 'Edit app.ts', 'Done.'], 'sub-agent lines left out');
    assert.strictEqual((await fetch(base + '/api/sessions/nope', { headers: h })).status, 404);

    const r = await fetch(base + '/api/sessions/s2/message', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'also add a test', mode: 'now' }) });
    assert.deepStrictEqual(await r.json(), { result: 'steered' });
    assert.deepStrictEqual(sent, [{ id: 's2', text: 'also add a test', mode: 'now' }]);
    const bad = await fetch(base + '/api/sessions/s2/message', { method: 'POST', headers: h, body: JSON.stringify({ text: '  ' }) });
    assert.strictEqual(bad.status, 400);
    const odd = await fetch(base + '/api/sessions/s2/message', { method: 'POST', headers: h, body: JSON.stringify({ text: 'x', mode: 'rm -rf' }) });
    assert.strictEqual(odd.status, 200);
    assert.strictEqual(sent.at(-1).mode, 'steer', 'unknown modes fall back to Steer');
  } finally {
    await srv.stop();
  }
  assert.ok(!srv.running);
});

test('remote: key comparison and where the key is read from', () => {
  assert.ok(Rm.sameKey('abc', 'abc') && !Rm.sameKey('abc', 'abd') && !Rm.sameKey('abc', 'abcd'));
  assert.strictEqual(Rm.keyFrom({ headers: { authorization: 'Bearer K1' } }), 'K1');
  assert.strictEqual(Rm.keyFrom({ headers: { cookie: 'x=1; al=K2' } }), 'K2');
  assert.strictEqual(Rm.keyFrom({ headers: {}, url: '/?k=K3' }), 'K3');
  assert.strictEqual(Rm.keyFrom({ headers: {}, url: '/' }), undefined);
});

test('remote: Stop returns even while a phone keeps a connection open', async () => {
  const http = require('http');
  const srv = new Rm.RemoteServer({ sessions: () => [], send: async () => '' });
  const port = await srv.start('127.0.0.1');
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/sessions', agent, headers: { Authorization: 'Bearer ' + srv.key } }, (res) => (res.resume(), res.on('end', resolve))));
  const t0 = Date.now();
  await Promise.race([srv.stop(), new Promise((_, reject) => setTimeout(() => reject(new Error('Stop hung on a keep-alive connection')), 3000))]);
  assert.ok(Date.now() - t0 < 3000);
  agent.destroy();
});
