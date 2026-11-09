// Plan usage (Claude's /usage windows, OpenRouter key credit), the editor's own icon, and the browser lookup.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-limits-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(`npx esbuild src/chat.ts src/hostIcon.ts src/browser.ts src/tree.ts src/rules.ts src/agents.ts src/links.ts src/accounts.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
const C = require(path.join(out, 'chat.js'));
const H = require(path.join(out, 'hostIcon.js'));
const B = require(path.join(out, 'browser.js'));

test('limits: Claude /usage windows in order, per-model windows and extra usage', () => {
  const l = C.limitsFromUsage({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      seven_day: { utilization: 23, resets_at: '2026-11-12T03:20:00Z' },
      five_hour: { utilization: 42.4, resets_at: '2026-11-08T18:00:00Z' },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: null }],
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 3.4, utilization: 7, currency: 'USD' },
    },
  });
  assert.strictEqual(l.available, true);
  assert.strictEqual(l.plan, 'max');
  assert.deepStrictEqual(l.windows.map((w) => [w.id, w.pct]), [['five_hour', 42.4], ['seven_day', 23], ['model:Fable', 10]]);
  assert.deepStrictEqual(l.extra, { used: 3.4, limit: 50, currency: 'USD', label: 'Extra usage this month' });
});

test('limits: API keys and gateways have no plan windows', () => {
  assert.deepStrictEqual(C.limitsFromUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { available: false, plan: undefined, windows: [], source: 'none' });
  assert.strictEqual(C.limitsFromUsage(undefined).available, false);
});

test('limits: only OpenRouter gateways ask for key credit', async () => {
  assert.strictEqual(await C.openRouterLimits({ ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'x' }), undefined);
  assert.strictEqual(await C.openRouterLimits({ ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' }), undefined);
});

test('host icon: read from the editor install as a data URI, VS Code logo vs. fork picture', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-approot-'));
  fs.mkdirSync(path.join(app, 'resources', 'win32'), { recursive: true });
  fs.writeFileSync(path.join(app, 'resources', 'win32', 'code_70x70.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const uri = H.hostIcon(app, 'Visual Studio Code');
  assert.strictEqual(uri, 'data:image/png;base64,iVBORw==');
  assert.ok(H.hostIconCandidates('Visual Studio Code').includes('out/media/code-icon.svg'));
  assert.ok(!H.hostIconCandidates('Cursor').includes('out/media/code-icon.svg'));
  assert.ok(H.hostIconCandidates('Cursor').includes('out/media/logo.png'));
});

test('browser: install locations per OS; "default" means the system browser', () => {
  const win = B.browserCandidates('chrome', 'win32', { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.deepStrictEqual(win, ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe']);
  assert.deepStrictEqual(B.browserCandidates('edge', 'darwin', {}), ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  assert.deepStrictEqual(B.browserCandidates('firefox', 'linux', {}), ['firefox']);
  assert.strictEqual(B.browserExecutable('default'), undefined);
  assert.strictEqual(B.browserExecutable('custom', ''), undefined);
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-br-')), 'mybrowser');
  fs.writeFileSync(fake, '');
  assert.strictEqual(B.browserExecutable('custom', fake), fake);
});

test('files tree: folders first, hidden names left out; changed files counted across sessions and sub-agents', () => {
  const T = require(path.join(out, 'tree.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-files-'));
  for (const d of ['src', '.git', 'b-dir']) fs.mkdirSync(path.join(dir, d));
  for (const f of ['a.ts', 'Z.md']) fs.writeFileSync(path.join(dir, f), '');
  assert.deepStrictEqual(T.listDir(dir, new Set(['.git'])).map((e) => [path.basename(e.path), e.dir]), [['b-dir', true], ['src', true], ['a.ts', false], ['Z.md', false]]);
  assert.deepStrictEqual(T.listDir(path.join(dir, 'missing'), new Set()), []);
  const ch = (file, added, removed) => ({ file, added, removed });
  const s1 = { t: { changes: [ch('/p/src/a.ts', 3, 1)] }, agents: [{ t: { changes: [ch('/p/src/a.ts', 2, 0)] } }] };
  const s2 = { t: { changes: [ch('/p/b.ts', 1, 1)] }, agents: [] };
  const m = T.changedFiles([s1, s2]);
  assert.deepStrictEqual(m.get('/p/src/a.ts'), { added: 5, removed: 1, edits: 2 });
  assert.strictEqual(m.size, 2);
});

test('rules: user CLAUDE.md, project CLAUDE.md / CLAUDE.local.md always offered, others when present; local file kept out of git', () => {
  const Ru = require(path.join(out, 'rules.js'));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-cfg-'));
  assert.deepStrictEqual(Ru.userRules(cfg).map((r) => [r.label, r.exists]), [['CLAUDE.md', false]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-proj-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# rules');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '');
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'style.mdc'), '');
  assert.deepStrictEqual(Ru.projectRules(root).map((r) => [r.label, r.exists]), [['CLAUDE.md', true], ['CLAUDE.local.md', false], ['AGENTS.md', true], ['.cursor/rules/style.mdc', true]]);
  fs.mkdirSync(path.join(root, '.git'));
  Ru.ignoreLocal(root);
  Ru.ignoreLocal(root);
  assert.strictEqual(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'CLAUDE.local.md\n');
});

test('agents: other agent CLIs found on PATH; a plain "agent" only counts when it is Cursor\'s', () => {
  const Ag = require(path.join(out, 'agents.js'));
  const bins = { codex: '/usr/bin/codex', agent: '/usr/local/bin/agent', gemini: '/opt/gemini' };
  assert.deepStrictEqual(Ag.installedAgents((b) => bins[b]).map((a) => [a.id, a.exe]), [['codex', '/usr/bin/codex'], ['gemini', '/opt/gemini']]);
  const cursor = { agent: '/home/me/.local/share/cursor-agent/agent' };
  assert.deepStrictEqual(Ag.installedAgents((b) => cursor[b]).map((a) => a.id), ['cursor']);
  assert.deepStrictEqual(Ag.installedAgents(() => undefined), []);
});

test('links: only sessions on the same account and the same kind of model can be linked', () => {
  const L = require(path.join(out, 'links.js'));
  const claude = { account: 'default', model: 'claude-opus-5-5' };
  assert.ok(L.sameConnection(claude, { account: 'default', model: 'claude-sonnet-4-5' }), 'Claude models on one account');
  assert.ok(L.sameConnection(claude, { account: 'default', model: undefined }), 'model not known yet');
  assert.ok(!L.sameConnection(claude, { account: 'work', model: 'claude-opus-5-5' }), 'another Claude account');
  assert.ok(!L.sameConnection(claude, { account: 'default', model: 'llama3.1:8b' }), 'a provider model on the same config');
  assert.ok(L.sameConnection({ account: 'default', model: 'llama3.1:8b' }, { account: 'default', model: 'Llama3.1:8B' }));
});

test('accounts: the signed-in email and organization come from Claude Code\'s .claude.json', () => {
  const A = require(path.join(out, 'accounts.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-acc-'));
  const a = { id: 'work', name: 'Work', configDir: dir };
  assert.strictEqual(A.accountIdentity(a), undefined, 'not signed in');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com', organizationName: 'Acme' } }));
  assert.deepStrictEqual(A.accountIdentity(a), { email: 'dev@example.com', organization: 'Acme' });
  assert.strictEqual(A.accountIdentity({ ...a, provider: { id: 'p', preset: 'ollama', baseUrl: 'http://x' } }), undefined, 'providers have no login');
});

test('texts: no garbled characters (encoding damage) in any translated or user-facing text', () => {
  const files = ['package.json', 'package.nls.json', 'package.nls.pt-br.json', 'l10n/bundle.l10n.pt-br.json', 'webview/src/i18n.ts'];
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const bad = text.match(/.{0,30}(?:Ã.|Â[^a-zA-Z]|â€|\uFFFD).{0,30}/);
    assert.ok(!bad, `${f}: "${bad?.[0]}"`);
    assert.ok(!text.startsWith('\uFEFF'), `${f} starts with a byte-order mark`);
  }
});
