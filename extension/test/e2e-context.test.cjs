// Real Claude Code: context usage is available right after start, before any message.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { removeTestSession } = require('./e2e-cleanup.cjs');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-e2e-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
const skip = !process.env.STEERHOUSE_E2E && 'set STEERHOUSE_E2E=1 to run against the real Claude Code';

test('e2e: context usage shows before the first message', { skip, timeout: 120_000 }, async () => {
  execSync(`npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-e2e-'));
  const c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku' }, () => {});
  c.start();
  try {
    assert.equal(c.state.status, 'idle', 'ready right away, not stuck in "starting"');
    const t0 = Date.now();
    while (!c.state.context && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
    assert.ok(c.state.context, 'context arrived without sending anything');
    console.log(`context before any message: ${c.state.context.used} / ${c.state.context.max} after ${Date.now() - t0} ms`);
    assert.equal(c.turns, 0, 'nothing was sent');
  } finally {
    c.close();
    await removeTestSession(cwd);
  }
});
