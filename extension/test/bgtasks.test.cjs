// Background commands (dev servers, watchers): found in transcripts in Claude Code's real formats,
// status from task notifications, live output tail, dev-server URLs, following in a terminal.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-bg-build');
execSync(`npx esbuild src/bgtasks.ts src/engine.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const B = require(path.join(out, 'bgtasks.js'));
const E = require(path.join(out, 'engine.js'));

const started = 'Command running in background with ID: b2tazn3ft. Output is being written to: C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x\\tasks\\b2tazn3ft.output. You will be notified when it completes.';
const notification = (id, status) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/${id}.output</output-file>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;

test('bg: the "running in background" result gives the task id and output file', () => {
  assert.deepStrictEqual(B.parseStarted(started), { id: 'b2tazn3ft', outputFile: 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\x\\tasks\\b2tazn3ft.output' });
  assert.strictEqual(B.parseStarted('exit code 0'), undefined);
});

test('bg: task notifications (several in one text), statuses mapped', () => {
  const n = B.parseNotifications(`hi ${notification('a1', 'completed')} and ${notification('a2', 'killed')} ${notification('a3', 'failed')}`);
  assert.deepStrictEqual(n.map((x) => [x.id, x.status]), [['a1', 'completed'], ['a2', 'stopped'], ['a3', 'failed']]);
  assert.strictEqual(n[0].outputFile, '/tmp/a1.output');
  assert.deepStrictEqual(['running', 'pending', 'completed', 'failed', 'killed', 'x'].map(B.sdkStatus), ['running', 'running', 'completed', 'failed', 'stopped', undefined]);
});

test('bg: tracker keeps only background Bash calls, then updates their status', () => {
  const t = new B.BgTaskTracker();
  t.toolUse('u1', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }, '2026-11-09T10:00:00Z');
  t.toolUse('u2', 'Bash', { command: 'ls' }, '2026-11-09T10:01:00Z');
  t.toolResult('u2', 'a.txt');
  t.toolResult('u1', started.replace('b2tazn3ft', 'dev1').replace('b2tazn3ft', 'dev1'));
  assert.deepStrictEqual(t.tasks.map((x) => [x.id, x.command, x.description, x.status]), [['dev1', 'npm run dev', 'Start the dev server', 'running']]);
  t.text(notification('dev1', 'stopped'), '2026-11-09T11:00:00Z');
  assert.strictEqual(t.tasks[0].status, 'stopped');
  assert.strictEqual(t.tasks[0].ended, '2026-11-09T11:00:00Z');
});

test('bg: dev-server URLs from output; colour codes stripped', () => {
  const text = '\x1b[32m  VITE v6.0.0  ready\x1b[0m\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://0.0.0.0:5173/\nalso http://127.0.0.1:3000/api, and https://example.com/x';
  assert.deepStrictEqual(B.findUrls(B.stripAnsi(text)), ['http://localhost:5173/', 'http://127.0.0.1:3000/api']);
  assert.strictEqual(B.stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});

test('bg: output tail starts at a whole line; a missing file reads as empty', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-bg-')), 'x.output');
  fs.writeFileSync(f, Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'));
  const r = B.readTail(f, 100);
  assert.ok(r.text.startsWith('line '), r.text.slice(0, 20));
  assert.ok(r.text.endsWith('line 1999'));
  assert.ok(r.size > 100);
  assert.deepStrictEqual(B.readTail(path.join(os.tmpdir(), 'nope.output')), { text: '', size: 0, missing: true });
  assert.strictEqual(B.readTail(undefined).text, '');
});

test('bg: a running task of a session not driven by Steerhouse is "running" only while its output changes', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-bg-')), 'y.output');
  fs.writeFileSync(f, 'x');
  const t = { id: 'y', command: 'npm run dev', status: 'running', outputFile: f };
  assert.strictEqual(B.guessStatus(t, false), 'running');
  assert.strictEqual(B.guessStatus(t, false, Date.now() + 10 * 60_000), 'unknown');
  assert.strictEqual(B.guessStatus({ ...t, status: 'completed' }, true), 'completed');
});

test('bg: follow command per OS, with quotes in the path escaped', () => {
  assert.deepStrictEqual(B.followCommand("C:\\t\\it's.output", 'win32'), { shell: 'powershell.exe', args: ['-NoProfile', '-NoLogo', '-Command', "Get-Content -LiteralPath 'C:\\t\\it''s.output' -Tail 200 -Wait"] });
  assert.deepStrictEqual(B.followCommand("/tmp/it's.output", 'linux'), { shell: '/bin/sh', args: ['-c', "tail -n 200 -F '/tmp/it'\\''s.output'"] });
});

test('bg: the engine lists a session\'s background commands from its transcript', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-bg-')), 's.jsonl');
  const rec = (o) => JSON.stringify({ timestamp: '2026-11-09T10:00:00Z', ...o });
  fs.writeFileSync(
    file,
    [
      rec({ type: 'user', message: { role: 'user', content: 'start the app' } }),
      rec({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm dev', description: 'Dev server', run_in_background: true } }] } }),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: started.replace(/b2tazn3ft/g, 'devA') }] }] } }),
      rec({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test -- --watch', run_in_background: true } }] } }),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'Command running in background with ID: watchB. Output is being written to: /tmp/watchB.output.' }] } }),
      rec({ type: 'user', message: { role: 'user', content: notification('watchB', 'completed') } }),
    ].join('\n'),
  );
  const t = E.parse(file, 's');
  assert.deepStrictEqual(t.tasks.map((x) => [x.id, x.command, x.status]), [['devA', 'pnpm dev', 'running'], ['watchB', 'npm test -- --watch', 'completed']]);
});
