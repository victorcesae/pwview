// Plan usage (Claude's /usage windows, OpenRouter key credit), the editor's own icon, and the browser lookup.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-limits-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(`npx esbuild src/chat.ts src/hostIcon.ts src/browser.ts src/tree.ts src/rules.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
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
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-approot-'));
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
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-br-')), 'mybrowser');
  fs.writeFileSync(fake, '');
  assert.strictEqual(B.browserExecutable('custom', fake), fake);
});

test('files tree: folders first, hidden names left out; changed files counted across sessions and sub-agents', () => {
  const T = require(path.join(out, 'tree.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-files-'));
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
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-cfg-'));
  assert.deepStrictEqual(Ru.userRules(cfg).map((r) => [r.label, r.exists]), [['CLAUDE.md', false]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-proj-'));
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
