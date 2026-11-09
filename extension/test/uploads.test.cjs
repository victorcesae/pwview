// Files from the person's own computer, saved on the machine the agent runs on.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-uploads-build');
execSync(`npx esbuild src/uploads.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const U = require(path.join(out, 'uploads.js'));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-up-test-')), 'uploads');

test('names stay inside their folder', () => {
  assert.strictEqual(U.safeName('notes de teste.txt'), 'notes de teste.txt');
  assert.strictEqual(U.safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(U.safeName('C:\\Users\\me\\a.txt'), 'a.txt');
  for (const bad of ['..', '.', '', '/', '../']) assert.strictEqual(U.safeName(bad), 'file', JSON.stringify(bad));
  assert.strictEqual(U.safeName('a\x00b?.txt'), 'a_b_.txt');
});

test('saved exactly, privately, and two files with one name do not collide', () => {
  const dir = tmp();
  const bytes = new Uint8Array([0, 255, 10, 13, 200]);
  const a = U.saveUpload('x.bin', bytes, dir);
  const b = U.saveUpload('x.bin', new Uint8Array([1]), dir);
  assert.notStrictEqual(a, b);
  assert.deepStrictEqual([...fs.readFileSync(a)], [...bytes]);
  assert.strictEqual(path.basename(a), 'x.bin');
  assert.ok(a.startsWith(dir + path.sep), 'inside the folder');
  assert.ok(U.saveUpload('../../evil', bytes, dir).startsWith(dir + path.sep));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(dir).mode & 0o077, 0, 'folder is private');
    assert.strictEqual(fs.statSync(a).mode & 0o077, 0, 'file is private');
  }
});

test('too large is refused; week-old uploads are removed', () => {
  const dir = tmp();
  const fake = { byteLength: U.MAX_UPLOAD_BYTES + 1 };
  assert.throws(() => U.saveUpload('big.bin', fake, dir), /larger than 100 MB/);
  const old = U.saveUpload('old.txt', new Uint8Array([1]), dir);
  const later = Date.now() + 8 * 24 * 60 * 60_000;
  const fresh = U.saveUpload('new.txt', new Uint8Array([2]), dir, later);
  assert.ok(!fs.existsSync(old), 'removed');
  assert.ok(fs.existsSync(fresh));
});
