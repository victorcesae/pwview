// Browser with no setup (pwview), the folder picker for new chats, and reading only recent transcripts.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-pwview-build');
execSync(`npx esbuild src/pwview.ts src/liveBrowser.ts src/folders.ts src/engine.ts --bundle --platform=node --format=cjs --outdir="${out}" --external:bufferutil --external:utf-8-validate --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const P = require(path.join(out, 'pwview.js'));
const L = require(path.join(out, 'liveBrowser.js'));
const F = require(path.join(out, 'folders.js'));
const E = require(path.join(out, 'engine.js'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-pw-'));

test('pwview: the right download, and old versions are not good enough', () => {
  assert.strictEqual(P.assetFor('linux', 'x64'), 'pwview-linux-x86_64');
  assert.strictEqual(P.assetFor('win32', 'x64'), 'pwview-windows-x86_64.exe');
  assert.strictEqual(P.assetFor('darwin', 'x64'), undefined, 'no Intel Mac build');
  assert.ok(!P.versionOk('pwview 0.1.0', '0.2.0'));
  assert.ok(P.versionOk('pwview 0.2.0', '0.2.0'));
  assert.ok(P.versionOk('pwview 1.0.0', '0.2.0'));
  assert.ok(!P.versionOk('garbage', '0.2.0'));
});

test('pwview: a project with its own browser server keeps it', () => {
  assert.ok(P.hasBrowserServer('{"mcpServers":{"playwright":{"command":"npx"}}}'));
  assert.ok(P.hasBrowserServer('{"mcpServers":{"pwview":{"command":"pwview"}}}'));
  assert.ok(!P.hasBrowserServer('{"mcpServers":{"github":{}}}'));
  assert.ok(!P.hasBrowserServer('not json'));
});

test('pwview: only web projects get a browser', () => {
  const d = tmp();
  assert.ok(!P.wantsBrowser(d));
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  assert.ok(P.wantsBrowser(d));
});

test('pwview: free ports are chosen only when something is busy, and only for what is busy', async () => {
  const ports = { ui: 1, report: 2, cdp: 3, novnc: 4, vnc: 5 };
  const free = async () => true;
  const any = async () => 9000;
  assert.strictEqual(await P.freeSettings({ ports, display: 99 }, free, any, () => false), undefined);
  const r = await P.freeSettings({ ports, display: 99 }, async (p) => p !== 3, any, (n) => n === 99);
  assert.deepStrictEqual(r, { ports: { ...ports, cdp: 9000 }, display: 100 });
  const text = P.localToml(r.ports, r.display);
  assert.ok(P.isOurs(text));
  assert.match(text, /cdp = 9000/);
  assert.match(text, /number = 100/);
  assert.ok(!P.isOurs('[ports]\ncdp = 1\n'), "someone else's file");
});

test('live browser: real pages only', () => {
  const page = (url) => ({ id: url, type: 'page', title: '', url, webSocketDebuggerUrl: 'ws://x' });
  const list = [page('https://a.test/'), page('about:blank'), page('chrome://webui-toolbar.top-chrome'), page('chrome-extension://x/y'), { id: 'w', type: 'service_worker', title: '', url: 'https://a.test/sw.js', webSocketDebuggerUrl: 'ws://y' }];
  assert.deepStrictEqual(L.visiblePages(list).map((t) => t.url), ['https://a.test/', 'about:blank']);
});

test('folders: repositories inside the workspace, not inside each other or node_modules', () => {
  const w = tmp();
  for (const d of ['a/.git', 'a/sub/.git', 'group/b/.git', 'node_modules/c/.git', '.hidden/d/.git', 'plain/x', 'too/deep/down/e/.git']) fs.mkdirSync(path.join(w, d), { recursive: true });
  assert.deepStrictEqual(F.findRepos(w).map((p) => path.relative(w, p)).sort(), ['a', path.join('group', 'b')]);
});

test('folders: the last used comes first, then the workspace, then by name', () => {
  const w = tmp();
  for (const d of ['zeta/.git', 'alpha/.git']) fs.mkdirSync(path.join(w, d), { recursive: true });
  const [z, a] = [path.join(w, 'zeta'), path.join(w, 'alpha')];
  assert.deepStrictEqual(F.folderChoices([w]), [w, a, z]);
  assert.deepStrictEqual(F.folderChoices([w], z), [z, w, a]);
  assert.deepStrictEqual(F.folderChoices([a]), [a], 'one repository: nothing to ask');
});

test('scan: transcripts outside the day window are not parsed', () => {
  const dir = tmp();
  const pdir = path.join(dir, '-w-app');
  fs.mkdirSync(pdir);
  const line = JSON.stringify({ type: 'user', cwd: '/w/app', timestamp: new Date().toISOString(), sessionId: 's', message: { role: 'user', content: 'hi' } }) + '\n';
  fs.writeFileSync(path.join(pdir, 'new.jsonl'), line);
  const old = path.join(pdir, 'old.jsonl');
  fs.writeFileSync(old, line);
  const past = new Date(Date.now() - 30 * 86_400_000);
  fs.utimesSync(old, past, past);
  const engine = new E.Engine(() => [{ account: 'default', dir }]);
  const read = fs.readFileSync;
  const seen = [];
  fs.readFileSync = (f, ...a) => (String(f).endsWith('.jsonl') && seen.push(path.basename(String(f))), read(f, ...a));
  try {
    assert.deepStrictEqual(engine.scan(3).map((s) => s.info.id), ['new']);
  } finally {
    fs.readFileSync = read;
  }
  assert.ok(!seen.includes('old.jsonl'), 'the old transcript stays unread');
});

test('project transcripts: older chats count, another project in the same folder does not', () => {
  const dir = tmp();
  const rec = (cwd) => JSON.stringify({ type: 'user', cwd, message: {} }) + '\n';
  fs.writeFileSync(path.join(dir, 'mine.jsonl'), rec('/w/a-b'));
  fs.writeFileSync(path.join(dir, 'other.jsonl'), rec('/w/a/b'));
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), rec('/w/a-b'));
  assert.deepStrictEqual(E.projectTranscripts('/w/a-b', [dir, dir]), [{ id: 'mine', path: path.join(dir, 'mine.jsonl') }]);
  assert.strictEqual(E.transcriptCwd(path.join(dir, 'empty.jsonl')), undefined);
});

test('accounts: rename keeps id and folder; Cursor accounts have their own config folder', () => {
  const home = tmp();
  const real = path.join(home, 'real-config');
  fs.mkdirSync(path.join(real, 'gh'), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: real });
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    execSync(`npx esbuild src/accounts.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root, env: { ...process.env, HOME: saved.HOME } });
    const A = require(path.join(out, 'accounts.js'));
    A.renameAccount('default', '  Personal ');
    assert.strictEqual(A.defaultAccount().name, 'Personal');
    assert.strictEqual(A.defaultAccount().id, 'default');
    const work = A.addAccount('Work');
    A.renameAccount(work.id, 'Job');
    const again = A.listAccounts().find((x) => x.id === work.id);
    assert.strictEqual(again.name, 'Job');
    assert.strictEqual(again.configDir, work.configDir, 'the login folder stays');
    A.renameAccount(work.id, '   ');
    assert.strictEqual(A.listAccounts().find((x) => x.id === work.id).name, 'Job', 'an empty name is ignored');
    const c = A.addCursorAccount('Work');
    const c2 = A.addCursorAccount('Work');
    assert.notStrictEqual(c.id, c2.id);
    assert.deepStrictEqual(A.cursorAccountEnv(c), { XDG_CONFIG_HOME: c.dir });
    assert.strictEqual(fs.realpathSync(path.join(c.dir, 'gh')), fs.realpathSync(path.join(real, 'gh')), 'gh keeps its login');
    assert.ok(!fs.existsSync(path.join(c.dir, 'git')), 'nothing to link');
    A.renameAccount(c.id, 'Client');
    assert.strictEqual(A.listCursorAccounts().find((x) => x.id === c.id).name, 'Client');
    A.removeCursorAccount(c.id);
    assert.deepStrictEqual(A.listCursorAccounts().map((x) => x.id), [c2.id]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('chat box: @ completion finds what is being typed and keeps paths intact', () => {
  execSync(`npx esbuild webview/src/views/completion.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
  const C = require(path.join(out, 'completion.js'));
  assert.strictEqual(C.atQuery('look at @src/ma'), 'src/ma');
  assert.strictEqual(C.atQuery('@'), '');
  assert.strictEqual(C.atQuery('@my\\_fi'), 'my_fi', 'Markdown escapes');
  assert.strictEqual(C.atQuery('me@example.com'), undefined, 'an e-mail address is not a mention');
  assert.strictEqual(C.atQuery('@done and more'), undefined);
  assert.strictEqual(C.atQuery('`@x`'), undefined);
  assert.strictEqual(C.withFile('see @ini', 'pkg/__init__.py'), 'see `pkg/__init__.py` ');
  assert.strictEqual(C.withFile('@a', '$&.ts'), '`$&.ts` ', 'special replacement characters stay literal');
  assert.strictEqual(F.filePattern('Ab'), '**/*[aA][bB]*');
  assert.strictEqual(F.filePattern('a/[1]'), '**/*[aA]/[[]1[]]*');
  assert.strictEqual(F.filePattern(''), '**/**');
});
