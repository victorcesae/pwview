// Real Claude Code (Haiku): "Edit and run again". Files the agent changed after a message are
// restored (file checkpointing + rewindFiles), and the conversation forks at that message into a
// new session that still knows what came before. Run with STEERHOUSE_E2E=1 (npm run test:e2e).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { removeTestSession } = require('./e2e-cleanup.cjs');

const root = path.join(__dirname, '..');
const skip = !process.env.STEERHOUSE_E2E && 'set STEERHOUSE_E2E=1 to run against the real Claude Code';

test('e2e: rewind the files to a message, then fork the conversation there', { skip, timeout: 300_000 }, async () => {
  const out = path.join(os.tmpdir(), 'steerhouse-e2e-fork');
  const stub = path.join(__dirname, 'vscode-stub.cjs');
  execSync(`npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-e2e-fork-')));
  const file = path.join(cwd, 'a.txt');
  const sessions = [];
  const idle = (c) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (c.state.status === 'idle' && c.turns > (c._seen ?? 0)) return (c._seen = c.turns), resolve();
        if (c.state.status === 'error') return reject(new Error(c.state.error));
        if (Date.now() - t0 > 120_000) return reject(new Error('timeout'));
        setTimeout(tick, 300);
      };
      tick();
    });
  const a = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', permissionMode: 'acceptEdits' }, () => {});
  a.start();
  try {
    a.send('Create a file named a.txt in the current folder containing exactly: one. Also remember the code word APPLE. Reply only OK.', [], 'later');
    await idle(a);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), 'one');
    a.send('Change a.txt so it contains exactly: two. Reply only OK.', [], 'later');
    await idle(a);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), 'two');
    sessions.push(a.state.sessionId);

    const second = a.state.items.filter((it) => it.kind === 'user')[1];
    assert.ok(second.forkAt, 'the message knows where to fork');
    const r = await a.rewindFilesTo(second.id);
    assert.ok(r.ok, r.error);
    assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), 'one', 'file restored to before the second message');
    a.close();

    const items = a.state.items.slice(0, a.state.items.indexOf(second));
    const fork = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', resume: a.state.sessionId, fork: { at: second.forkAt }, history: { items, todos: [] } }, () => {});
    fork.start();
    fork.send('What was the code word? Reply with the word only.', [], 'later');
    await idle(fork);
    sessions.push(fork.state.sessionId);
    const answer = fork.state.items.filter((it) => it.kind === 'assistant').at(-1)?.text ?? '';
    assert.match(answer, /APPLE/i, 'the fork remembers the first message');
    assert.notStrictEqual(fork.state.sessionId, a.state.sessionId, 'a new session; the original is kept');
    fork.close();
  } finally {
    a.close();
    void sessions;
    await removeTestSession(cwd);
  }
});
