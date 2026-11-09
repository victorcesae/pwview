// Real Claude Code: a prompt survives the editor's process dying (kill -9, harsher than a reload),
// and a new chat takes it over, including a permission request still waiting for an answer.
// Sends two short messages on Haiku. Run with STEERHOUSE_E2E=1 (npm run test:e2e).
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { removeTestSession } = require('./e2e-cleanup.cjs');

const root = path.join(__dirname, '..');
const skip = !process.env.STEERHOUSE_E2E && 'set STEERHOUSE_E2E=1 to run against the real Claude Code';
const out = path.join(os.tmpdir(), 'steerhouse-e2e-relay');
const relayScript = path.join(root, 'dist', 'relay.js');
const stub = path.join(__dirname, 'vscode-stub.cjs');

const until = async (f, ms, what) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
};

// the "editor": a separate process, so it can really die
const WORKER = `
const { ChatSession } = require(${JSON.stringify(path.join(out, 'chat.js'))});
const { agentExecutable } = require(${JSON.stringify(path.join(out, 'util.js'))});
const [cwd, approve, prompt, relayScript] = process.argv.slice(2);
const answered = new Set();
const c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', permissionMode: 'default', relayScript }, () => {
  const report = { sessionId: c.state.sessionId };
  const task = c.state.tasks.find((t) => t.status === 'running');
  if (task) report.taskFile = c.taskFile(task);
  const pending = c.state.items.find((i) => i.kind === 'permission' && i.status === 'pending');
  if (pending) {
    report.permission = true;
    if (approve === 'yes' && !answered.has(pending.id)) {
      answered.add(pending.id);
      // the request is registered just after this callback
      setTimeout(() => {
        c.respond(pending.id, 'allow');
        console.log(JSON.stringify({ approved: true }));
      }, 100);
    }
  }
  console.log(JSON.stringify(report));
});
c.start();
c.send(prompt, [], 'later');
`;

function startWorker(cwd, approve, prompt) {
  const file = path.join(out, `worker-${process.pid}-${approve}.cjs`);
  fs.writeFileSync(file, WORKER);
  const p = spawn(process.execPath, [file, cwd, approve, prompt, relayScript], { stdio: ['ignore', 'pipe', 'ignore'] });
  const seen = {};
  let rest = '';
  p.stdout.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      try {
        Object.assign(seen, JSON.parse(rest.slice(0, i)));
      } catch {}
      rest = rest.slice(i + 1);
    }
  });
  return { p, seen };
}

const setup = () => {
  execSync(`npx esbuild src/chat.ts src/util.ts src/relayClient.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-e2e-relay-')));
  return { cwd, ...require(path.join(out, 'chat.js')), ...require(path.join(out, 'util.js')), ...require(path.join(out, 'relayClient.js')) };
};
// not sleep: Claude Code blocks long sleeps and the agent would work around that
const prompt = (seconds) => `Use the Bash tool, in the foreground (no background flag), to run exactly this command once, with no changes: node -e "setTimeout(() => require('fs').writeFileSync('marker.txt', 'done'), ${seconds * 1000})"\nIts timeout is fine as it is. After it finishes, reply with only the word FINISHED.`;

test('e2e: the prompt keeps running when the editor dies, and a new chat sees it finish', { skip, timeout: 240_000 }, async () => {
  const { cwd, ChatSession, agentExecutable, findRelay, listRelays } = setup();
  let c;
  const marker = path.join(cwd, 'marker.txt');
  try {
    const w = startWorker(cwd, 'yes', prompt(40));
    await until(() => w.seen.approved && w.seen.sessionId, 90_000, 'the command was approved');
    await new Promise((r) => setTimeout(r, 2000)); // it is running now
    await until(() => w.seen.taskFile, 25_000, 'the running command is reported').catch(() => {}); // only longer ones are
    assert.ok(!fs.existsSync(marker), 'not finished yet');
    // a command the agent waits on: its live output file is where Steerhouse looks, in this session
    if (w.seen.taskFile) {
      console.log(`live output file found: ${fs.existsSync(w.seen.taskFile)}, ${w.seen.taskFile.includes(w.seen.sessionId) ? 'in this session' : 'NOT in this session'}`);
      assert.ok(fs.existsSync(w.seen.taskFile), w.seen.taskFile);
      assert.ok(w.seen.taskFile.includes(w.seen.sessionId));
    } else console.log('no task reported for this foreground command yet');
    w.p.kill('SIGKILL');
    const relay = await until(() => findRelay(w.seen.sessionId), 5000, 'the relay is registered');
    console.log(`editor killed mid-command, session ${w.seen.sessionId}, relay ${relay.pid}`);

    await until(() => fs.existsSync(marker), 90_000, 'the command finished with nobody connected');
    console.log('the command finished on its own');

    c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', resume: w.seen.sessionId, relayScript }, () => {});
    c.start();
    await until(() => c.state.status === 'idle' && findRelay(w.seen.sessionId)?.pid === relay.pid, 60_000, 'it settled on the same process');
    assert.strictEqual(findRelay(w.seen.sessionId).pid, relay.pid, 'reconnected, no second Claude Code');
    c.send('Reply with only the word AGAIN.', [], 'later');
    await until(() => c.state.items.some((i) => i.kind === 'assistant' && /AGAIN/.test(i.text)), 60_000, 'the reconnected chat answers');
    await until(() => c.state.status === 'idle', 30_000, 'turn ended');
    console.log('the reconnected chat works');
  } finally {
    c?.close();
    // whatever happened above, nothing keeps running
    for (const r of listRelays()) if (r.cwd === cwd) process.kill(r.pid, 'SIGTERM');
    await removeTestSession(cwd);
  }
});

test('e2e: a permission request still waiting comes back to the new chat', { skip, timeout: 240_000 }, async () => {
  const { cwd, ChatSession, agentExecutable, findRelay, listRelays } = setup();
  let c;
  const marker = path.join(cwd, 'marker.txt');
  try {
    const w = startWorker(cwd, 'no', prompt(1));
    await until(() => w.seen.permission && w.seen.sessionId, 90_000, 'the permission request arrived');
    w.p.kill('SIGKILL');
    const relay = await until(() => findRelay(w.seen.sessionId), 5000, 'the relay is registered');
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(!fs.existsSync(marker), 'it waits for the answer');

    c = new ChatSession({ cwd, executable: agentExecutable(), model: 'haiku', resume: w.seen.sessionId, relayScript }, () => {});
    c.start();
    const card = await until(() => c.state.items.find((i) => i.kind === 'permission' && i.status === 'pending'), 30_000, 'the request is back');
    assert.match(c.state.status, /working|waiting/);
    assert.strictEqual(findRelay(w.seen.sessionId).pid, relay.pid);
    console.log('the permission request came back to the new chat');
    c.respond(card.id, 'allow');
    await until(() => fs.existsSync(marker), 60_000, 'approved from the new chat, the command ran');
    console.log('approved from the new chat, the command ran');
  } finally {
    c?.close();
    // whatever happened above, nothing keeps running
    for (const r of listRelays()) if (r.cwd === cwd) process.kill(r.pid, 'SIGTERM');
    await removeTestSession(cwd);
  }
});
