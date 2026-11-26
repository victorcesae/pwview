// Unit tests for the Sessions sidebar row status ("Working 14s", "Waiting for you", "Done", "2m").
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-rowstatus-build');
execSync(`npx esbuild src/rowStatus.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root, stdio: 'inherit' });
const { rowStatus, rowDescription, shortAgo, DONE_FOR_MS } = require(path.join(out, 'rowStatus.js'));

const now = Date.parse('2026-11-26T12:00:00Z');

test('shortAgo', () => {
  assert.strictEqual(shortAgo(14_000), '14s');
  assert.strictEqual(shortAgo(-5), '0s');
  assert.strictEqual(shortAgo(2 * 60_000 + 5), '2m');
  assert.strictEqual(shortAgo(3600_000), '1h');
  assert.strictEqual(shortAgo(50 * 3600_000), '2d');
});

test('working shows live seconds', () => {
  assert.deepStrictEqual(rowStatus({ state: 'working', workingSince: now - 14_000, now }), { kind: 'working', label: 'Working 14s' });
  assert.strictEqual(rowStatus({ state: 'working', now }).label, 'Working 0s');
});

test('waiting wins over working', () => {
  assert.deepStrictEqual(rowStatus({ state: 'working', waiting: true, workingSince: now - 1000, now }), { kind: 'waiting', label: 'Waiting for you' });
});

test('done until opened or 10 minutes pass', () => {
  const fin = now - 60_000;
  assert.strictEqual(rowStatus({ state: 'recent', finishedAt: fin, updated: new Date(fin).toISOString(), now }).kind, 'done');
  assert.strictEqual(rowStatus({ state: 'recent', finishedAt: fin, seenAt: fin + 1, updated: new Date(fin).toISOString(), now }).label, '1m');
  assert.strictEqual(rowStatus({ state: 'idle', finishedAt: now - DONE_FOR_MS - 1, updated: new Date(now - 3600_000).toISOString(), now }).label, '1h');
  // opened before it finished: still done
  assert.strictEqual(rowStatus({ state: 'idle', finishedAt: fin, seenAt: fin - 1, now }).kind, 'done');
});

test('idle shows relative time, or nothing without a date', () => {
  assert.deepStrictEqual(rowStatus({ state: 'idle', updated: new Date(now - 120_000).toISOString(), now }), { kind: 'idle', label: '2m' });
  assert.strictEqual(rowStatus({ state: 'idle', now }).label, '');
});

test('translator is used', () => {
  assert.strictEqual(rowStatus({ state: 'working', workingSince: now - 3000, now }, (s, ...a) => s.replace('Working', 'Trabalhando').replace('{0}', a[0])).label, 'Trabalhando 3s');
});

test('description: status first, then folder · branch', () => {
  assert.strictEqual(rowDescription('Working 3s', 'app', 'main'), 'Working 3s · app · main');
  assert.strictEqual(rowDescription('', 'app', undefined), 'app');
});
