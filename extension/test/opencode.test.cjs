// OpenCode chats: RuntimeChat driving the `opencode serve` adapter against a scripted fake server
// (test/fake-opencode.cjs): basic auth, SSE streaming, permissions (once / always / reject), diffs,
// todos, Stop (abort), reopening a session, no provider.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-opencode-build');
const entry = path.join(out, 'entry.ts');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(entry, `export { RuntimeChat } from ${JSON.stringify(path.join(root, 'src/runtimeChat.ts'))};\nexport { opencodeRuntime } from ${JSON.stringify(path.join(root, 'src/runtimes/opencode.ts'))};\n`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --outfile="${path.join(out, 'opencode.js')}" --log-level=error`, { cwd: root });
const { RuntimeChat, opencodeRuntime } = require(path.join(out, 'opencode.js'));
const fake = path.join(__dirname, 'fake-opencode.cjs');

function until(chat, ok, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (ok(chat.state)) return resolve(chat.state);
      if (Date.now() - t0 > ms) return reject(new Error('timeout; state: ' + JSON.stringify({ status: chat.state.status, error: chat.state.error, sid: chat.state.sessionId, models: chat.state.models, items: chat.state.items.map((i) => i.kind + ':' + (i.status ?? '') + ':' + (i.text ?? i.name ?? '')) })));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function newChat(opts = {}, env = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakeopencode-')), 'log.jsonl');
  Object.assign(process.env, { FAKE_OPENCODE_LOG: log, FAKE_OPENCODE_NOPROVIDER: '' }, env);
  const chat = new RuntimeChat({ runtime: opencodeRuntime(() => fake), cwd: os.tmpdir(), ...opts }, () => {});
  chat.start();
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { chat, sent };
}

const perm = (s) => s.items.find((i) => i.kind === 'permission' && i.status === 'pending');

test('opencode: a full turn, permission allowed, edit diff, todos, model list', async () => {
  const { chat, sent } = newChat();
  try {
    assert.strictEqual(chat.state.runtime, 'opencode');
    assert.strictEqual(chat.state.caps.steer, false);
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'ses_fake1' && s.models.length === 2);
    assert.strictEqual(chat.state.model, 'fake/m1');
    assert.deepStrictEqual(chat.state.models[1], { value: 'fake/m2', displayName: 'Fake · Model Two' });
    chat.send('fix it', [{ data: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png' }], 'later');
    await until(chat, (s) => !!perm(s));
    assert.strictEqual(chat.state.status, 'waiting');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'thinking').text, 'Looking at the repo');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'assistant').text, 'I will run the tests.');
    assert.ok(!chat.state.items.some((i) => i.kind === 'assistant' && i.text === 'echo of the prompt'), "the user's own parts are not echoed");
    const p = perm(chat.state);
    assert.strictEqual(p.tool, 'Bash');
    assert.strictEqual(p.summary, 'npm test');
    chat.respond(p.id, 'allow');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'assistant' && i.text === 'Done (once)'));
    const s = chat.state;
    const bash = s.items.find((i) => i.kind === 'tool' && i.name === 'Bash');
    assert.strictEqual(bash.status, 'done');
    assert.match(bash.result, /ok 1 tests/);
    assert.strictEqual(bash.input.command, 'npm test');
    const edit = s.items.find((i) => i.kind === 'tool' && i.name === 'Edit');
    assert.strictEqual(edit.status, 'done');
    assert.strictEqual(edit.file, '/w/a.txt');
    assert.deepStrictEqual(edit.patch, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+TWO'] }]);
    assert.ok(!s.items.some((i) => i.kind === 'tool' && i.name === 'todowrite'), 'todos go to the panel, not a row');
    assert.deepStrictEqual(s.todos.map((t) => t.status), ['completed', 'in_progress']);
    assert.strictEqual(s.tokens, 1500);

    const reqs = sent();
    const pr = reqs.find((r) => /prompt_async$/.test(r.url));
    assert.strictEqual(pr.url, '/session/ses_fake1/prompt_async');
    assert.deepStrictEqual(pr.body.parts[0], { type: 'text', text: 'fix it' });
    assert.strictEqual(pr.body.parts[1].type, 'file');
    assert.match(pr.body.parts[1].url, /^data:image\/png;base64,/);
    assert.deepStrictEqual(pr.body.model, { providerID: 'fake', modelID: 'm1' });
    assert.deepStrictEqual(reqs.find((r) => /\/permission\//.test(r.url)).body, { reply: 'once' });
  } finally {
    chat.close();
  }
});

test('opencode: Deny rejects, Allow always = always, messages queue while working', async () => {
  const { chat, sent } = newChat();
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId);
    chat.send('first', [], 'later');
    await until(chat, (s) => !!perm(s));
    chat.send('second', [], 'next');
    assert.strictEqual(chat.state.queue.length, 1, 'no steer: it waits for the turn');
    chat.respond(perm(chat.state).id, 'deny', 'not now');
    await until(chat, (s) => s.items.some((i) => i.kind === 'assistant' && i.text === 'Done (reject)'));
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'tool' && i.name === 'Bash').status, 'error');
    assert.deepStrictEqual(sent().find((r) => /\/permission\//.test(r.url)).body, { reply: 'reject', message: 'not now' });
    // the queued message goes out as the next turn
    await until(chat, (s) => !!perm(s));
    chat.respond(perm(chat.state).id, 'always');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'assistant' && i.text === 'Done (always)'));
    assert.strictEqual(sent().filter((r) => /prompt_async$/.test(r.url)).length, 2);
  } finally {
    chat.close();
  }
});

test('opencode: Stop aborts the session', async () => {
  const { chat, sent } = newChat();
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId);
    chat.send('go', [], 'later');
    await until(chat, (s) => !!perm(s));
    await chat.interrupt();
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'system' && i.text === 'Stopped'));
    assert.ok(sent().some((r) => r.url === '/session/ses_fake1/abort' && r.method === 'POST'));
    assert.ok(!chat.state.items.some((i) => i.kind === 'result' && i.isError), 'an abort is not an error');
  } finally {
    chat.close();
  }
});

test('opencode: reopening gets the session by id', async () => {
  const { chat, sent } = newChat({ resume: 'ses_old' });
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'ses_old');
    assert.ok(sent().some((r) => r.method === 'GET' && r.url === '/session/ses_old'));
    assert.ok(!sent().some((r) => r.method === 'POST' && r.url === '/session'));
    assert.strictEqual(chat.state.model, 'fake/m2', "the session's own model");
  } finally {
    chat.close();
  }
});

test('opencode: no provider says how to add one, no hang', async () => {
  const { chat } = newChat({}, { FAKE_OPENCODE_NOPROVIDER: '1' });
  try {
    await until(chat, (s) => s.items.some((i) => i.kind === 'system' && /opencode auth login/.test(i.text)));
    chat.send('hi', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'result' && i.isError && /opencode auth login/.test(i.text)));
  } finally {
    chat.close();
  }
});

test('opencode: a missing executable ends in an error, not a hang', async () => {
  const chat = new RuntimeChat({ runtime: opencodeRuntime(() => '/nonexistent/opencode-xyz'), cwd: os.tmpdir() }, () => {});
  chat.start();
  try {
    await until(chat, (s) => s.status === 'error' && /ENOENT|exited/.test(s.error));
  } finally {
    chat.close();
  }
});
