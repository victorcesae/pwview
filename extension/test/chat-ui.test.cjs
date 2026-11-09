// Chat UI logic: grouping consecutive tool calls and the one-line summary (English and Portuguese).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const entry = path.join(__dirname, '.chat-ui-entry.tsx');
const out = path.join(os.tmpdir(), 'steerhouse-chat-ui', 'ui.cjs');
fs.writeFileSync(entry, `export { groupTools, summarizeTools, findPRs, changesByProject, projectOf, prettyModel } from ${JSON.stringify(path.join(root, 'webview/src/views/toolSummary.ts').replace(/\\/g, '/'))};`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --jsx=automatic --outfile="${out}" --alias:@=./webview/src --loader:.css=empty --log-level=error`, { cwd: root });

const load = (lang) => {
  globalThis.document = { documentElement: { lang } };
  for (const k of Object.keys(require.cache)) if (k.includes('steerhouse-chat-ui')) delete require.cache[k];
  return require(out);
};
const tool = (id, name, input, extra = {}) => ({ kind: 'tool', id, name, input, summary: '', status: 'done', file: input.file_path, ...extra });
const patch = [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 2, lines: ['+a', '+b', '-c', '-d', '-e', '-f'] }];

test('chat ui: consecutive tool calls become one group; sub-agents and text break it', () => {
  const { groupTools } = load('en');
  const g = groupTools([
    { kind: 'user', id: 'u', text: 'hi', images: [], ts: '' },
    tool('1', 'Read', { file_path: '/x/chat.ts' }),
    tool('2', 'Edit', { file_path: '/x/chat.ts' }),
    tool('3', 'TodoWrite', { todos: [] }),
    tool('4', 'Bash', { command: 'npm test' }),
    { kind: 'assistant', id: 'a', text: 'done' },
    tool('5', 'Agent', { description: 'tests' }),
    tool('6', 'Grep', { pattern: 'x' }),
  ]);
  const shape = g.map((x) => (Array.isArray(x) ? x.map((t) => t.id).join('+') : x.kind + (x.kind === 'tool' ? ':' + x.name : '')));
  assert.deepEqual(shape, ['user', '1+2+4', 'assistant', 'tool:Agent', '6'], 'TodoWrite is hidden (the plan card shows it)');
});

test('chat ui: summary sentence in English', () => {
  const { summarizeTools } = load('en');
  assert.equal(summarizeTools([tool('1', 'Read', { file_path: '/x/chat.ts' }), tool('2', 'Edit', { file_path: '/x/chat.ts' }, { patch }), tool('3', 'Bash', { command: 'x' })]), 'Read and edited chat.ts, ran 1 command');
  assert.equal(summarizeTools([tool('1', 'Read', { file_path: '/a' }), tool('2', 'Read', { file_path: '/b' }), tool('3', 'Grep', {}), tool('4', 'Grep', {})]), 'Read 2 files, searched 2 times');
});

test('chat ui: summary sentence in Portuguese', () => {
  const { summarizeTools } = load('pt-br');
  assert.equal(summarizeTools([tool('1', 'Read', { file_path: '/x/chat.ts' }), tool('2', 'Edit', { file_path: '/x/chat.ts' }), tool('3', 'Bash', { command: 'x' })]), 'Leu e editou chat.ts, executou 1 comando');
  assert.equal(summarizeTools([tool('1', 'Bash', {}), tool('2', 'Bash', {})]), 'Executou 2 comandos');
  delete globalThis.document;
});

test('rail: PR links from tool output and answers, no repeats', () => {
  const { findPRs } = load('en');
  const prs = findPRs([
    { kind: 'tool', result: 'https://github.com/acme/api/pull/214\n' },
    { kind: 'assistant', text: 'See [#214](https://github.com/acme/api/pull/214) and https://gitlab.com/g/web/-/merge_requests/9' },
  ]);
  assert.deepStrictEqual(prs.map((p) => p.label), ['acme/api#214', '!9']);
});

test('rail: changed files grouped per project, the chat folder first, Windows paths too', () => {
  const { changesByProject } = load('en');
  const e = (file, lines = ['+a', '-b']) => ({ kind: 'tool', name: 'Edit', file, patch: [{ lines }] });
  const g = changesByProject([e('/w/api/src/a.ts'), e('/w/web/app/p.tsx'), e('/w/web/app/p.tsx'), e('/w/ui/x.ts'), { kind: 'tool', name: 'Read', file: '/w/web/r.ts' }], '/w/web');
  assert.deepStrictEqual(g.map((p) => p.name), ['web', 'api', 'ui']);
  assert.deepStrictEqual(g[0].files[0], { path: '/w/web/app/p.tsx', rel: 'app/p.tsx', edits: 2, added: 2, removed: 2 });
  const w = changesByProject([e('C:\\w\\api\\a.ts'), e('c:\\w\\web\\b.ts')], 'C:\\w\\web');
  assert.deepStrictEqual(w.map((p) => p.name), ['web', 'api']);
});

test('model names: ids become friendly labels', () => {
  const { prettyModel } = load('en');
  assert.strictEqual(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.strictEqual(prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.strictEqual(prettyModel('claude-opus-4[1m]'), 'Opus 4 (1M)');
  assert.strictEqual(prettyModel('llama3.1:8b'), 'llama3.1:8b');
});

test('chat rows are not positioned with a transform (it pushes sticky titles over their own group)', () => {
  const src = fs.readFileSync(path.join(root, 'webview/src/views/Chat.tsx'), 'utf8');
  assert.match(src, /sticky top-0/, 'the titles are sticky');
  assert.ok(!/translateY\(/.test(src), 'no transform on the rows');
  assert.match(src, /style=\{\{ top: v\.start \}\}/);
});
