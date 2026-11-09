// Worktree per chat, against a real git repo: branch names, where the folder goes, creating it,
// recognising it (main repo + branch), and removing it (refused while dirty unless forced).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-worktree-build');
execSync(`npx esbuild src/worktree.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const W = require(path.join(out, 'worktree.js'));

test('worktree: branch names from a task, valid names, folder next to the repo', () => {
  assert.strictEqual(W.slug('Fix the login redirect!'), 'fix-the-login-redirect');
  assert.strictEqual(W.slug('Ação rápida: relatório'), 'acao-rapida-relatorio');
  assert.strictEqual(W.slug('!!!'), 'chat');
  assert.ok(W.validBranch('agentlens/fix-login'));
  for (const bad of ['', '-x', 'a..b', 'a b', 'x.lock', 'a//b', 'end/']) assert.ok(!W.validBranch(bad), bad);
  assert.strictEqual(W.worktreePath(path.join('/w', 'app'), 'agentlens/fix-login'), path.join('/w', 'app.worktrees', 'agentlens-fix-login'));
});

test('worktree (real git): create, recognise, refuse to remove while dirty, force remove; the branch stays', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-wt-')));
  const repo = path.join(base, 'app');
  fs.mkdirSync(repo);
  const g = (cmd, cwd = repo) => execSync(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${cmd}`, { cwd, encoding: 'utf8' });
  g('init -q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  g('add .');
  g('commit -qm init');

  assert.strictEqual(path.resolve(await W.repoRoot(repo)).toLowerCase(), repo.toLowerCase());
  assert.strictEqual(await W.repoRoot(base), undefined, 'not a repo');

  const r = await W.addWorktree(repo, 'agentlens/fix-login');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.dir, path.join(base, 'app.worktrees', 'agentlens-fix-login'));
  assert.ok(fs.existsSync(path.join(r.dir, 'a.txt')), 'files checked out');
  assert.ok(W.isWorktree(r.dir) && !W.isWorktree(repo));
  const info = W.worktreeInfo(r.dir);
  assert.strictEqual(path.resolve(info.main).toLowerCase(), repo.toLowerCase());
  assert.strictEqual(info.branch, 'agentlens/fix-login');
  assert.ok(!(await W.addWorktree(repo, 'agentlens/fix-login')).ok, 'same branch twice');

  fs.writeFileSync(path.join(r.dir, 'b.txt'), 'uncommitted');
  const refused = await W.removeWorktree(r.dir);
  assert.ok(!refused.ok, 'git refuses while there are changes');
  const forced = await W.removeWorktree(r.dir, true);
  assert.ok(forced.ok, forced.out);
  assert.ok(!fs.existsSync(r.dir));
  assert.match(g('branch --list agentlens/fix-login'), /agentlens\/fix-login/, 'the branch is kept');
});

test('tree: pinned projects first, archived ones under "Archived"', async () => {
  const out2 = path.join(os.tmpdir(), 'agentlens-tree-build');
  execSync(`npx esbuild src/tree.ts --bundle --platform=node --format=cjs --outdir="${out2}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
  const { SessionsTree } = require(path.join(out2, 'tree.js'));
  const s = (id, project, updated) => ({ info: { id, project, title: id, state: 'idle', updated, agents: [], edits: 0, linked: [] }, t: { events: [], changes: [] }, agents: [] });
  const sessions = [s('a', '/p/alpha', '2026-11-08'), s('b', '/p/beta', '2026-11-07'), s('c', '/p/gamma', '2026-11-06')];
  const tree = new SessionsTree(() => sessions, () => 'all', () => new Set(), () => ({ pinned: ['/p/gamma'], archived: ['/p/beta'] }));
  const top = tree.getChildren().filter((n) => n.kind === 'project' || n.kind === 'archived');
  assert.deepStrictEqual(top.map((n) => (n.kind === 'project' ? n.path : 'Archived')), ['/p/gamma', '/p/alpha', 'Archived'], 'pinned first, archived moved down');
  assert.deepStrictEqual(tree.getChildren(top[2]).map((n) => n.path), ['/p/beta']);
  assert.match(tree.getTreeItem(top[0]).contextValue, /^project pinned active/);
  assert.match(tree.getTreeItem(top[2].projects[0]).contextValue, /^project unpinned archived/);
});

test('tree: a project that is a worktree says so (main repo and branch)', async () => {
  const { SessionsTree } = require(path.join(os.tmpdir(), 'agentlens-tree-build', 'tree.js'));
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-wt-tree-')));
  const repo = path.join(base, 'shop');
  fs.mkdirSync(repo);
  const g = (cmd) => execSync(`git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ${cmd}`, { cwd: repo });
  g('init -q');
  fs.writeFileSync(path.join(repo, 'x'), 'x');
  g('add .');
  g('commit -qm i');
  const r = await W.addWorktree(repo, 'agentlens/try-it');
  assert.ok(r.ok);
  const s = { info: { id: 'w', project: r.dir, title: 'w', state: 'idle', updated: '1', agents: [], edits: 0, linked: [] }, t: { events: [], changes: [] }, agents: [] };
  const tree = new SessionsTree(() => [s], () => 'all', () => new Set());
  const item = tree.getTreeItem(tree.getChildren().find((n) => n.kind === 'project'));
  assert.match(item.description, /worktree of shop · agentlens\/try-it/);
  assert.match(item.contextValue, /\bworktree\b/);
  assert.strictEqual(item.iconPath.id, 'git-branch');
});
