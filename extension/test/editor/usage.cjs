// Using Steerhouse like a person: a real VS Code window, real clicks and typing, with screenshots.
// Sends no message to the agent unless USAGE_AGENT=1. Run: xvfb-run -a node test/editor/usage.cjs
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { removeTestSession } = require('../e2e-cleanup.cjs');

delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.VSCODE_IPC_HOOK_CLI;
const shots = process.env.USAGE_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-usage-shots-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];
const note = (ok, what) => {
  findings.push(`${ok ? '✔' : '✖'} ${what}`);
  console.log(`${ok ? '✔' : '✖'} ${what}`);
};

async function main() {
  const ext = path.join(__dirname, '..', '..');
  const exe = await downloadAndUnzipVSCode('stable');
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-e2e-usage-')));
  const repo = (n) => {
    const d = path.join(ws, n);
    fs.mkdirSync(d);
    cp.execSync('git init -q', { cwd: d });
    fs.writeFileSync(path.join(d, 'package.json'), `{"name":"${n}"}`);
    fs.writeFileSync(path.join(d, 'my_file.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(d, '__init__.py'), '');
  };
  repo('alpha');
  repo('beta');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-usage-ud-'));
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'steerhouse.hideTempSessions': false, 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'window.titleBarStyle': 'custom', 'window.dialogStyle': 'custom' }));
  const port = 9900 + Math.floor(Math.random() * 90);
  const extDir = path.join(ext, '.vscode-test', 'extensions-en');
  const code = cp.spawn(exe, [ws, `--extensionDevelopmentPath=${ext}`, '--user-data-dir', userData, '--extensions-dir', extDir, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--new-window', `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 60 && !browser; i++) {
      await wait(1000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined);
    }
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      await wait(500);
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => /workbench/.test(p.url()));
    }
    if (!page) throw new Error(`no VS Code window: ${JSON.stringify(browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()))}`);
    page.on('pageerror', (e) => note(false, `page error: ${e.message.slice(0, 160)}`));
    await wait(9000);
    const shot = async (name) => {
      await page.screenshot({ path: path.join(shots, `${name}.png`) });
      console.log(`  [screenshot ${name}]`);
    };
    const palette = async (cmd) => {
      await page.keyboard.press('Control+Shift+P');
      await wait(400);
      await page.keyboard.type(cmd);
      await wait(700);
      await page.keyboard.press('Enter');
      await wait(900);
    };
    const quickPickRows = () => page.locator('.quick-input-widget:visible .monaco-list-row').allInnerTexts();
    // the chat page lives in a nested frame of the webview
    const chatFrame = async () => {
      for (let i = 0; i < 40; i++) {
        for (const f of page.frames()) {
          if (await f.locator('.rich-input').count().catch(() => 0)) return f;
        }
        await wait(500);
      }
      throw new Error('no chat page');
    };
    const api = { page, wait, shot, palette, quickPickRows, chatFrame, note, ws, shots, fs, path, os, cp, ext };
    await require(process.env.USAGE_SCENARIO || './usage-scenario.cjs')(api);
  } finally {
    await browser?.close().catch(() => {});
    code.kill();
    await wait(1500);
    // nothing of this test keeps running or stays in the session list
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const relays = path.join(config, 'steerhouse', 'relays');
    for (const f of fs.existsSync(relays) ? fs.readdirSync(relays) : []) {
      if (!f.endsWith('.json') || f.endsWith('.spec.json')) continue;
      try {
        const e = JSON.parse(fs.readFileSync(path.join(relays, f), 'utf8'));
        if (String(e.cwd).startsWith(ws)) process.kill(e.pid, 'SIGTERM');
      } catch {}
    }
    await removeTestSession(ws);
    for (const sub of ['alpha', 'beta']) fs.rmSync(path.join(config, 'projects', path.join(ws, sub).replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
    console.log(`\nscreenshots: ${shots}`);
    console.log(findings.join('\n'));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
