// Cursor chats: RuntimeChat driving the cursor-agent print-mode adapter against a scripted fake
// (test/fake-cursor.cjs): one process per message, --resume with the chat id, Stop kills, errors.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-cursor-build');
const entry = path.join(out, 'entry.ts');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(entry, `export { RuntimeChat } from ${JSON.stringify(path.join(root, 'src/runtimeChat.ts'))};\nexport { cursorRuntime, parseModels } from ${JSON.stringify(path.join(root, 'src/runtimes/cursor.ts'))};\n`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --outfile="${path.join(out, 'cursor.js')}" --log-level=error`, { cwd: root });
const { RuntimeChat, cursorRuntime, parseModels } = require(path.join(out, 'cursor.js'));
const fake = path.join(__dirname, 'fake-cursor.cjs');

function until(chat, ok, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (ok(chat.state)) return resolve(chat.state);
      if (Date.now() - t0 > ms) return reject(new Error('timeout; state: ' + JSON.stringify({ status: chat.state.status, items: chat.state.items.map((i) => i.kind + ':' + (i.status ?? i.text ?? '')) })));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function newChat(mode = 'ok', opts = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fakecursor-')), 'log.jsonl');
  Object.assign(process.env, { FAKE_CURSOR_LOG: log, FAKE_CURSOR_MODE: mode });
  const chat = new RuntimeChat({ runtime: cursorRuntime(() => fake), cwd: os.tmpdir(), ...opts }, () => {});
  chat.start();
  const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.args.includes('--list-models'));
  return { chat, runs };
}

test('cursor: parseModels reads --list-models', () => {
  assert.deepStrictEqual(parseModels('Available models\n\nauto - Auto (default)\ngpt-5.2 - GPT-5.2\n'), [
    { value: 'auto', displayName: 'Auto' },
    { value: 'gpt-5.2', displayName: 'GPT-5.2' },
  ]);
});

test('cursor: a turn, then the second message resumes the chat id', async () => {
  const { chat, runs } = newChat('ok', { env: { XDG_CONFIG_HOME: '/tmp/cursor-acct' } });
  try {
    assert.strictEqual(chat.state.runtime, 'cursor');
    assert.strictEqual(chat.state.caps.approvals, false);
    assert.strictEqual(chat.state.caps.steer, false);
    await until(chat, (s) => s.status === 'idle' && s.models.length === 2);
    assert.ok(chat.state.items.some((i) => i.kind === 'system' && /--force/.test(i.text)), 'the approvals note is shown');
    chat.send('fix it', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'tool' && i.name === 'Edit' && i.status === 'done'));
    const s = chat.state;
    assert.strictEqual(s.sessionId, 'chat_fake_1');
    assert.strictEqual(s.model, 'Composer 2.5');
    assert.deepStrictEqual(s.items.filter((i) => i.kind === 'assistant').map((i) => i.text), ['Hello', 'Done.']);
    assert.ok(s.items.some((i) => i.kind === 'thinking' && i.text === 'Let me look.'));
    const bash = s.items.find((i) => i.kind === 'tool' && i.name === 'Bash');
    assert.strictEqual(bash.status, 'done');
    assert.match(bash.result, /a\.txt/);
    const edit = s.items.find((i) => i.kind === 'tool' && i.name === 'Edit');
    assert.strictEqual(edit.patch[0].lines.join('|'), '-hi|+bye');
    assert.strictEqual(s.tokens, 105);
    let r = runs();
    assert.strictEqual(r.length, 1);
    assert.ok(!r[0].args.includes('--resume') && !r[0].args.includes('--force'));
    assert.strictEqual(r[0].xdg, '/tmp/cursor-acct', 'the Cursor account env reaches the CLI');

    chat.send('again', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.filter((i) => i.kind === 'tool' && i.name === 'Edit').length === 2);
    r = runs();
    assert.strictEqual(r.length, 2);
    const at = r[1].args.indexOf('--resume');
    assert.deepStrictEqual(r[1].args.slice(at, at + 2), ['--resume', 'chat_fake_1']);
    assert.strictEqual(r[1].args.at(-1), 'again');
  } finally {
    chat.close();
  }
});

test('cursor: Stop kills the run', async () => {
  const { chat } = newChat('hang');
  try {
    await until(chat, (s) => s.status === 'idle');
    chat.send('long', [], 'later');
    await until(chat, (s) => s.items.some((i) => i.kind === 'assistant' && i.text === 'Working'));
    await chat.interrupt();
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'system' && i.text === 'Stopped'));
  } finally {
    chat.close();
  }
});

test('cursor: not logged in shows the error', async () => {
  const { chat } = newChat('noauth');
  try {
    await until(chat, (s) => s.status === 'idle');
    chat.send('hi', [], 'later');
    await until(chat, (s) => s.status === 'idle' && s.items.some((i) => i.kind === 'result' && i.isError));
    assert.match(chat.state.items.find((i) => i.kind === 'result').text, /Not logged in.*cursor-agent login/);
  } finally {
    chat.close();
  }
});
