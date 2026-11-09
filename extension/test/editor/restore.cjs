// Reload test with a real VS Code (not the test runner, which kills the window and so never saves
// open tabs). Launch 1 opens an Steerhouse chat and closes the window normally; launch 2, same
// profile and folder, reports which tabs VS Code brought back and which chats Steerhouse filled.
// Two cases: a new chat, and a resumed Claude Code session (with its title).
// Run: npm run test:restore
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;

function launch(exe, args, env, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const p = cp.spawn(exe, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
    const t = setTimeout(() => (p.kill(), reject(new Error('VS Code did not close in time'))), timeoutMs);
    p.on('exit', () => (clearTimeout(t), resolve()));
  });
}

/** A Claude Code transcript in a private config dir, so the extension sees one session. */
function fakeSession(configDir, cwd) {
  const id = '6f1c2a10-0000-4000-8000-00000000abcd';
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const rec = (o) => JSON.stringify({ sessionId: id, cwd, timestamp: now, ...o });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    [
      rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Add a README' } }),
      rec({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
      rec({ type: 'custom-title', customTitle: 'Restore me after reload' }),
    ].join('\n') + '\n',
  );
  return id;
}

async function run(exe, ext, label, open, check, setup) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-restore-ws-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-restore-ud-'));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-restore-claude-'));
  const extra = setup?.(configDir, workspace) ?? {};
  // the test folders live in the temp dir, which Steerhouse hides by default
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'steerhouse.hideTempSessions': false }));
  const report = path.join(os.tmpdir(), `steerhouse-restore-${Date.now()}.json`);
  const extDir = path.join(ext, '.vscode-test', 'extensions-en');
  const args = [workspace, '--extensionDevelopmentPath=' + ext, '--user-data-dir', userData, '--extensions-dir', extDir, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'];
  const env = { CLAUDE_CONFIG_DIR: configDir };
  await launch(exe, args, { ...env, STEERHOUSE_TEST_OPEN_CHAT: open(workspace, extra) });
  await launch(exe, args, { ...env, STEERHOUSE_TEST_REPORT: report });
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  const tabs = r.tabs.filter((t) => t.viewType?.endsWith('steerhouse.chat'));
  const problem = tabs.length !== 1 ? `chat tabs after relaunch: ${tabs.length} (${r.tabs.map((t) => t.label).join(', ')})` : r.chats.length !== 1 ? `the tab came back but Steerhouse did not reconnect it (chats: ${r.chats.length})` : check(r.chats[0], workspace, extra);
  console.log(problem ? `✖ restore (${label}): ${problem}` : `✔ restore (${label}): ${r.chats[0].title} reopened in ${path.basename(r.chats[0].cwd)}`);
  return !problem;
}

async function main() {
  const ext = path.join(__dirname, '..', '..');
  const exe = await downloadAndUnzipVSCode('stable');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const ok = [
    await run(exe, ext, 'new chat', (ws) => ws, (c, ws) => (!same(c.cwd, ws) ? `wrong folder ${c.cwd}` : '')),
    await run(
      exe,
      ext,
      'resumed session',
      (ws, x) => 'resume:' + x.id,
      (c, ws, x) => (c.sessionId !== x.id ? `wrong session ${c.sessionId}` : c.title !== 'Restore me after reload' ? `wrong title ${c.title}` : ''),
      (configDir, ws) => ({ id: fakeSession(configDir, ws) }),
    ),
  ];
  if (ok.includes(false)) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
