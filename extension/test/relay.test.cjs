// The process that keeps a chat running while VS Code reloads, against a fake Claude Code.
const { execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-relay-build');
execSync(`npx esbuild src/relay.ts src/relayClient.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-relay-cfg-'));
const R = require(path.join(out, 'relay.js'));
const C = require(path.join(out, 'relayClient.js'));
const script = path.join(out, 'relay.js');

// answers every line, reports its pid, and can say it finished a turn or started a session
const fake = path.join(os.tmpdir(), `steerhouse-fake-cli-${process.pid}.cjs`);
fs.writeFileSync(fake, `
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.say === 'busy') console.log(JSON.stringify({ type: 'assistant', message: {} }));
  if (m.say === 'done') console.log(JSON.stringify({ type: 'result' }));
  console.log(JSON.stringify({ type: 'echo', got: m.say, pid: process.pid }));
}).on('close', () => process.exit(7));
`);
const until = async (f, ms = 5000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};
const start = (o = {}) => C.startRelay(script, { command: process.execPath, args: [fake], env: process.env, cwd: os.tmpdir(), ...o });
function lines(proc) {
  const got = [];
  let rest = '';
  proc.stdout.on('data', (d) => {
    rest += d;
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      got.push(JSON.parse(rest.slice(0, i)));
      rest = rest.slice(i + 1);
    }
  });
  return got;
}
const say = (proc, s) => proc.stdin.write(JSON.stringify({ say: s }) + '\n');
const exited = (proc) => new Promise((r) => proc.once('exit', (code) => r(code)));
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('frames: what the relay reads from Claude Code', () => {
  assert.deepStrictEqual(R.readFrame('{"type":"result"}'), { busy: false });
  assert.deepStrictEqual(R.readFrame('{"type":"assistant","message":{}}'), { busy: true });
  assert.deepStrictEqual(R.readFrame('{"type":"system","subtype":"init","session_id":"x"}'), { sessionId: 'x' });
  assert.deepStrictEqual(R.readFrame('not json'), {});
  const got = [];
  const split = R.lineSplitter((l) => got.push(l));
  split('a\nb');
  split('c\n\nd\n');
  assert.deepStrictEqual(got, ['a', 'bc', 'd']);
});

test('reconnect: Claude Code keeps running with nobody connected, and is found by its session', async () => {
  const entry = start();
  const a = new C.RelayProcess(entry);
  const gotA = lines(a);
  say(a, 'busy');
  const pid = (await until(() => gotA.find((m) => m.type === 'echo'))).pid;
  assert.strictEqual((await a.hello).busy, false, 'hello came before the first message');
  await until(() => C.findRelay('sess-1'), 3000);
  // VS Code goes away without saying anything
  a.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(isAlive(pid), 'still running');

  const b = new C.RelayProcess(C.findRelay('sess-1'));
  const gotB = lines(b);
  assert.strictEqual((await b.hello).busy, true, 'a new client learns a turn is running');
  say(b, 'done');
  const echo = await until(() => gotB.find((m) => m.type === 'echo'));
  assert.strictEqual(echo.pid, pid, 'the same process');
  b.kill('SIGTERM');
  await exited(b);
  await until(() => !isAlive(entry.pid));
  assert.strictEqual(C.findRelay('sess-1'), undefined, 'its record is gone');
  assert.ok(!isAlive(pid));
});

test('the newest window takes over', async () => {
  const entry = start();
  const a = new C.RelayProcess(entry);
  lines(a);
  await a.hello;
  const closed = exited(a);
  const b = new C.RelayProcess(entry);
  await b.hello;
  await closed;
  const got = lines(b);
  say(b, 'hi');
  await until(() => got.find((m) => m.got === 'hi'));
  b.kill('SIGTERM');
  await exited(b);
});

test('a wrong token gets nothing, and reaches nothing', async () => {
  const entry = start();
  const a = new C.RelayProcess(entry);
  const got = lines(a);
  await a.hello;
  const res = await new Promise((resolve) => {
    const s = net.connect(entry.socket);
    let data = '';
    s.on('connect', () => s.write('wrong-token\n{"say":"evil"}\n'));
    s.on('data', (d) => (data += d));
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
  });
  assert.strictEqual(res, '');
  say(a, 'fine');
  await until(() => got.find((m) => m.got === 'fine'));
  assert.ok(!got.some((m) => m.got === 'evil'));
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(entry.socket).mode & 0o077, 0, 'the socket is private');
  a.kill('SIGTERM');
  await exited(a);
});

test('the account environment is not left in a file', async () => {
  const entry = start({ env: { ...process.env, SECRET_TEST: 'x' } });
  const a = new C.RelayProcess(entry);
  await a.hello;
  const d = path.join(process.env.CLAUDE_CONFIG_DIR, 'steerhouse', 'relays');
  assert.ok(!fs.readdirSync(d).some((f) => f.endsWith('.spec.json')));
  assert.ok(!fs.readFileSync(path.join(d, `${entry.id}.json`), 'utf8').includes('SECRET_TEST'));
  a.kill('SIGTERM');
  await exited(a);
});

test('nobody connected: it stops when idle, and even when busy after the longer limit', async () => {
  const idle = start({ idleMs: 150, orphanMs: 60000 });
  const a = new C.RelayProcess(idle);
  await a.hello;
  a.sock.destroy();
  await until(() => !isAlive(idle.pid));

  const busy = start({ idleMs: 150, orphanMs: 900 });
  const b = new C.RelayProcess(busy);
  const got = lines(b);
  say(b, 'busy');
  await until(() => got.find((m) => m.type === 'echo'));
  b.sock.destroy();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(isAlive(busy.pid), 'a running turn outlives the idle limit');
  await until(() => !isAlive(busy.pid));
});

test('when VS Code shuts down, the SDK killing its process does not reach Claude Code', async () => {
  const entry = start();
  const a = new C.RelayProcess(entry);
  await a.hello;
  C.setShuttingDown();
  assert.strictEqual(a.kill('SIGTERM'), false);
  a.stdin.end();
  await new Promise((r) => setTimeout(r, 200));
  a.sock.destroy();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(isAlive(entry.pid), 'still running');
  process.kill(entry.pid, 'SIGTERM');
  await until(() => !isAlive(entry.pid));
  fs.rmSync(fake, { force: true });
});
