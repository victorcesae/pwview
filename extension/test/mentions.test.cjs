// @problems, @diff, @chat:, @url: and path#L5-10 in the chat box.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-mentions-build');
execSync(`npx esbuild src/mentions.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const M = require(path.join(out, 'mentions.js'));

test('mentions are found in code and bare, once each', () => {
  const md = 'look at `@problems` and `src/a.ts#L5-10` plus @diff:main and @url:https://x.dev/a\\_b and `@chat:Fix login` `@problems` `src/b.ts`';
  assert.deepStrictEqual(
    M.parseMentions(md).map((m) => [m.kind, m.raw]),
    [
      ['problems', '@problems'],
      ['lines', 'src/a.ts#L5-10'],
      ['chat', '@chat:Fix login'],
      ['diff', '@diff:main'],
      ['url', '@url:https://x.dev/a_b'],
    ],
  );
  assert.deepStrictEqual(M.parseMentions('`a.ts#L7`')[0], { kind: 'lines', raw: 'a.ts#L7', file: 'a.ts', from: 7, to: 7 });
});

test('menu suggestions follow what is typed', () => {
  assert.deepStrictEqual(M.mentionCompletions('di', [], 'main'), ['@diff', '@diff:main']);
  assert.deepStrictEqual(M.mentionCompletions('chat:log', ['Fix login', 'Docs']), ['@chat:Fix login']);
  assert.deepStrictEqual(M.mentionCompletions('url:https://a.b', []), ['@url:https://a.b']);
  assert.deepStrictEqual(M.mentionCompletions('url:', []), []);
});

test('html becomes text', () => {
  assert.strictEqual(M.htmlToText('<head><title>x</title></head><script>a()</script><p>Hi &amp; <b>bye</b></p><ul><li>one</li></ul>'), 'Hi & bye\n\n- one');
});

test('lines and chat summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-mentions-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'one\ntwo\nthree\nfour');
  assert.match(M.readLines(dir, 'a.ts', 2, 3), /2: two\n3: three\n```$/);
  const s = M.transcriptSummary('T', [
    { kind: 'user', text: 'q1' },
    { kind: 'assistant', text: 'mid' },
    { kind: 'assistant', text: 'sub', parent: 'tool' },
    { kind: 'assistant', text: 'final' },
  ]);
  assert.match(s, /q1\n\n## Answer 1\nfinal/);
});

test('resolving never throws: a failure is reported in the note', async () => {
  const notes = await M.resolveMentions('`nope.ts#L1-2` `@chat:X`', { cwd: os.tmpdir(), problems: () => '', chat: () => undefined });
  assert.match(notes[0], /could not be read/);
  assert.match(notes[1], /No chat named "X"/);
});
