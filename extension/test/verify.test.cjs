// Verify after each turn: command detection, output trimming, the fix message, which turn changed files.
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-verify-build');
execSync(`npx esbuild src/verify.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const V = require(path.join(out, 'verify.js'));

const fake = (files) => ({ exists: (p) => path.basename(p) in files, read: (p) => files[path.basename(p)] });
const pkg = (scripts) => JSON.stringify({ scripts });

test('verify: detects package.json scripts in order, with the package manager', () => {
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'package.json': pkg({ test: 'jest', lint: 'eslint .', typecheck: 'tsc', build: 'x' }) })), 'npm run typecheck && npm run lint && npm test');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'package.json': pkg({ test: 'vitest' }), 'pnpm-lock.yaml': '' })), 'pnpm test');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'package.json': pkg({ lint: 'eslint' }), 'yarn.lock': '' })), 'yarn run lint');
  // npm's placeholder test script is not a test
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) })), undefined);
});

test('verify: detects cargo, go and pytest', () => {
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'Cargo.toml': '' })), 'cargo test');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'go.mod': '' })), 'go test ./...');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })), 'pytest');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'pytest.ini': '' })), 'pytest');
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'pyproject.toml': '[project]\n' })), undefined);
  assert.strictEqual(V.detectVerifyCommand('/p', fake({ 'package.json': '{bad' })), undefined);
});

test('verify: output keeps the tail, without colors, and says what was cut', () => {
  assert.strictEqual(V.trimOutput('\x1b[31merror\x1b[0m\r\nok\n'), 'error\nok');
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const t = V.trimOutput(long, 1000);
  assert.ok(t.length < 1100);
  assert.match(t, /^…\(\d+ earlier characters cut\)\n/);
  assert.ok(t.endsWith('line 1999'));
  assert.ok(!t.split('\n')[1].startsWith('ine'), 'starts at a whole line');
});

test('verify: the fix message names the command and carries the output', () => {
  assert.strictEqual(V.fixMessage('npm test'), 'The verify command `npm test` failed. Fix it.');
  const m = V.fixPromptForAgent('npm test', 'x'.repeat(20000));
  assert.ok(m.startsWith('The verify command `npm test` failed. Fix it.'));
  assert.ok(m.length < 8300);
});

test('verify: the last turn, whether it changed files, and whether it was automatic', () => {
  const u = (id, auto) => ({ kind: 'user', id, text: 'x', images: [], ts: '', auto });
  const tool = (name, status = 'done') => ({ kind: 'tool', id: name + status, name, summary: '', input: {}, status });
  assert.deepStrictEqual(V.lastTurn([u('a'), tool('Edit'), u('b'), tool('Read')]), { id: 'b', auto: false, changed: false });
  assert.deepStrictEqual(V.lastTurn([u('a'), tool('Write')]), { id: 'a', auto: false, changed: true });
  assert.deepStrictEqual(V.lastTurn([u('a', true), tool('Edit', 'error')]), { id: 'a', auto: true, changed: false });
  assert.deepStrictEqual(V.lastTurn([]), { id: undefined, auto: false, changed: false });
});
