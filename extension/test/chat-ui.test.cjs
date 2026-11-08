// Chat UI logic: grouping consecutive tool calls and the one-line summary (English and Portuguese).
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const entry = path.join(__dirname, '.chat-ui-entry.tsx');
const out = path.join(os.tmpdir(), 'agentlens-chat-ui', 'ui.cjs');
fs.writeFileSync(entry, `export { groupTools, summarizeTools } from ${JSON.stringify(path.join(root, 'webview/src/views/Chat.tsx').replace(/\\/g, '/'))};`);
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=cjs --jsx=automatic --outfile="${out}" --alias:@=./webview/src --loader:.css=empty --log-level=error`, { cwd: root });

const load = (lang) => {
  globalThis.document = { documentElement: { lang } };
  for (const k of Object.keys(require.cache)) if (k.includes('agentlens-chat-ui')) delete require.cache[k];
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
