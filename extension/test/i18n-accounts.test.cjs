// Localization (manifest, runtime bundle, webview) and multiple Claude accounts.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-i18n-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(
  `npx esbuild src/accounts.ts src/engine.ts webview/src/i18n.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --log-level=error`,
  { cwd: root },
);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-acc-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.HOME = home;
process.env.USERPROFILE = home;

// ------------------------------------------------------------------ localization

test('i18n: every manifest string has English and pt-BR text', () => {
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const keys = [...pkg.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50, 'manifest is localized');
  const en = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const pt = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.pt-br.json'), 'utf8'));
  for (const k of keys) {
    assert.ok(en[k], `English for ${k}`);
    assert.ok(pt[k], `pt-BR for ${k}`);
  }
  const raw = JSON.parse(pkg);
  for (const c of raw.contributes.commands) assert.match(c.title, /^%.+%$/, `command ${c.command} title is localized`);
});

test('i18n: runtime bundle covers every vscode.l10n.t string in the code', () => {
  const src = fs.readdirSync(path.join(root, 'src')).map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  const used = [...src.matchAll(/vscode\.l10n\.t\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  const pt = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.pt-br.json'), 'utf8'));
  for (const s of new Set(used)) assert.ok(pt[s], `pt-BR for "${s}"`);
});

test('i18n: the UI follows the editor language and falls back to English', () => {
  const load = (lang) => {
    delete require.cache[path.join(out, 'webview', 'src', 'i18n.js')];
    globalThis.document = { documentElement: { lang } };
    return require(path.join(out, 'webview', 'src', 'i18n.js')).t;
  };
  let t = load('pt-br');
  assert.equal(t('Send now'), 'Send now', 'developer terms stay in English');
  assert.equal(t('Steer'), 'Steer');
  assert.equal(t('Jump to latest'), 'Ir para o fim');
  assert.equal(t('Allow {0}?', 'Bash'), 'Permitir Bash?');
  assert.equal(t('{0}/{1} done', 2, 4), '2/4 feitos');
  assert.equal(t('Some new string'), 'Some new string', 'untranslated text stays English');
  t = load('pt');
  assert.equal(t('Stop'), 'Parar');
  t = load('ja');
  assert.equal(t('Send now'), 'Send now');
  delete globalThis.document;
});

// ------------------------------------------------------------------ accounts

test('accounts: each account is its own Claude config folder', () => {
  const a = require(path.join(out, 'src', 'accounts.js'));
  assert.deepEqual(a.listAccounts().map((x) => x.id), ['default']);
  const work = a.addAccount('Work Account');
  const work2 = a.addAccount('Work Account');
  assert.equal(work.id, 'work-account');
  assert.equal(work2.id, 'work-account-2', 'names never collide');
  assert.ok(fs.existsSync(work.configDir));
  assert.deepEqual(a.accountEnv(work), { CLAUDE_CONFIG_DIR: work.configDir });
  assert.deepEqual(a.accountEnv(a.defaultAccount()), {}, 'default account runs with the normal ~/.claude');
  a.setPreferred(work.id);
  assert.equal(a.preferredAccount().id, work.id);
  a.removeAccount(work.id);
  assert.equal(a.preferredAccount().id, 'default');
  assert.deepEqual(a.listAccounts().map((x) => x.id), ['default', 'work-account-2']);
});

test('accounts: sessions from every account are listed and labelled', () => {
  const { Engine } = require(path.join(out, 'src', 'engine.js'));
  const write = (dir, sid, title) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, sid + '.jsonl'),
      [{ type: 'custom-title', customTitle: title }, { type: 'user', cwd: '/repo', timestamp: new Date().toISOString(), message: { content: title } }].map((l) => JSON.stringify(l)).join('\n'),
    );
  };
  const personal = path.join(home, 'p', 'projects');
  const work = path.join(home, 'w', 'projects');
  write(path.join(personal, 'repo'), 's-personal', 'Personal task');
  write(path.join(work, 'repo'), 's-work', 'Work task');
  const sessions = new Engine(() => [
    { account: 'default', dir: personal },
    { account: 'work', dir: work },
  ]).scan(1);
  const by = Object.fromEntries(sessions.map((s) => [s.info.title, s.info.account]));
  assert.deepEqual(by, { 'Personal task': 'default', 'Work task': 'work' });
});
