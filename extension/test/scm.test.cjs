// Source control per project: changed files from VS Code's Git state (conflicts, staged, working
// tree, untracked; no duplicates), status letters, and the branch summary.
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-scm-build');
execSync(`npx esbuild src/scm.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const S = require(path.join(out, 'scm.js'));

const ch = (p, status) => ({ uri: { fsPath: p }, originalUri: { fsPath: p }, status });
const state = (o) => ({ HEAD: { name: 'main', ahead: 0, behind: 0, upstream: { remote: 'origin', name: 'main' } }, indexChanges: [], workingTreeChanges: [], untrackedChanges: [], mergeChanges: [], onDidChange: () => ({}), ...o });

test('scm: conflicts first, then staged, then the rest; untracked once even when listed twice', () => {
  const s = state({
    mergeChanges: [ch('/r/m.ts', 18)],
    indexChanges: [ch('/r/a.ts', 1)],
    workingTreeChanges: [ch('/r/b.ts', 5), ch('/r/new.ts', 7)],
    untrackedChanges: [ch('/r/new.ts', 7)],
  });
  assert.deepStrictEqual(S.scmFiles(s).map((f) => [path.basename(f.path), f.letter, f.staged]), [['m.ts', '!', false], ['a.ts', 'A', true], ['b.ts', 'M', false], ['new.ts', 'U', false]]);
});

test('scm: a file both staged and changed again shows twice (index and working tree), like the Source Control view', () => {
  const s = state({ indexChanges: [ch('/r/a.ts', 0)], workingTreeChanges: [ch('/r/a.ts', 5)] });
  assert.deepStrictEqual(S.scmFiles(s).map((f) => f.staged), [true, false]);
});

test('scm: status letters', () => {
  assert.deepStrictEqual([0, 1, 2, 3, 5, 6, 7, 11, 16].map((n) => S.statusLetter(n)[0]), ['M', 'A', 'D', 'R', 'M', 'D', 'U', 'T', '!']);
});

test('scm: summary with branch, ahead / behind, change count', () => {
  assert.strictEqual(S.scmSummary(state({})), 'main · clean');
  assert.strictEqual(S.scmSummary(state({ HEAD: { name: 'feat/x', ahead: 2, behind: 1, upstream: { remote: 'origin', name: 'feat/x' } }, workingTreeChanges: [ch('/r/a', 5)] })), 'feat/x · ↑2 ↓1 · 1 change');
  assert.strictEqual(S.scmSummary(state({ HEAD: { name: 'new' }, workingTreeChanges: [ch('/r/a', 5), ch('/r/b', 7)] })), 'new · not pushed · 2 changes');
});
