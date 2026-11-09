// Tab completion in the code editor, against a fake Anthropic-compatible server.
const { execSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-completion-build');
execSync(`npx esbuild src/codeCompletion.ts --bundle --platform=node --format=cjs --outdir="${out}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const C = require(path.join(out, 'codeCompletion.js'));

test('sensitive files are never sent', () => {
  for (const f of ['/w/.env', '/w/.env.production', '/w/server.pem', '/w/tls.key', '/home/me/.ssh/config', '/home/me/.aws/config', '/w/.npmrc', '/w/secrets.yaml', '/w/credentials.json', 'C:\\w\\id_rsa']) assert.ok(C.isSensitive(f), f);
  for (const f of ['/w/.env.example', '/w/app.ts', '/w/keyboard.ts', '/w/secret-santa.ts', '/w/README.md']) assert.ok(!C.isSensitive(f), f);
});

test('suggests at the end of a line or before closing characters only', () => {
  for (const rest of ['', '  ', ')', '");', ' }']) assert.ok(C.worthSuggesting(rest), JSON.stringify(rest));
  for (const rest of ['foo', ' + 1']) assert.ok(!C.worthSuggesting(rest), rest);
});

test('the reply is cleaned: fences, repeats, overlap, cut lines', () => {
  assert.strictEqual(C.cleanCompletion('return 1;', 'function f() {\n  ', '\n}'), 'return 1;');
  assert.strictEqual(C.cleanCompletion('```ts\nreturn 1;\n```', 'x', ''), 'return 1;');
  assert.strictEqual(C.cleanCompletion('const a = 1;', 'const a', ''), ' = 1;');
  assert.strictEqual(C.cleanCompletion('bar);', 'foo(', ');'), 'bar', 'overlap with what follows is removed');
  assert.strictEqual(C.cleanCompletion('foo(a);', 'foo(', 'a);'), undefined, 'nothing new to suggest');
  assert.strictEqual(C.cleanCompletion('one\ntwo\nthr', 'x', '', true), 'one\ntwo', 'a line cut by the token limit is dropped');
  assert.strictEqual(C.cleanCompletion('   \n', 'x', ''), undefined);
  assert.strictEqual(C.cleanCompletion(Array(50).fill('l').join('\n'), 'x', '').split('\n').length, 20);
});

test('local means on this machine', () => {
  assert.ok(C.isLocal({ baseUrl: 'http://localhost:11434' }));
  assert.ok(C.isLocal({ baseUrl: 'http://127.0.0.1:4000/' }));
  assert.ok(!C.isLocal({ baseUrl: 'https://openrouter.ai/api' }));
  assert.ok(!C.isLocal({ baseUrl: 'http://localhost.evil.test' }));
});

function setup(t, reply = 'return 42;', status = 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      calls.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      const provider = { id: 'p', name: 'Fake', preset: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}/`, model: 'chat-model', hasKey: true };
      resolve({ calls, provider });
    });
  });
}

const never = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const doc = (text, file = '/w/app.ts') => ({
  uri: { fsPath: file },
  languageId: 'typescript',
  getText: () => text,
  offsetAt: (p) => p.offset,
  lineAt: () => ({ text }),
});
const at = (offset) => ({ offset, character: offset, line: 0 });
const engine = (provider, over = {}) => new C.CodeCompletion(() => ({ enabled: true, provider: 'p', model: '', delayMs: 0, ...over }), () => [provider], async () => 'secret-key');
const ask = (e, d, offset, ctx = {}, token = never) => e.provideInlineCompletionItems(d, at(offset), ctx, token);

test('asks the provider and returns the suggestion at the cursor', async (t) => {
  const { calls, provider } = await setup(t);
  const items = await ask(engine(provider), doc('function f() {'), 14);
  assert.strictEqual(items[0].insertText, 'return 42;');
  assert.strictEqual(calls[0].url, '/v1/messages');
  assert.strictEqual(calls[0].key, 'secret-key');
  assert.strictEqual(calls[0].body.model, 'chat-model');
  assert.match(calls[0].body.messages[0].content, /function f\(\) \{<CURSOR>/);
});

test('a separate completion model is used when set; the same spot is not asked twice', async (t) => {
  const { calls, provider } = await setup(t);
  const e = engine(provider, { model: 'fast' });
  await ask(e, doc('let x ='), 7);
  await ask(e, doc('let x ='), 7);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].body.model, 'fast');
});

test('nothing is sent when off, without a provider, for a sensitive file, mid-line or with the list open', async (t) => {
  const { calls, provider } = await setup(t);
  assert.strictEqual(await ask(engine(provider, { enabled: false }), doc('let x'), 5), undefined);
  assert.strictEqual(await ask(engine(provider, { provider: '' }), doc('let x'), 5), undefined);
  assert.strictEqual(await ask(engine(provider), doc('TOKEN=', '/w/.env'), 6), undefined);
  assert.strictEqual(await ask(engine(provider), doc('let x = foo'), 5), undefined);
  assert.strictEqual(await ask(engine(provider), doc('let x'), 5, { selectedCompletionInfo: {} }), undefined);
  assert.strictEqual(await ask(engine(provider), doc('   '), 3), undefined);
  assert.strictEqual(calls.length, 0);
});

test('typing again before the pause ends sends nothing', async (t) => {
  const { calls, provider } = await setup(t);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const pending = ask(engine(provider, { delayMs: 50 }), doc('let x'), 5, {}, token);
  token.isCancellationRequested = true;
  assert.strictEqual(await pending, undefined);
  assert.strictEqual(calls.length, 0);
});

test('a server error reaches the status bar, not the editor', async (t) => {
  const { provider } = await setup(t, '', 401);
  const e = engine(provider);
  const seen = [];
  e.onStatus = (err) => seen.push(err);
  assert.strictEqual(await ask(e, doc('let x'), 5), undefined);
  assert.match(seen[0], /Fake: HTTP 401/);
});

test('a subscription answers through its account, waits for a real pause, and is cleaned like the others', async () => {
  const asked = [];
  const source = { id: 'claude:default', name: 'Claude', account: 'default' };
  const e = new C.CodeCompletion(() => ({ enabled: true, provider: 'claude:default', model: '', delayMs: 0 }), () => [source], async () => undefined, async (account, model, user) => {
    asked.push({ account, user });
    return { text: '```js\nreturn 42;\n```', cut: false };
  });
  const t0 = Date.now();
  const items = await ask(e, doc('function f() {'), 14);
  assert.ok(Date.now() - t0 >= C.SUBSCRIPTION_MIN_DELAY_MS - 20, 'waits even when the setting says 0');
  assert.strictEqual(items[0].insertText, 'return 42;');
  assert.strictEqual(asked[0].account, 'default');
  assert.match(asked[0].user, /<CURSOR>/);
  // typing during the pause sends nothing
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const pending = ask(e, doc('let other'), 9, {}, token);
  token.isCancellationRequested = true;
  assert.strictEqual(await pending, undefined);
  assert.strictEqual(asked.length, 1);
  // a sensitive file never reaches it
  assert.strictEqual(await ask(e, doc('TOKEN=', '/w/.env'), 6), undefined);
  assert.strictEqual(asked.length, 1);
});
