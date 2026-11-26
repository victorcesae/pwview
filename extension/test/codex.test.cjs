// Codex chats: RuntimeChat driving the Codex app-server adapter against a scripted fake server
// (test/fake-codex.cjs): streaming, approvals answered from Allow / Deny, diffs, plan, steer, stop.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-codex-build');
const entry = path.join(out, 'entry.ts');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(entry, `export { RuntimeChat } from ${JSON.stringify(path.join(root, 'src/runtimeChat.ts'))};\nexport { codexRuntime, parseHunks } from ${JSON.stringify(path.join(root, 'src/runtimes/codex.ts'))};\n`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --outfile="${path.join(out, 'codex.js')}" --log-level=error`, { cwd: root });
const { RuntimeChat, codexRuntime, parseHunks } = require(path.join(out, 'codex.js'));
const fake = path.join(__dirname, 'fake-codex.cjs');

/** waits until the chat state satisfies `ok` */
function until(chat, ok, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (ok(chat.state)) return resolve(chat.state);
      if (Date.now() - t0 > ms) return reject(new Error('timeout; state: ' + JSON.stringify({ status: chat.state.status, items: chat.state.items.map((i) => i.kind + ':' + (i.status ?? '')) })));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function newChat(env = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-')), 'log.jsonl');
  Object.assign(process.env, { FAKE_CODEX_LOG: log, FAKE_CODEX_NOAUTH: '' }, env);
  const chat = new RuntimeChat({ runtime: codexRuntime(() => fake), cwd: os.tmpdir() }, () => {});
  chat.start();
  const sent = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { chat, sent };
}

test('codex: parseHunks reads unified diffs', () => {
  const h = parseHunks('--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c\n@@ -10 +11 @@\n-z\n+Z\n');
  assert.deepStrictEqual(h, [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', '+c'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-z', '+Z'] },
  ]);
});

test('codex: a full turn through the fake app-server, approvals from Allow / Deny', async () => {
  const { chat, sent } = newChat();
  try {
    assert.strictEqual(chat.state.runtime, 'codex');
    assert.strictEqual(chat.state.caps.effort, false);
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'thr_fake_1' && s.models.length === 1);
    assert.strictEqual(chat.state.model, 'gpt-5.5-codex');
    assert.deepStrictEqual(chat.state.models, [{ value: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex' }], 'hidden models are left out');

    chat.send('fix it', [{ data: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png' }], 'later');
    assert.strictEqual(chat.state.title, 'fix it');
    // the command asks first
    await until(chat, (s) => s.items.some((i) => i.kind === 'permission' && i.status === 'pending'));
    assert.strictEqual(chat.state.status, 'waiting');
    const thinking = chat.state.items.find((i) => i.kind === 'thinking');
    assert.strictEqual(thinking.text, 'Looking at the repo');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'assistant').text, 'I will run the tests.');
    const p1 = chat.state.items.find((i) => i.kind === 'permission');
    assert.strictEqual(p1.tool, 'Bash');
    assert.strictEqual(p1.summary, 'npm test');
    chat.respond(p1.id, 'allow');
    // then the file change
    await until(chat, (s) => s.items.filter((i) => i.kind === 'permission').length === 2 && s.status === 'waiting');
    const p2 = chat.state.items.filter((i) => i.kind === 'permission')[1];
    assert.strictEqual(p2.tool, 'Edit');
    chat.respond(p2.id, 'deny', 'not that file');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'assistant' && i.text === 'Done: fix it'));

    const s = chat.state;
    const cmd = s.items.find((i) => i.kind === 'tool' && i.name === 'Bash');
    assert.strictEqual(cmd.status, 'done');
    assert.match(cmd.result, /ok 1 tests/);
    assert.strictEqual(cmd.input.command, 'npm test');
    const edit = s.items.find((i) => i.kind === 'tool' && i.name === 'Edit');
    assert.strictEqual(edit.status, 'error', 'declined');
    assert.strictEqual(edit.file, '/w/a.txt');
    assert.deepStrictEqual(edit.patch, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+TWO'] }]);
    assert.deepStrictEqual(s.todos.map((t) => t.status), ['completed', 'in_progress']);
    assert.strictEqual(s.tokens, 1500);
    assert.strictEqual(s.context.max, 200000);
    assert.strictEqual(chat.turns, 1);

    const msgs = sent();
    const init = msgs.find((m) => m.method === 'initialize');
    assert.strictEqual(init.params.clientInfo.name, 'steerhouse');
    assert.ok(msgs.some((m) => m.method === 'initialized' && m.id === undefined), 'initialized is a notification');
    const ts = msgs.find((m) => m.method === 'thread/start');
    assert.strictEqual(ts.params.approvalPolicy, 'on-request');
    assert.strictEqual(ts.params.sandbox, 'workspace-write');
    const turn = msgs.find((m) => m.method === 'turn/start');
    assert.strictEqual(turn.params.threadId, 'thr_fake_1');
    assert.deepStrictEqual(turn.params.input[0], { type: 'text', text: 'fix it', text_elements: [] });
    assert.strictEqual(turn.params.input[1].type, 'localImage');
    assert.ok(fs.existsSync(turn.params.input[1].path), 'the pasted image went to a file');
    const decisions = msgs.filter((m) => !m.method && m.result?.decision).map((m) => m.result.decision);
    assert.deepStrictEqual(decisions, ['accept', 'decline']);
    assert.ok(msgs.every((m) => m.jsonrpc === undefined), 'the wire leaves out "jsonrpc"');
  } finally {
    chat.close();
  }
});

test('codex: steer goes into the running turn, Stop interrupts it, Allow always = acceptForSession', async () => {
  const { chat, sent } = newChat();
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId);
    chat.send('first', [], 'later');
    await until(chat, (s) => s.items.some((i) => i.kind === 'permission' && i.status === 'pending'));
    chat.send('also check lint', [], 'next');
    chat.send('afterwards', [], 'later');
    assert.strictEqual(chat.state.queue.length, 1, 'Queue waits; steer goes in at once');
    await until(chat, () => sent().some((m) => m.method === 'turn/steer'));
    const steer = sent().find((m) => m.method === 'turn/steer');
    assert.strictEqual(steer.params.expectedTurnId, 'turn_1');
    assert.strictEqual(steer.params.input[0].text, 'also check lint');
    chat.respond(chat.state.items.find((i) => i.kind === 'permission').id, 'always');
    await until(chat, () => sent().some((m) => m.result?.decision === 'acceptForSession'));
    await until(chat, (s) => s.items.filter((i) => i.kind === 'permission').length === 2);
    await chat.interrupt();
    // the queued message goes out once the stopped turn ends
    await until(chat, () => sent().filter((m) => m.method === 'turn/start').length === 2);
    assert.ok(sent().some((m) => m.method === 'turn/interrupt' && m.params.turnId === 'turn_1'));
    assert.ok(chat.state.items.some((i) => i.kind === 'system' && i.text === 'Stopped'));
    assert.strictEqual(chat.state.queue.length, 0);
  } finally {
    chat.close();
  }
});

test('codex: reopening resumes the thread', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-')), 'log.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  const chat = new RuntimeChat({ runtime: codexRuntime(() => fake), cwd: os.tmpdir(), resume: 'thr_old' }, () => {});
  chat.start();
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'thr_old');
    const r = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.method === 'thread/resume');
    assert.strictEqual(r.params.threadId, 'thr_old');
  } finally {
    chat.close();
  }
});

test('codex: not logged in says how to log in, no hang', async () => {
  const { chat } = newChat({ FAKE_CODEX_NOAUTH: '1' });
  try {
    await until(chat, (s) => s.items.some((i) => i.kind === 'system' && /codex login/.test(i.text)));
    chat.send('hi', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'result' && i.isError && /codex login/.test(i.text)));
  } finally {
    chat.close();
  }
});

test('codex: a missing executable ends in an error, not a hang', async () => {
  const chat = new RuntimeChat({ runtime: codexRuntime(() => '/nonexistent/codex-xyz'), cwd: os.tmpdir() }, () => {});
  chat.start();
  try {
    await until(chat, (s) => s.status === 'error' && /ENOENT|exited/.test(s.error));
  } finally {
    chat.close();
  }
});
