// Real Claude Code (Haiku): the agent starts a small "dev server" in the background. The chat lists
// it as running, its output and local URL can be read while it runs, and Stop ends it (the SDK
// reports it stopped). Run with STEERHOUSE_E2E=1 (npm run test:e2e).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { removeTestSession } = require('./e2e-cleanup.cjs');

const root = path.join(__dirname, '..');
const skip = !process.env.STEERHOUSE_E2E && 'set STEERHOUSE_E2E=1 to run against the real Claude Code';

test('e2e: a background dev command is listed, its output read, and Stop ends it', { skip, timeout: 240_000 }, async () => {
  const out = path.join(os.tmpdir(), 'steerhouse-e2e-bg');
  const stub = path.join(__dirname, 'vscode-stub.cjs');
  execSync(`npx esbuild src/chat.ts src/util.ts src/bgtasks.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const B = require(path.join(out, 'bgtasks.js'));
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-e2e-bg-')));
  fs.writeFileSync(path.join(cwd, 'server.js'), "let i = 0; console.log('ready on http://localhost:4321/'); setInterval(() => console.log('tick ' + i++), 400);\n");
  const until = async (what, ok, ms = 120_000) => {
    const t0 = Date.now();
    while (!ok()) {
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + ' · tasks: ' + JSON.stringify(c?.state.tasks) + ' · status: ' + c?.state.status);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  // normal permissions: approve only the expected command, refuse anything else
  let c;
  const approve = () => {
    for (const it of c?.state.items ?? []) {
      if (it.kind !== 'permission' || it.status !== 'pending') continue;
      const cmd = String(it.input?.command ?? '').trim();
      const ok = it.tool === 'Bash' && /^node server\.js$/.test(cmd) && it.input?.run_in_background;
      it.status = ok ? 'allowed' : 'denied';
      queueMicrotask(() => c.respond(it.id, ok ? 'allow' : 'deny', ok ? undefined : 'Only node server.js in the background is allowed in this test.'));
    }
  };
  c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku' }, () => approve());
  c.start();
  try {
    c.send('Use the Bash tool with run_in_background set to true to run: node server.js  (it is a dev server that never exits). Do not wait for it or read its output. Then reply only: started.', [], 'later');
    await until('a background task', () => c.state.tasks.some((t) => t.status === 'running' && t.outputFile));
    const task = c.state.tasks.find((t) => t.status === 'running');
    assert.match(task.command, /node server\.js/);
    await until('output', () => B.readTail(task.outputFile).text.includes('tick 2'), 30_000);
    const tail = B.readTail(task.outputFile);
    assert.deepStrictEqual(B.findUrls(tail.text), ['http://localhost:4321/'], 'the dev server URL is found');
    await until('the turn to end', () => c.state.status === 'idle');
    console.log('· running, output and URL ok; stopping');
    await c.stopTask(task.id);
    await until('stopped', () => c.state.tasks.find((t) => t.id === task.id)?.status !== 'running', 30_000);
    assert.strictEqual(c.state.tasks.find((t) => t.id === task.id).status, 'stopped');
    // the process is gone when its output stops growing (stopping can take a moment)
    const sizes = [];
    for (let i = 0; i < 12; i++) (sizes.push(fs.statSync(task.outputFile).size), await new Promise((r) => setTimeout(r, 500)));
    console.log('· output size after Stop, every 0.5 s: ' + sizes.join(' '));
    assert.strictEqual(sizes.at(-1), sizes.at(-5), 'no more output after Stop: the process is gone');
  } finally {
    // never leave the test server running, even when a step failed
    for (const t of c.state.tasks) if (t.status === 'running') await c.stopTask(t.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    c.close();
    // a failed cleanup must not hide what the test found
    await removeTestSession(cwd).catch((e) => console.error('cleanup: ' + e.message));
  }
});
