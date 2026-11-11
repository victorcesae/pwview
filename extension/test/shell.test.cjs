// ! in the chat box: real commands in a real shell, and what the agent is told about them.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-shell-build');
execSync(`npx esbuild src/shell.ts webview/src/views/completion.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const S = require(path.join(out, 'src', 'shell.js'));
const C = require(path.join(out, 'webview', 'src', 'views', 'completion.js'));

const run = (command, cwd = os.tmpdir(), onStart) =>
  new Promise((resolve) => {
    const r = new S.ShellRun(command, { cwd, env: process.env }, () => {}, (d) => resolve({ ...d, output: r.output }));
    onStart?.(r);
  });

test('! : only a message that starts with it, as typed', () => {
  assert.strictEqual(C.shellCommand('!ls -la'), 'ls -la');
  assert.strictEqual(C.shellCommand('! git status  '), 'git status');
  assert.strictEqual(C.shellCommand('!echo a\necho b'), 'echo a\necho b');
  assert.strictEqual(C.shellCommand('!'), undefined);
  assert.strictEqual(C.shellCommand('!   '), undefined);
  assert.strictEqual(C.shellCommand('fix this!'), undefined);
  assert.strictEqual(C.shellCommand(' !ls'), undefined);
});

test('shell: runs in the folder, with stdout and stderr together', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-sh-')));
  fs.writeFileSync(path.join(dir, 'my_file.txt'), 'hello');
  const list = await run(process.platform === 'win32' ? 'dir /b' : 'ls', dir);
  assert.strictEqual(list.exitCode, 0);
  assert.match(list.output, /my_file\.txt/);
  const both = await run('echo out && echo err 1>&2', dir);
  assert.match(both.output, /out/);
  assert.match(both.output, /err/);
});

test('shell: a failing command reports its exit code', async () => {
  assert.strictEqual((await run('exit 3')).exitCode, 3);
});

test('shell: a missing folder is an error, not a crash', async () => {
  const r = await run('echo x', path.join(os.tmpdir(), 'steerhouse-does-not-exist'));
  assert.notStrictEqual(r.exitCode, 0);
  assert.ok(r.error);
});

test('shell: Stop ends the command and what it started', { skip: process.platform === 'win32' }, async () => {
  const marker = path.join(os.tmpdir(), `steerhouse-stop-${process.pid}`);
  let started;
  const done = run(`sleep 30 & echo $! > "${marker}"; wait`, os.tmpdir(), (r) => (started = r));
  for (let i = 0; i < 50 && !(fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim()); i++) await new Promise((z) => setTimeout(z, 50));
  const child = Number(fs.readFileSync(marker, 'utf8'));
  started.stop();
  const r = await done;
  assert.notStrictEqual(r.exitCode, 0);
  await new Promise((z) => setTimeout(z, 200));
  assert.throws(() => process.kill(child, 0), 'the sleep is gone too');
  fs.rmSync(marker);
});

test('shell: a command that waits for input ends instead of hanging', { skip: process.platform === 'win32' }, async () => {
  assert.strictEqual((await run('cat')).exitCode, 0);
});

test('shell: long output keeps its end', async () => {
  const r = await run(`node -e "process.stdout.write('a'.repeat(${S.OUTPUT_LIMIT + 1000})+'END')"`);
  assert.ok(r.output.length <= S.OUTPUT_LIMIT);
  assert.ok(r.output.endsWith('END'));
});

test('agent context: says what ran, and the message reads as written when reopened', () => {
  const note = S.shellContext('git status', 'clean', 0);
  assert.match(note, /exit-code="0"/);
  assert.match(note, /\$ git status\nclean/);
  assert.match(S.shellContext('x', '', null), /exit-code="stopped"/);
  assert.ok(S.tail('x'.repeat(50), 10).startsWith('[…earlier output cut…]'));
  assert.strictEqual(S.withoutShellContext(`fix it\n\n${note}\n\n${note}`), 'fix it');
  assert.strictEqual(S.withoutShellContext(note), '');
  assert.strictEqual(S.withoutShellContext('look at it\n\n<steerhouse-note>\nthe browser is at …\n</steerhouse-note>'), 'look at it', 'Steerhouse\'s notes to the agent stay out of the bubble');
  assert.strictEqual(S.withoutShellContext('plain'), 'plain');
});

test('chat: the output reaches the agent once, with the next message, and starts no turn by itself', async () => {
  const chatOut = path.join(os.tmpdir(), 'steerhouse-shell-chat-build');
  execSync(`npx esbuild src/chat.ts --bundle --platform=node --format=cjs --outdir="${chatOut}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { ChatSession } = require(path.join(chatOut, 'chat.js'));
  const chat = new ChatSession({ cwd: os.tmpdir() }, () => {});
  const statusBefore = chat.state.status;
  chat.runShell('echo from_the_shell');
  const item = chat.state.items.at(-1);
  assert.strictEqual(item.kind, 'shell');
  for (let i = 0; i < 100 && item.status === 'running'; i++) await new Promise((z) => setTimeout(z, 20));
  assert.strictEqual(item.status, 'done');
  assert.match(item.output, /from_the_shell/);
  assert.strictEqual(chat.state.status, statusBefore, 'no turn started');
  chat.send('now fix it', [], 'later');
  const it = chat.input[Symbol.asyncIterator]();
  const first = (await it.next()).value;
  const told = first.message.content.map((c) => c.text).join('');
  assert.match(told, /^now fix it\n\n<user-ran-command exit-code="0">/);
  assert.match(told, /from_the_shell/);
  assert.strictEqual(chat.state.items.at(-1).text, 'now fix it', 'the bubble stays as written');
  chat.state.status = 'idle';
  chat.send('again', [], 'later');
  const second = (await it.next()).value;
  assert.strictEqual(second.message.content.map((c) => c.text).join(''), 'again', 'told only once');
  chat.close();
});

test('background commands: reading text about one is not one; a removed output file is reported', () => {
  const bgOut = path.join(os.tmpdir(), 'steerhouse-shell-bg-build');
  execSync(`npx esbuild src/bgtasks.ts --bundle --platform=node --format=cjs --outdir="${bgOut}" --log-level=error`, { cwd: root });
  const B = require(path.join(bgOut, 'bgtasks.js'));
  const phantom = '22\t/** "Command running in background with ID: b2tazn3ft. Output is being written to: C:\\…\\b2tazn3ft.output." */';
  const t = new B.BgTaskTracker();
  t.toolUse('read', 'Read', { file_path: 'bgtasks.ts' });
  t.toolResult('read', phantom);
  t.toolUse('cat', 'Bash', { command: 'cat bgtasks.ts' });
  t.toolResult('cat', phantom);
  assert.deepStrictEqual(t.tasks, [], 'no phantom command');
  t.toolUse('bg', 'Bash', { command: 'npm run dev', run_in_background: true });
  t.toolResult('bg', 'Command running in background with ID: abc123. Output is being written to: /tmp/x/abc123.output. You will be notified.');
  t.toolResult('moved', 'Command running in background with ID: def456. Output is being written to: /tmp/x/def456.output.');
  assert.deepStrictEqual(t.tasks.map((x) => [x.id, x.outputFile]), [['abc123', '/tmp/x/abc123.output'], ['def456', '/tmp/x/def456.output']]);
  assert.strictEqual(B.readTail('/tmp/steerhouse-no-such-file.output').missing, true);
  assert.strictEqual(B.readTail(undefined).missing, true);
  assert.strictEqual(B.readTail(__filename).missing, undefined);
});

test('commands the agent waits on: live output from the session folder, then the result', () => {
  const chatOut = path.join(os.tmpdir(), 'steerhouse-shell-task-build');
  execSync(`npx esbuild src/chat.ts src/bgtasks.ts --bundle --platform=node --format=cjs --outdir="${chatOut}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const B = require(path.join(chatOut, 'bgtasks.js'));
  const { ChatSession } = require(path.join(chatOut, 'chat.js'));
  assert.strictEqual(B.sessionTasksDir('/home/me/projects', 'abc', 'linux', '/tmp', 1001), '/tmp/claude-1001/-home-me-projects/abc/tasks');
  assert.strictEqual(B.sessionTasksDir('C:\\w\\app', 'abc', 'win32', 'C:\\Temp'), 'C:\\Temp\\claude\\C--w-app\\abc\\tasks');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-task-'));
  const saved = process.env.CLAUDE_CODE_TMPDIR;
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  try {
    const chat = new ChatSession({ cwd: '/w/app' }, () => {});
    chat.state.sessionId = 'sess';
    chat.state.items.push({ kind: 'tool', id: 'tu1', name: 'Bash', summary: '', input: {}, status: 'running' });
    chat.state.tasks.push({ id: 'b1', toolUseId: 'tu1', command: 'npm test', status: 'running' });
    const file = path.join(B.sessionTasksDir('/w/app', 'sess', process.platform, tmp), 'b1.output');

    // running, nothing written yet: can still be followed
    let r = chat.taskOutput('b1');
    assert.strictEqual(r.missing, true);
    assert.strictEqual(r.file, file);
    // running, writing
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'live line\n');
    r = chat.taskOutput('b1');
    assert.strictEqual(r.text, 'live line\n');
    assert.strictEqual(r.file, file);
    // finished: the file is deleted, the result stays, there is no file to follow
    fs.rmSync(file);
    chat.state.tasks[0].status = 'completed';
    chat.state.items[0].result = 'final output';
    r = chat.taskOutput('b1');
    assert.strictEqual(r.text, 'final output');
    assert.ok(!r.missing);
    assert.strictEqual(r.file, undefined);
    // a background notice is not output
    chat.state.items[0].result = 'Command running in background with ID: b1. Output is being written to: /x/b1.output.';
    r = chat.taskOutput('b1');
    assert.strictEqual(r.missing, true);
    assert.strictEqual(r.file, undefined);
    // another command's folder (an earlier session, in a resumed chat) only counts if the file is there
    const other = path.join(tmp, 'other');
    chat.state.tasks.push({ id: 'b2', command: 'x', status: 'completed', outputFile: path.join(other, 'b2.output') });
    assert.strictEqual(chat.taskFile(chat.state.tasks[0]), file, 'its own session by default');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'b1.output'), 'x');
    assert.strictEqual(chat.taskFile(chat.state.tasks[0]), path.join(other, 'b1.output'));
    fs.writeFileSync(file, 'mine');
    assert.strictEqual(chat.taskFile(chat.state.tasks[0]), file, 'its own session wins');
    assert.strictEqual(chat.taskOutput('nope').missing, true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = saved;
  }
});

test('dropping files: paths from VS Code, written relative to the chat folder', () => {
  const get = (o) => (type) => o[type] ?? '';
  assert.deepStrictEqual(C.droppedPaths(get({ 'application/vnd.code.uri-list': 'vscode-remote://ssh-remote%2Bhost/home/me/app/src/a%20b.ts\r\nfile:///home/me/x.ts' })), ['/home/me/app/src/a b.ts', '/home/me/x.ts']);
  assert.deepStrictEqual(C.droppedPaths(get({ 'text/uri-list': '# comment\nfile:///c%3A/w/a.ts' })), ['c:/w/a.ts']);
  assert.deepStrictEqual(C.droppedPaths(get({ codefiles: '["/w/a.ts"]' })), ['/w/a.ts']);
  assert.deepStrictEqual(C.droppedPaths(get({ 'text/uri-list': 'https://example.com/a' })), [], 'a web link is not a file');
  assert.deepStrictEqual(C.droppedPaths(get({})), []);
  assert.strictEqual(C.mention('/home/me/app/src/a.ts', '/home/me/app'), '`src/a.ts`');
  assert.strictEqual(C.mention('/home/me/other/a.ts', '/home/me/app'), '`/home/me/other/a.ts`');
  assert.strictEqual(C.mention('/home/me/app-2/a.ts', '/home/me/app'), '`/home/me/app-2/a.ts`', 'a similar name is not inside');
  assert.strictEqual(C.mention('C:\\w\\src\\a.ts', 'c:\\w'), '`src/a.ts`');
});

test('follow view: shows output as written, ignores typing, says when the file is gone', async () => {
  const fOut = path.join(os.tmpdir(), 'steerhouse-follow-build');
  execSync(`npx esbuild src/follow.ts --bundle --platform=node --format=cjs --outdir="${fOut}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
  const F = require(path.join(fOut, 'follow.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-follow-'));
  const file = path.join(dir, 'x.output');
  fs.writeFileSync(file, 'one\nolá ');
  const pty = F.followPty(file, 'My chat: npm test');
  let shown = '';
  let closed = false;
  pty.onDidWrite((s) => (shown += s));
  pty.onDidClose(() => (closed = true));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  pty.open();
  assert.match(shown, /My chat: npm test/);
  assert.match(shown, /one\r\nolá /, 'terminal line ends');
  // a character split across two writes stays whole
  const fd = fs.openSync(file, 'a');
  const e = Buffer.from('é');
  fs.writeSync(fd, e.subarray(0, 1));
  await wait(600);
  fs.writeSync(fd, e.subarray(1));
  fs.writeSync(fd, Buffer.from('\ntwo\n'));
  fs.closeSync(fd);
  await wait(600);
  assert.match(shown, /olá é\r\ntwo\r\n/);
  const before = shown;
  pty.handleInput('source /x/.venv/bin/activate\r');
  await wait(50);
  assert.strictEqual(shown, before, 'what other extensions type goes nowhere');
  assert.ok(!closed);
  fs.rmSync(file);
  await wait(600);
  assert.match(shown, /command has finished/);
  pty.handleInput('\x03');
  assert.ok(closed, 'Ctrl+C closes the view');
  pty.close();
});

test('tool pictures: shown from a live result and from a transcript, too large ones noted', () => {
  const out2 = path.join(os.tmpdir(), 'steerhouse-toolimg-build');
  execSync(`npx esbuild src/chat.ts --bundle --platform=node --format=cjs --outdir="${out2}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { resultImages, historyFromTranscript } = require(path.join(out2, 'chat.js'));
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  assert.deepStrictEqual(resultImages([{ type: 'text', text: 'x' }, png]), { images: ['data:image/png;base64,iVBORw0KGgo='], skipped: 0 });
  const huge = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(7 * 1024 * 1024) } };
  assert.deepStrictEqual(resultImages([png, png, png, png, png, huge]).images.length, 4);
  assert.strictEqual(resultImages([png, png, png, png, png, huge]).skipped, 2);
  assert.deepStrictEqual(resultImages('text'), { images: [], skipped: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-toolimg-'));
  const file = path.join(dir, 's.jsonl');
  const rec = (o) => JSON.stringify({ sessionId: 's', cwd: '/w', timestamp: new Date().toISOString(), ...o });
  fs.writeFileSync(file, [
    rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'look at the screenshot' } }),
    rec({ type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/tmp/ds-device-3.png' } }] } }),
    rec({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [png] }] } }),
  ].join('\n') + '\n');
  const read = historyFromTranscript(file).items.find((i) => i.kind === 'tool');
  assert.deepStrictEqual(read.images, ['data:image/png;base64,iVBORw0KGgo=']);
  assert.ok(!/\[image\]/.test(read.result ?? ''), 'no placeholder text');
});
