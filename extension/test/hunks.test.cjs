// Changes panel hunk actions: reverse-applying a hunk by text, and the one-hunk patch git accepts.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-hunks-build');
execSync(`npx esbuild src/gitActions.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const G = require(path.join(out, 'gitActions.js'));

const hunk = { oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [' b', '-c', '+C', ' d'] };

test('hunks: reverse-apply by text, also when the hunk moved', () => {
  assert.strictEqual(G.reverseApplyText('a\nb\nC\nd\ne', [hunk]), 'a\nb\nc\nd\ne');
  assert.strictEqual(G.reverseApplyText('x\ny\na\nb\nC\nd\ne', [hunk]), 'x\ny\na\nb\nc\nd\ne');
  assert.strictEqual(G.reverseApplyText('a\r\nb\r\nC\r\nd\r\n', [hunk]), 'a\r\nb\r\nc\r\nd\r\n');
});

test('hunks: reverse-apply fails when the file no longer has the change', () => {
  assert.strictEqual(G.reverseApplyText('a\nb\nX\nd\ne', [hunk]), undefined);
});

test('hunks: a one-hunk patch reverts and stages with git apply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-hunk-'));
  const sh = (c, input) => execSync(c, { cwd: dir, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  sh('git init -q && git config user.email a@b && git config user.name t');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nc\nd\ne\n');
  sh('git add . && git commit -qm init');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nb\nC\nd\ne\n');
  const [f] = G.parseUnifiedDiff(sh('git diff HEAD'), dir);
  const patch = G.hunkPatch('f.txt', f.hunks[0]);
  sh('git apply --cached --recount -', patch);
  assert.match(sh('git diff --cached'), /\+C/);
  sh('git apply -R --recount -', patch);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'a\nb\nc\nd\ne\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
