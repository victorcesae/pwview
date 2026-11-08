// Real Steer / Send now through the installed Claude Code (Haiku). Run: AGENTLENS_E2E=1 node --test test/e2e-steer.test.cjs
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

function until(c, cond, ms = 240_000) {
  return new Promise((ok, bad) => {
    const t0 = Date.now();
    const tick = () => {
      if (c.state.error) return bad(new Error(c.state.error));
      for (const it of c.state.items) if (it.kind === 'permission' && it.status === 'pending') c.respond(it.id, 'allow');
      if (cond()) return ok();
      if (Date.now() - t0 > ms) return bad(new Error('timeout; status ' + c.state.status + ', activity: ' + c.state.activity));
      setTimeout(tick, 150);
    };
    tick();
  });
}

const SLOW_TASK =
  'Run these three Bash commands, one per tool call, in order, waiting for each: `sleep 6 && echo step1`, then `sleep 6 && echo step2`, then `sleep 6 && echo step3`. After the last one, write a one-line summary.';

function setup() {
  execSync(
    `npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`,
    { cwd: root },
  );
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-steer-'));
  const c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', permissionMode: 'acceptEdits' }, () => {});
  c.start();
  const said = () => c.state.items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('\n');
  const bash = () => c.state.items.filter((i) => i.kind === 'tool' && (i.name === 'Bash' || i.name === 'PowerShell'));
  return { c, said, bash };
}

test('e2e: Steer reaches the agent mid-task, in the same turn', { skip, timeout: 420_000 }, async () => {
  const { c, said, bash } = setup();
  try {
    c.send(SLOW_TASK, [], 'later');
    await until(c, () => bash().length >= 1);
    c.send('IMPORTANT new requirement: your final summary must include the exact word BANANA-STEER.', [], 'next');
    await until(c, () => c.state.status === 'idle' && c.turns >= 1);
    // give a possible follow-up turn a moment to start, so we can see if steer was handled separately
    await new Promise((r) => setTimeout(r, 1500));
    await until(c, () => c.state.status === 'idle');
    console.log(`steer: turns=${c.turns}, bash calls=${bash().length}, said BANANA=${/BANANA-STEER/.test(said())}`);
    assert.match(said(), /BANANA-STEER/, 'the steer message was taken into account');
    assert.equal(c.turns, 1, 'it was picked up inside the running turn (not as a new turn afterwards)');
  } finally {
    c.close();
  }
});

test('e2e: Send now switches the agent to the new message right away', { skip, timeout: 420_000 }, async () => {
  const { c, said, bash } = setup();
  try {
    c.send(SLOW_TASK, [], 'later');
    await until(c, () => bash().length >= 1);
    c.send('Stop the current task. Reply with exactly: NOW-OK', [], 'now');
    await until(c, () => c.state.status === 'idle' && /NOW-OK/.test(said()));
    const steps = bash().filter((b) => /step\d/.test(b.result ?? '')).length;
    console.log(`now: turns=${c.turns}, bash steps completed=${steps}`);
    assert.ok(steps < 3, 'the slow task did not run to the end first');
  } finally {
    c.close();
  }
});
