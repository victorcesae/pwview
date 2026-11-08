// Real end-to-end chat through the installed Claude Code (uses your login; Haiku to keep it cheap).
// Run: AGENTLENS_E2E=1 npm run test:e2e
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-e2e-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
const skip = !process.env.AGENTLENS_E2E && 'set AGENTLENS_E2E=1 to run against the real Claude Code';

function until(c, cond, ms = 180_000) {
  return new Promise((ok, bad) => {
    const t0 = Date.now();
    const tick = () => {
      if (c.state.error) return bad(new Error(c.state.error));
      // approve any permission card, like a user clicking Allow
      for (const it of c.state.items) if (it.kind === 'permission' && it.status === 'pending') c.respond(it.id, 'allow');
      if (cond()) return ok();
      if (Date.now() - t0 > ms) return bad(new Error('timeout; status ' + c.state.status + ', activity: ' + c.state.activity));
      setTimeout(tick, 200);
    };
    tick();
  });
}

test('e2e: chat answers, streams, runs a tool, and delivers a queued message after the turn', { skip, timeout: 420_000 }, async () => {
  execSync(
    `npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`,
    { cwd: root },
  );
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const exe = agentExecutable();
  assert.ok(exe, 'Claude Code executable found');
  console.log('using', exe);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-e2e-'));
  let sawStreaming = false;
  const c = new ChatSession({ cwd, executable: exe, model: 'haiku' }, (s) => {
    if (s.items.some((i) => i.kind === 'assistant' && i.streaming)) sawStreaming = true;
  });
  const said = () => c.state.items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('\n');
  c.start();
  try {
    await c.setEffort('low');
    assert.equal(c.state.effort, 'low');
    c.send('Reply with exactly the single word: pong', [], 'later');
    await until(c, () => c.state.status === 'idle' && /pong/i.test(said()));
    assert.ok(c.state.sessionId, 'session id from init');
    assert.ok(c.state.account.email || c.state.account.provider, 'session reports its account');
    console.log('account:', c.state.account.email ? c.state.account.email.replace(/^(.).*@/, '$1***@') : '', c.state.account.plan ?? '', c.state.account.provider ?? '');
    assert.ok(sawStreaming, 'text streamed in');

    c.send('Use the Bash tool to run: echo agentlens-e2e  Then say "ran it".', [], 'later');
    await until(c, () => c.state.status === 'working' || c.state.status === 'waiting');
    c.send('Now reply with exactly: queued-ok', [], 'later');
    assert.equal(c.state.queue.length, 1, 'held while the agent works');
    await until(c, () => c.state.status === 'idle' && c.state.queue.length === 0 && /queued-ok/i.test(said()));
    const bash = c.state.items.find((i) => i.kind === 'tool' && (i.name === 'Bash' || i.name === 'PowerShell'));
    assert.ok(bash, 'tool call shown');
    assert.equal(bash.status, 'done');
    assert.match(bash.result ?? '', /agentlens-e2e/);
    console.log(`e2e ok · cost $${c.state.costUsd.toFixed(4)} · session ${c.state.sessionId}`);
  } finally {
    c.close();
  }
});
