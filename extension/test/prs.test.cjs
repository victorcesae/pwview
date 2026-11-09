// Pull request status: links found in chat text, gh / GitHub API answers mapped to open / draft /
// merged / closed, the tracker that re-checks them and tells the chat when one changes, and the
// model a resumed chat shows before Claude Code reports it.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-prs-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(`npx esbuild src/prs.ts src/chat.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
const P = require(path.join(out, 'prs.js'));
const C = require(path.join(out, 'chat.js'));

test('prs: links from gh output, answers and markdown, each once', () => {
  const urls = P.findPrUrls('Created https://github.com/acme/api/pull/214\nsee [#214](https://github.com/acme/api/pull/214) and https://gitlab.com/g/web/-/merge_requests/9.');
  assert.deepStrictEqual(urls, ['https://github.com/acme/api/pull/214', 'https://gitlab.com/g/web/-/merge_requests/9']);
  assert.deepStrictEqual(P.findPrUrls('https://github.com/acme/api/issues/3 and https://github.com/acme/api'), []);
});

test('prs: gh and REST answers map to open, draft, merged, closed', () => {
  assert.strictEqual(P.toPrState({ state: 'OPEN', isDraft: false }), 'open');
  assert.strictEqual(P.toPrState({ state: 'OPEN', isDraft: true }), 'draft');
  assert.strictEqual(P.toPrState({ state: 'MERGED' }), 'merged');
  assert.strictEqual(P.toPrState({ state: 'CLOSED' }), 'closed');
  // REST: merged PRs say state "closed" with merged_at set
  assert.strictEqual(P.toPrState({ state: 'closed', merged_at: '2024-01-01T00:00:00Z' }), 'merged');
  assert.strictEqual(P.toPrState({ state: 'closed', merged_at: null }), 'closed');
  assert.strictEqual(P.toPrState({ state: 'open', draft: true }), 'draft');
  assert.strictEqual(P.toPrState({}), 'unknown');
});

test('prs: tracker checks new links at once and reports a status change (open → merged)', async () => {
  let state = 'open';
  let calls = 0;
  let changes = 0;
  const t = new P.PrTracker(() => changes++, async () => (calls++, { state, title: 'Rename', checked: Date.now() }));
  t.track(['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/1']);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(calls, 1, 'checked once, even if seen twice');
  assert.strictEqual(t.get('https://github.com/a/b/pull/1').state, 'open');
  assert.strictEqual(changes, 1);
  await t.check('https://github.com/a/b/pull/1'); // same status: no repaint
  assert.strictEqual(changes, 1);
  state = 'merged';
  await t.check('https://github.com/a/b/pull/1');
  assert.strictEqual(t.get('https://github.com/a/b/pull/1').state, 'merged');
  assert.strictEqual(changes, 2, 'the chat is told when the PR is merged');
  t.dispose();
});

test('prs: other hosts are "unknown", not an error', async () => {
  assert.strictEqual((await P.prStatus('https://gitlab.com/g/web/-/merge_requests/9')).state, 'unknown');
});

// Real GitHub: needs the gh CLI (logged in) or network access to the public API.
const online = (() => {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
test('prs (real GitHub): a merged and a closed PR', { skip: !online && 'gh not logged in' }, async () => {
  const merged = await P.prStatus('https://github.com/cli/cli/pull/1');
  assert.strictEqual(merged.state, 'merged');
  assert.strictEqual(merged.title, 'interactive pr list');
  assert.strictEqual((await P.prStatus('https://github.com/cli/cli/pull/14974')).state, 'closed');
});

test('resumed chat: shows the model of the last answer before Claude Code reports it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-hist-')), 's.jsonl');
  const rec = (o) => JSON.stringify(o);
  fs.writeFileSync(
    file,
    [
      rec({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' }),
      rec({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'a' }] }, uuid: 'a1' }),
      rec({ type: 'assistant', message: { id: 'm2', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'b' }] }, uuid: 'a2' }),
      rec({ type: 'assistant', message: { id: 'm3', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'c' }] }, uuid: 'a3' }),
    ].join('\n'),
  );
  const h = C.historyFromTranscript(file);
  assert.strictEqual(h.model, 'claude-opus-5-5');
  const chat = new C.ChatSession({ cwd: '/r', resume: 's', history: h }, () => {});
  assert.strictEqual(chat.state.model, 'claude-opus-5-5');
  // a model chosen in this chat earlier wins over the transcript
  const again = new C.ChatSession({ cwd: '/r', resume: 's', history: h, prefs: { model: 'haiku' } }, () => {});
  assert.strictEqual(again.state.model, 'haiku');
});

test('prs: task list in the description (code blocks ignored, numbered lists too)', () => {
  const body = ['## Plan', '- [x] API field', '- [ ] shared badge', '* [X] web app', '1. [ ] docs', '', '```md', '- [ ] not a task', '```', 'text [ ] not a task'].join('\n');
  assert.deepStrictEqual(P.prTasks(body), { done: 2, total: 4 });
  assert.strictEqual(P.prTasks('no tasks here'), undefined);
  assert.strictEqual(P.prTasks(undefined), undefined);
});

test('prs: CI checks from gh (Actions jobs and commit statuses), newest run of a job wins', () => {
  const checks = P.toChecks([
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u1' },
    { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u2' },
    { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'label', workflowName: 'Triage', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'e2e', workflowName: 'CI', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { __typename: 'StatusContext', context: 'vercel', state: 'PENDING', targetUrl: 'v' },
  ]);
  assert.deepStrictEqual(checks.map((c) => [c.name, c.state]), [['test', 'pass'], ['build', 'pending'], ['label', 'skipped'], ['e2e', 'fail'], ['vercel', 'pending']]);
  assert.strictEqual(checks[0].url, 'u2');
  assert.strictEqual(P.checksSummary(checks), 'fail');
  assert.strictEqual(P.checksSummary(checks.filter((c) => c.state !== 'fail')), 'pending');
  assert.strictEqual(P.checksSummary([{ name: 'a', state: 'pass' }, { name: 'b', state: 'skipped' }]), 'pass');
  assert.strictEqual(P.toChecks([]), undefined);
});

test('prs: the chat is repainted when CI finishes or a task is ticked, not when nothing changed', async () => {
  let st = { state: 'open', checks: [{ name: 'test', state: 'pending' }], tasks: { done: 1, total: 3 } };
  let changes = 0;
  const t = new P.PrTracker(() => changes++, async () => ({ ...JSON.parse(JSON.stringify(st)), checked: Date.now() }));
  const u = 'https://github.com/a/b/pull/2';
  await t.check(u);
  await t.check(u);
  assert.strictEqual(changes, 1);
  st.checks[0].state = 'pass';
  await t.check(u);
  assert.strictEqual(changes, 2);
  st.tasks.done = 2;
  await t.check(u);
  assert.strictEqual(changes, 3);
  t.dispose();
});

test('prs (real GitHub): open PR with Actions checks and review decision', { skip: !online && 'gh not logged in' }, async () => {
  const s = await P.prStatus('https://github.com/cli/cli/pull/1');
  assert.strictEqual(s.state, 'merged');
  const open = JSON.parse(execSync('gh pr list -R cli/cli --state open --limit 1 --json url', { encoding: 'utf8' }))[0];
  if (!open) return;
  const o = await P.prStatus(open.url);
  assert.ok(['open', 'draft'].includes(o.state));
  assert.ok(Array.isArray(o.checks) && o.checks.length > 0, 'has CI checks');
  for (const c of o.checks) assert.ok(['pass', 'fail', 'pending', 'skipped'].includes(c.state) && c.name);
  assert.ok(o.checks.some((c) => c.workflow), 'Actions jobs carry their workflow name');
});

test('prs: merge arguments and GitHub PR links', () => {
  assert.deepStrictEqual(P.mergeArgs('https://github.com/a/b/pull/3', 'squash', true), ['pr', 'merge', 'https://github.com/a/b/pull/3', '--squash', '--delete-branch']);
  assert.deepStrictEqual(P.mergeArgs('https://github.com/a/b/pull/3', 'rebase', false), ['pr', 'merge', 'https://github.com/a/b/pull/3', '--rebase']);
  assert.deepStrictEqual(P.parseGithubPr('https://github.com/cli/cli/pull/1'), { owner: 'cli', repo: 'cli', number: 1 });
  assert.strictEqual(P.parseGithubPr('https://gitlab.com/g/web/-/merge_requests/9'), undefined);
});

test('prs (real GitHub): changed files with your viewed marks (read only)', { skip: !online && 'gh not logged in' }, async () => {
  const r = await P.prFiles('https://github.com/cli/cli/pull/1');
  assert.ok(!r.error, r.error);
  assert.ok(typeof r.id === 'string' && r.id.length > 10, 'GraphQL node id');
  assert.ok(r.files.length > 0);
  for (const f of r.files) assert.ok(typeof f.path === 'string' && Number.isInteger(f.additions) && typeof f.viewed === 'boolean');
  assert.ok((await P.prFiles('https://gitlab.com/g/web/-/merge_requests/9')).error);
});
