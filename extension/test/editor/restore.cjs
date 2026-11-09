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

/** Text the restored chat page shows (read over the DevTools protocol of the relaunched VS Code). */
async function webviewText(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const texts = [];
  for (const t of targets.filter((x) => /vscode-webview:/.test(x.url) && x.webSocketDebuggerUrl)) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const res = await new Promise((r) => {
      ws.onmessage = (e) => r(JSON.parse(e.data));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '(() => { const f = document.querySelector("iframe"); try { return (f?.contentDocument?.body ?? document.body).innerText; } catch { return document.body.innerText; } })()', returnByValue: true } }));
    });
    ws.close();
    const v = res?.result?.result?.value;
    if (v && v.trim()) texts.push(v.trim());
  }
  return texts;
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

async function run(exe, ext, label, open, check, setup, opts = {}) {
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
  // a busy chat needs your real Claude login; the others use an empty config folder
  const env = opts.prompt ? {} : { CLAUDE_CONFIG_DIR: configDir };
  await launch(exe, args, { ...env, STEERHOUSE_TEST_OPEN_CHAT: open(workspace, extra), ...(opts.prompt ? { STEERHOUSE_TEST_PROMPT: opts.prompt, STEERHOUSE_TEST_CLOSE_MS: String(opts.closeMs ?? 25000) } : {}) }, 120_000);
  const port = 9300 + Math.floor(Math.random() * 500);
  const second = launch(exe, [...args, `--remote-debugging-port=${port}`], { ...env, STEERHOUSE_TEST_REPORT: report, STEERHOUSE_TEST_REPORT_MS: String(opts.reportMs ?? 15000) }, 120_000);
  await new Promise((r) => setTimeout(r, (opts.reportMs ?? 15000) - 3000));
  const pages = await webviewText(port).catch((e) => ['(could not read: ' + e.message + ')']);
  await second;
  if (opts.prompt) console.log('  state after relaunch: ' + JSON.stringify(JSON.parse(fs.readFileSync(report, 'utf8')).chats));
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  const tabs = r.tabs.filter((t) => /(steerhouse|agentlens).chat$/.test(t.viewType ?? ''));
  console.log('  page text: ' + JSON.stringify(pages.map((p) => p.slice(0, 120))));
  const page = pages.find((p) => !/^Loading/.test(p)) ?? pages[0] ?? '';
  const stuck = !pages.length ? 'the chat page shows nothing' : /Loading sessions/.test(page) && page.length < 40 ? `the chat page is stuck on "${page}"` : '';
  const problem = stuck || tabs.length !== 1 ? `chat tabs after relaunch: ${tabs.length} (${r.tabs.map((t) => t.label).join(', ')})` : r.chats.length !== 1 ? `the tab came back but Steerhouse did not reconnect it (chats: ${r.chats.length})` : check(r.chats[0], workspace, extra);
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
  // the case from the field: a chat tab saved by AgentLens before the rename to Steerhouse
  ok.push(await run(exe, ext, 'tab left by AgentLens (old name)', (ws) => 'legacy:' + ws, (c, ws) => (!same(c.cwd, ws) ? `wrong folder ${c.cwd}` : '')));
  // the chat was mid-turn when the window reloaded
  if (process.env.STEERHOUSE_E2E)
    ok.push(
      await run(
        exe,
        ext,
        'chat busy when the window closed',
        (ws) => ws,
        (c) => (c.status !== 'idle' ? `still ${c.status} (${c.activity ?? ''}) after the reload` : c.tail.some((it) => it.status === 'running' || it.streaming) ? `items still running: ${JSON.stringify(c.tail)}` : ''),
        undefined,
        { prompt: 'Use the Bash tool to run: sleep 60 . Then reply done.', closeMs: 25000, reportMs: 20000 },
      ),
    );
  if (ok.includes(false)) process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
