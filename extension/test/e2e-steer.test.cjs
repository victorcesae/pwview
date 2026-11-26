// Real Steer / Send now through the installed Claude Code (Haiku). Run: STEERHOUSE_E2E=1 node --test test/e2e-steer.test.cjs
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

function setup(extra = {}) {
  execSync(
    `npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`,
    { cwd: root },
  );
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-steer-'));
  const c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', permissionMode: 'acceptEdits', ...extra }, () => {});
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
    await removeTestSession(c.state.cwd);
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
    await removeTestSession(c.state.cwd);
  }
});

test('e2e: a Steer sent while the final answer is being written is not lost', { skip, timeout: 420_000 }, async () => {
  const { c, said } = setup();
  try {
    c.send('Run `sleep 3 && echo ready` with Bash. Then, without any more tools, write a long answer: five paragraphs about honey bees.', [], 'later');
    // the final answer has started streaming: no tool call is left for the steer to ride on
    await until(c, () => c.state.items.some((i) => i.kind === 'tool') && c.state.items.at(-1)?.kind === 'assistant' && c.state.items.at(-1).text.length > 40);
    c.steerGraceMs = 0;
    c.send('ALSO: end your reply with the exact word PINEAPPLE-LATE.', [], 'next');
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000 && !/PINEAPPLE-LATE/.test(said())) await new Promise((r) => setTimeout(r, 500));
    console.log(`late steer: turns=${c.turns}, status=${c.state.status}, said=${/PINEAPPLE-LATE/.test(said())}, queue=${c.state.queue.length}`);
    assert.match(said(), /PINEAPPLE-LATE/, 'the late steer was acted on');
  } finally {
    c.close();
    await removeTestSession(c.state.cwd);
  }
});

test('e2e: a side question is answered while the agent keeps working, and the agent never sees it', { skip, timeout: 420_000 }, async () => {
  const { c, said, bash } = setup();
  try {
    c.send(SLOW_TASK, [], 'later');
    await until(c, () => bash().length >= 1);
    c.askAside('Which step is running now? Answer in one short sentence.');
    const aside = () => c.state.items.find((i) => i.kind === 'aside');
    await until(c, () => aside() && !aside().streaming, 120_000);
    console.log(`aside: answer=${JSON.stringify(aside().answer.slice(0, 120))}, error=${aside().error}, main status=${c.state.status}`);
    assert.ok(aside().answer.trim(), 'the side question got an answer');
    await until(c, () => c.state.status === 'idle' && c.turns >= 1);
    assert.equal(bash().length, 3, 'the main task carried on to the end');
    assert.doesNotMatch(said(), /which step is running/i);
  } finally {
    c.close();
    await removeTestSession(c.state.cwd);
  }
});

for (const relay of [false, true])
test(`e2e: after Stop the chat keeps its conversation and goes on with the next message${relay ? ' (through the relay, as in VS Code)' : ''}`, { skip, timeout: 420_000 }, async () => {
  const { c, said, bash } = setup(relay ? { relayScript: path.join(root, 'dist', 'relay.js') } : {});
  try {
    c.send('Remember the code word MANGO-42. Then: ' + SLOW_TASK, [], 'later');
    await until(c, () => bash().length >= 1);
    await c.interrupt();
    await until(c, () => c.state.status === 'idle', 60_000);
    const results = c.state.items.filter((i) => i.kind === 'result').map((i) => i.text);
    assert.deepEqual(results, [], 'a stop is not shown as an error');
    assert.ok(c.state.items.some((i) => i.kind === 'system' && /^Stopped/.test(i.text)), 'it says it stopped');
    console.log(`stop: status=${c.state.status}, results=${JSON.stringify(results)}, systems=${JSON.stringify(c.state.items.filter((i) => i.kind === 'system').map((i) => i.text))}`);
    c.send('What was the code word I gave you? Answer with just the word.', [], 'later');
    await until(c, () => c.state.status === 'idle' && /MANGO-42/.test(said()), 120_000);
    console.log(`after stop: status=${c.state.status}, error=${c.state.error}, remembered=${/MANGO-42/.test(said())}`);
    // reopened later: the history read back from disk still has the conversation
    const { historyFromTranscript } = require(path.join(out, 'chat.js'));
    const os2 = require('os');
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os2.homedir(), '.claude'), 'projects');
    const file = require('fs').readdirSync(dir).map((d) => path.join(dir, d, c.state.sessionId + '.jsonl')).find((f) => require('fs').existsSync(f));
    const h = historyFromTranscript(file);
    const kinds = h.items.map((i) => i.kind + (i.kind === 'user' ? ':' + i.text.slice(0, 30) : ''));
    console.log('reopened: ' + JSON.stringify(kinds));
    assert.ok(h.items.some((i) => i.kind === 'user' && /MANGO-42/.test(i.text)), 'the first prompt is in the reopened chat');
    assert.ok(h.items.some((i) => i.kind === 'assistant' && /MANGO-42/.test(i.text)), 'the answer after Stop is in the reopened chat');
  } finally {
    c.close();
    await removeTestSession(c.state.cwd);
  }
});
