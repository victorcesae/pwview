#!/usr/bin/env node
// A scripted stand-in for `opencode serve`: basic auth with OPENCODE_SERVER_PASSWORD, the endpoints
// the adapter uses, and a /event SSE stream. Each prompt_async streams: reasoning, text, a bash tool
// that asks permission (permission.asked → POST /permission/:id/reply), an edit with a diff, todos,
// tokens, session.idle. POST /session/:id/abort ends the turn with MessageAbortedError.
// FAKE_OPENCODE_LOG: file that gets every request ({ method, url, body }, one JSON per line).
// FAKE_OPENCODE_NOPROVIDER=1: no providers; a prompt fails with ProviderAuthError.
const http = require('http');
const fs = require('fs');
const port = +(process.argv.find((a) => a.startsWith('--port=')) ?? '--port=0').slice(7);
const log = process.env.FAKE_OPENCODE_LOG;
const noProv = process.env.FAKE_OPENCODE_NOPROVIDER === '1';
const auth = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
const clients = new Set();
const emit = (type, properties) => {
  for (const c of clients) c.write(`data: ${JSON.stringify({ id: 'evt', type, properties })}\n\n`);
};
const waiting = new Map();
let turn = 0;
let abort;
const sid = (id) => id;

async function runTurn(S) {
  turn++;
  let aborted = false;
  const stop = new Promise((res) => (abort = () => { aborted = true; res('abort'); }));
  const msg = `msg_a${turn}`;
  const user = `msg_u${turn}`;
  emit('message.updated', { sessionID: S, info: { id: user, role: 'user', sessionID: S } });
  emit('message.part.updated', { sessionID: S, part: { id: `prt_u${turn}`, messageID: user, sessionID: S, type: 'text', text: 'echo of the prompt' } });
  emit('session.status', { sessionID: S, status: { type: 'busy' } });
  const end = () => {
    emit('session.status', { sessionID: S, status: { type: 'idle' } });
    emit('session.idle', { sessionID: S });
  };
  if (noProv) {
    emit('session.error', { sessionID: S, error: { name: 'ProviderAuthError', data: { providerID: 'x', message: 'No provider is configured' } } });
    return end();
  }
  emit('message.updated', { sessionID: S, info: { id: msg, role: 'assistant', sessionID: S, providerID: 'fake', modelID: 'm1', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } });
  const part = (p) => emit('message.part.updated', { sessionID: S, part: { messageID: msg, sessionID: S, ...p }, time: Date.now() });
  part({ id: `prt_r1_${turn}`, type: 'reasoning', text: '', time: { start: 1 } });
  emit('message.part.delta', { sessionID: S, messageID: msg, partID: `prt_r1_${turn}`, field: 'text', delta: 'Looking at the repo' });
  part({ id: `prt_r1_${turn}`, type: 'reasoning', text: 'Looking at the repo', time: { start: 1, end: 2 } });
  part({ id: `prt_t1_${turn}`, type: 'text', text: '', time: { start: 1 } });
  emit('message.part.delta', { sessionID: S, messageID: msg, partID: `prt_t1_${turn}`, field: 'text', delta: 'I will run ' });
  emit('message.part.delta', { sessionID: S, messageID: msg, partID: `prt_t1_${turn}`, field: 'text', delta: 'the tests.' });
  part({ id: `prt_t1_${turn}`, type: 'text', text: 'I will run the tests.', time: { start: 1, end: 2 } });
  const input = { command: 'npm test', description: 'run tests' };
  part({ id: `prt_b1_${turn}`, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending', input: {}, raw: '' } });
  part({ id: `prt_b1_${turn}`, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'running', input, time: { start: 1 } } });
  const perm = `per_${turn}`;
  const replied = new Promise((res) => waiting.set(perm, res));
  emit('permission.asked', { id: perm, sessionID: S, permission: 'bash', patterns: ['npm test'], metadata: { command: 'npm test' }, always: ['npm *'], tool: { messageID: msg, callID: 'c1' } });
  const r = await Promise.race([replied, stop]);
  if (r === 'abort' || aborted) {
    part({ id: `prt_b1_${turn}`, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', input, error: 'Tool execution aborted', time: { start: 1, end: 2 } } });
    emit('session.error', { sessionID: S, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } });
    return end();
  }
  emit('permission.replied', { sessionID: S, requestID: perm, reply: r });
  if (r === 'reject') part({ id: `prt_b1_${turn}`, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', input, error: 'The user rejected permission to use this specific tool call.', time: { start: 1, end: 2 } } });
  else part({ id: `prt_b1_${turn}`, type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input, output: 'ok 1 tests\n', title: 'npm test', metadata: { exit: 0 }, time: { start: 1, end: 2 } } });
  const diff = 'Index: /w/a.txt\n===================================================================\n--- /w/a.txt\n+++ /w/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n';
  const ein = { filePath: '/w/a.txt', oldString: 'two', newString: 'TWO' };
  part({ id: `prt_e1_${turn}`, type: 'tool', tool: 'edit', callID: 'c2', state: { status: 'running', input: ein, time: { start: 1 } } });
  part({ id: `prt_e1_${turn}`, type: 'tool', tool: 'edit', callID: 'c2', state: { status: 'completed', input: ein, output: 'Edit applied successfully.', title: 'a.txt', metadata: { diff }, time: { start: 1, end: 2 } } });
  part({ id: `prt_td_${turn}`, type: 'tool', tool: 'todowrite', callID: 'c3', state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 1, end: 2 } } });
  emit('todo.updated', { sessionID: S, todos: [{ content: 'Run tests', status: 'completed', priority: 'high' }, { content: 'Fix a.txt', status: 'in_progress', priority: 'high' }] });
  part({ id: `prt_t2_${turn}`, type: 'text', text: `Done (${r})`, time: { start: 1, end: 2 } });
  emit('message.updated', { sessionID: S, info: { id: msg, role: 'assistant', sessionID: S, providerID: 'fake', modelID: 'm1', cost: 0.01, tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } } } });
  end();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (log) fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined }) + '\n');
    if (req.headers.authorization !== auth) {
      res.writeHead(401);
      return res.end('unauthorized');
    }
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const u = req.url.split('?')[0];
    let m;
    if (u === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }
    if (u === '/global/health') return json({ healthy: true, version: 'fake' });
    if (u === '/session' && req.method === 'POST') return json({ id: 'ses_fake1', directory: process.cwd(), title: 'New session' });
    if ((m = /^\/session\/([^/]+)$/.exec(u)) && req.method === 'GET') return m[1].startsWith('ses') ? json({ id: m[1], model: { id: 'm2', providerID: 'fake' } }) : json({ name: 'NotFoundError' }, 404);
    if (u === '/config/providers') return json(noProv ? { providers: [], default: {} } : { providers: [{ id: 'fake', name: 'Fake', models: { m1: { id: 'm1', name: 'Model One' }, m2: { id: 'm2', name: 'Model Two' } } }], default: { fake: 'm1' } });
    if ((m = /^\/session\/([^/]+)\/prompt_async$/.exec(u))) {
      res.writeHead(204);
      res.end();
      return void runTurn(sid(m[1]));
    }
    if ((m = /^\/session\/([^/]+)\/abort$/.exec(u))) {
      abort?.();
      return json(true);
    }
    if ((m = /^\/permission\/([^/]+)\/reply$/.exec(u))) {
      const w = waiting.get(m[1]);
      waiting.delete(m[1]);
      w?.(JSON.parse(body).reply);
      return json(!!w);
    }
    json({ name: 'NotFound' }, 404);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => process.exit(0));
