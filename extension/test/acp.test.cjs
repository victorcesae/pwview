// ACP chats (Gemini CLI, Kiro, Copilot…): RuntimeChat driving the ACP adapter against a scripted
// fake agent (test/fake-acp.cjs): streaming, permissions from Allow / Deny, diffs, plan, Stop,
// session/load on reopen, sign-in errors.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-acp-build');
const entry = path.join(out, 'entry.ts');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(entry, `export { RuntimeChat } from ${JSON.stringify(path.join(root, 'src/runtimeChat.ts'))};\nexport { acpRuntime, ACP_AGENTS, customAcpAgents, textHunks } from ${JSON.stringify(path.join(root, 'src/runtimes/acp.ts'))};\n`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --outfile="${path.join(out, 'acp.js')}" --log-level=error`, { cwd: root });
const { RuntimeChat, acpRuntime, ACP_AGENTS, customAcpAgents, textHunks } = require(path.join(out, 'acp.js'));
const fake = path.join(__dirname, 'fake-acp.cjs');
const gemini = ACP_AGENTS.find((a) => a.id === 'gemini');

function until(chat, ok, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (ok(chat.state)) return resolve(chat.state);
      if (Date.now() - t0 > ms) return reject(new Error('timeout; state: ' + JSON.stringify({ status: chat.state.status, items: chat.state.items.map((i) => i.kind + ':' + (i.status ?? '') + ':' + (i.text ?? '').slice(0, 80)) })));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function newChat(env = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeacp-'));
  const log = path.join(dir, 'log.jsonl');
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  Object.assign(process.env, { FAKE_ACP_LOG: log, FAKE_ACP_FILE: file, FAKE_ACP_NOAUTH: '', FAKE_ACP_NOLOAD: '' }, env);
  const chat = new RuntimeChat({ runtime: acpRuntime(gemini, () => fake), cwd: dir, ...extra }, () => {});
  chat.start();
  const sent = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { chat, sent, file, dir };
}

test('acp: textHunks diffs old → new text', () => {
  assert.deepStrictEqual(textHunks('one\ntwo\nthree\n', 'one\nTWO\nthree\n'), [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', ' three'] }]);
  assert.deepStrictEqual(textHunks(null, 'a\nb'), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]);
  const big = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const changed = [...big];
  changed[1] = 'X';
  changed[18] = 'Y';
  assert.strictEqual(textHunks(big.join('\n'), changed.join('\n')).length, 2, 'far-apart changes: two hunks');
});

test('acp: custom agents from steerhouse.acpAgents', () => {
  const [a] = customAcpAgents([{ id: 'mine', label: 'Mine', command: 'my-agent', args: ['--acp'] }, { id: 'bad' }]);
  assert.deepStrictEqual(a, { id: 'acp:mine', label: 'Mine', vendor: 'other', bins: ['my-agent'], args: ['--acp'], login: 'my-agent' });
  assert.strictEqual(customAcpAgents([{ id: 'bad' }]).length, 0);
});

test('acp: a full turn, thought + message chunks, plan, permission allow then deny, diff', async () => {
  const { chat, sent, file } = newChat();
  try {
    assert.strictEqual(chat.state.runtime, 'gemini');
    assert.strictEqual(chat.state.caps.steer, false);
    assert.strictEqual(chat.state.caps.fork, false);
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'sess_fake_1' && s.models.length === 2);
    assert.strictEqual(chat.state.model, 'gemini-2.5-pro');
    assert.deepStrictEqual(chat.state.slashCommands, ['memory', 'tools']);

    chat.send('fix it', [{ data: 'data:image/png;base64,iVBORw0KGgo=', mime: 'image/png' }], 'later');
    await until(chat, (s) => s.items.some((i) => i.kind === 'permission' && i.status === 'pending'));
    assert.strictEqual(chat.state.status, 'waiting');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'thinking').text, 'Looking at the repo');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'assistant').text, 'I will run the tests.');
    assert.deepStrictEqual(chat.state.todos.map((t) => t.status), ['completed', 'in_progress']);
    const p1 = chat.state.items.find((i) => i.kind === 'permission');
    assert.strictEqual(p1.tool, 'Bash');
    assert.strictEqual(p1.summary, 'npm test');
    assert.strictEqual(p1.canAlways, true);
    chat.respond(p1.id, 'allow');
    await until(chat, (s) => s.items.filter((i) => i.kind === 'permission').length === 2 && s.status === 'waiting');
    const p2 = chat.state.items.filter((i) => i.kind === 'permission')[1];
    assert.strictEqual(p2.tool, 'Edit');
    chat.respond(p2.id, 'deny');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'assistant' && i.text === 'Done: fix it'));
    const cmd = chat.state.items.find((i) => i.kind === 'tool' && i.name === 'Bash');
    assert.strictEqual(cmd.status, 'done');
    assert.strictEqual(cmd.result, 'ok 1 tests');
    assert.strictEqual(cmd.input.command, 'npm test');
    assert.strictEqual(chat.state.items.find((i) => i.kind === 'tool' && i.name === 'Edit').status, 'error', 'denied edit failed');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\n', 'not written');

    // second turn: Allow always, the diff arrives as hunks and the file is written through fs/*
    chat.send('again', [], 'later');
    await until(chat, (s) => s.items.filter((i) => i.kind === 'permission' && i.status === 'pending').length === 1);
    chat.respond(chat.state.items.find((i) => i.kind === 'permission' && i.status === 'pending').id, 'always');
    await until(chat, (s) => s.items.filter((i) => i.kind === 'permission' && i.status === 'pending').length === 1);
    chat.respond(chat.state.items.find((i) => i.kind === 'permission' && i.status === 'pending').id, 'allow');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'assistant' && i.text === 'Done: again'));
    const edit = chat.state.items.filter((i) => i.kind === 'tool' && i.name === 'Edit')[1];
    assert.strictEqual(edit.status, 'done');
    assert.strictEqual(edit.file, file);
    assert.deepStrictEqual(edit.patch, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', ' three'] }]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\nTWO\nthree\n');

    const msgs = sent();
    assert.ok(msgs.every((m) => m.jsonrpc === '2.0'));
    const init = msgs.find((m) => m.method === 'initialize');
    assert.strictEqual(init.params.protocolVersion, 1);
    assert.deepStrictEqual(init.params.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
    const sn = msgs.find((m) => m.method === 'session/new');
    assert.deepStrictEqual(sn.params.mcpServers, []);
    const pr = msgs.find((m) => m.method === 'session/prompt');
    assert.strictEqual(pr.params.sessionId, 'sess_fake_1');
    assert.deepStrictEqual(pr.params.prompt[0], { type: 'text', text: 'fix it' });
    assert.strictEqual(pr.params.prompt[1].type, 'image');
    assert.strictEqual(pr.params.prompt[1].mimeType, 'image/png');
    assert.strictEqual(pr.params.prompt[1].data, 'iVBORw0KGgo=');
    const choices = msgs.filter((m) => !m.method && m.result?.outcome).map((m) => m.result.outcome.optionId);
    assert.deepStrictEqual(choices, ['yes', 'no', 'always', 'yes']);

    await chat.setModel('gemini-2.5-flash');
    assert.ok(sent().some((m) => m.method === 'session/set_model' && m.params.modelId === 'gemini-2.5-flash'));
  } finally {
    chat.close();
  }
});

test('acp: Stop sends session/cancel; a message sent meanwhile is queued (no steer)', async () => {
  const { chat, sent } = newChat();
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId);
    chat.send('wait here', [], 'later');
    await until(chat, (s) => s.items.some((i) => i.kind === 'assistant' && i.text === 'Working on it'));
    chat.send('afterwards', [], 'next');
    assert.strictEqual(chat.state.queue.length, 1, 'no steer: queued');
    await chat.interrupt();
    await until(chat, () => sent().some((m) => m.method === 'session/cancel' && m.id === undefined && m.params.sessionId === 'sess_fake_1'));
    await until(chat, () => sent().filter((m) => m.method === 'session/prompt').length === 2);
    assert.ok(chat.state.items.some((i) => i.kind === 'system' && i.text === 'Stopped'));
  } finally {
    chat.close();
  }
});

test('acp: reopening uses session/load and does not show the replay', async () => {
  const { chat, sent } = newChat({}, { resume: 'sess_old' });
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'sess_old');
    const r = sent().find((m) => m.method === 'session/load');
    assert.strictEqual(r.params.sessionId, 'sess_old');
    assert.ok(!sent().some((m) => m.method === 'session/new'));
    assert.ok(!chat.state.items.some((i) => i.kind === 'assistant'), 'replayed history is not shown again');
  } finally {
    chat.close();
  }
});

test('acp: an agent without loadSession starts a new session and says so', async () => {
  const { chat, sent } = newChat({ FAKE_ACP_NOLOAD: '1' }, { resume: 'sess_old' });
  try {
    await until(chat, (s) => s.status === 'idle' && s.sessionId === 'sess_fake_1');
    assert.ok(sent().some((m) => m.method === 'session/new'));
    assert.ok(chat.state.items.some((i) => i.kind === 'system' && /cannot reopen/.test(i.text)));
  } finally {
    chat.close();
  }
});

test('acp: not signed in says how to sign in, no hang', async () => {
  const { chat } = newChat({ FAKE_ACP_NOAUTH: '1' });
  try {
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'system' && /not signed in.*`gemini`/.test(i.text)));
    chat.send('hi', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'result' && i.isError && /`gemini`/.test(i.text)));
  } finally {
    chat.close();
  }
});

test('acp: a missing executable ends in an error, not a hang', async () => {
  const chat = new RuntimeChat({ runtime: acpRuntime(gemini, () => '/nonexistent/gemini-xyz'), cwd: os.tmpdir() }, () => {});
  chat.start();
  try {
    await until(chat, (s) => s.status === 'error' && /ENOENT|exited/.test(s.error));
  } finally {
    chat.close();
  }
});
