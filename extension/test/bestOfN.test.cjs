// Best of N: pure helpers (branch names, titles, N limits, diff totals, the judge prompt and its cap).
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-bon-build');
execSync(`npx esbuild src/bestOfN.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const B = require(path.join(out, 'bestOfN.js'));

test('best of n: branch names, short ids, titles, N between 2 and 4', () => {
  assert.strictEqual(B.bonBranch('ab12', 3), 'steerhouse/bon-ab12-3');
  const short = B.bonShort(1_700_000_000_000, 0.5);
  assert.match(short, /^[a-z0-9]{6}$/);
  assert.match(B.bonBranch(short, 1), /^[A-Za-z0-9._/-]+$/);
  assert.strictEqual(B.runTitle(2, 'opus'), 'Best of N · run 2 · opus');
  assert.strictEqual(B.runTitle(1), 'Best of N · run 1 · default');
  assert.deepStrictEqual([1, 2, 3, 4, 9, NaN, 2.6].map(B.clampN), [2, 2, 3, 4, 4, 2, 3]);
});

test('best of n: diff totals', () => {
  assert.deepStrictEqual(B.diffStats([]), { files: 0, added: 0, removed: 0 });
  assert.deepStrictEqual(B.diffStats([{ added: 3, removed: 1 }, { added: 2, removed: 0 }]), { files: 2, added: 5, removed: 1 });
});

test('best of n: judge prompt has the task and every diff, each capped', () => {
  assert.strictEqual(B.capText('abc', 5), 'abc');
  assert.match(B.capText('a'.repeat(10), 4), /^aaaa\n… \[truncated: 6 more characters\]$/);
  const p = B.judgePrompt('Fix the login', [
    { label: 'run 1', diff: '+a\n' },
    { label: 'run 2', diff: '' },
    { label: 'run 3', diff: 'x'.repeat(50_000) },
  ], 30_000);
  assert.match(p, /## Task\n\nFix the login/);
  assert.match(p, /Candidate 1: run 1[\s\S]*\+a/);
  assert.match(p, /Candidate 2: run 2[\s\S]*\(no changes\)/);
  assert.match(p, /truncated: 40000 more characters/);
  assert.ok(p.length < 35_000);
});
