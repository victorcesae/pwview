// Unit tests for the chat engine, linking, graph, skills, prompts and setup checks.
// Run: npm test
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-unit-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(`npx esbuild src/chat.ts src/links.ts src/graph.ts src/engine.ts src/skills.ts src/library.ts src/doctor.ts src/accounts.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root, stdio: 'inherit' });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-unit-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.HOME = home;
process.env.USERPROFILE = home;
const load = (m) => require(path.join(out, m + '.js'));

// ------------------------------------------------------------------ chat engine

const { ChatSession, describe: describeTool } = load('chat');
const newChat = () => {
  const states = [];
  const c = new ChatSession({ cwd: '/repo' }, (s) => states.push(s));
  c.state.status = 'idle';
  return c;
};
const queued = (c) => c.input.q.map((m) => ({ priority: m.priority, content: m.message.content }));
const h = (c, m) => c.handle({ uuid: 'u', session_id: 'sid', parent_tool_use_id: null, ...m });

test('chat: streams text deltas into one assistant message', () => {
  const c = newChat();
  h(c, { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  h(c, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  h(c, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } });
  h(c, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } });
  const it = c.state.items.find((x) => x.kind === 'assistant');
  assert.equal(it.text, 'Hello');
  assert.equal(it.streaming, true);
  assert.equal(c.state.activity, 'Writing…');
  h(c, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello world' }] } });
  assert.equal(c.state.items.filter((x) => x.kind === 'assistant').length, 1, 'final message replaces the streamed one');
  assert.equal(it.text, 'Hello world');
  assert.equal(it.streaming, false);
});

test('chat: tool calls show live status, results and diffs; TodoWrite becomes the plan', () => {
  const c = newChat();
  c.state.status = 'working';
  h(c, { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'sendQuote' } }] } });
  assert.equal(c.state.activity, 'Searching for "sendQuote"…');
  assert.equal(c.state.items.at(-1).status, 'running');
  h(c, { type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/a.ts' } }] } });
  h(c, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
    tool_use_result: { filePath: '/repo/a.ts', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
  });
  const edit = c.state.items.find((x) => x.id === 't2');
  assert.equal(edit.status, 'done');
  assert.equal(edit.patch.length, 1);
  h(c, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } });
  assert.equal(c.state.items.find((x) => x.id === 't1').status, 'error');
  const todos = [{ content: 'Do A', status: 'in_progress', activeForm: 'Doing A' }, { content: 'Do B', status: 'pending', activeForm: 'Doing B' }];
  h(c, { type: 'assistant', message: { id: 'm4', content: [{ type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos } }] } });
  assert.deepEqual(c.state.todos, todos);
});

test('chat: sub-agent messages are nested under their Agent call', () => {
  const c = newChat();
  h(c, { type: 'assistant', message: { id: 'm5', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Write tests' } }] } });
  h(c, { type: 'assistant', parent_tool_use_id: 'ag', message: { id: 'm6', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] } });
  assert.equal(c.state.items.find((x) => x.id === 'b1').parent, 'ag');
  assert.equal(c.state.activity, 'Sub-agent: Write tests…', 'a sub-agent step does not overwrite the main status');
});

test('chat: Queue holds messages until the turn ends; Steer and Send now go straight in', () => {
  const c = newChat();
  c.send('first', [], 'later');
  assert.deepEqual(queued(c).map((m) => m.priority), ['later'], 'idle: sent right away');
  c.input.q.length = 0;
  assert.equal(c.state.status, 'working');

  c.send('queued one', [], 'later');
  c.send('queued two', [], 'later');
  assert.equal(c.state.queue.length, 2, 'working: kept in our queue (editable)');
  assert.equal(queued(c).length, 0);

  c.send('steer this', [], 'next');
  c.send('do it now', [], 'now');
  assert.deepEqual(queued(c).map((m) => m.priority), ['now'], 'send now goes in immediately; steer waits for the next step');
  assert.deepEqual(c.state.queue.map((q) => q.priority), ['later', 'later', 'next']);
  c.input.q.length = 0;

  c.promote(c.state.queue[1].id, 'now');
  assert.deepEqual(queued(c).map((m) => [m.priority, m.content.at(-1).text]), [['now', 'queued two']], 'a queued message can be sent now');
  c.input.q.length = 0;

  // the agent starts its next step: the steer is handed over, queue messages keep waiting
  h(c, { type: 'assistant', message: { id: 'mx', content: [{ type: 'tool_use', id: 'tx', name: 'Read', input: { file_path: '/a' } }] } });
  assert.deepEqual(queued(c).map((m) => [m.priority, m.content.at(-1).text]), [['next', 'steer this']]);
  assert.deepEqual(c.state.queue.map((q) => q.priority), ['later']);
  c.input.q.length = 0;

  h(c, { type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } });
  assert.deepEqual(queued(c).map((m) => m.content.at(-1).text), ['queued one'], 'turn end delivers the next queued message');
  assert.equal(c.state.queue.length, 0);
  assert.equal(c.state.costUsd, 0.01);
  assert.equal(c.state.tokens, 115);
});

test('chat: waiting messages can be edited and switched until they are handed over', () => {
  const c = newChat();
  c.state.status = 'working';
  c.send('use npm', [], 'next');
  const id = c.state.queue[0].id;
  c.editQueued(id, 'use pnpm');
  c.promote(id, 'later'); // switch Steer -> Queue
  assert.deepEqual(c.state.queue.map((q) => [q.priority, q.text]), [['later', 'use pnpm']]);
  h(c, { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
  assert.equal(c.input.q.length, 0, 'a queued (not steer) message is not handed over at a step');
  c.promote(id, 'next'); // back to Steer
  c.editQueued(id, 'use pnpm, not npm');
  h(c, { type: 'result', subtype: 'success', duration_ms: 1 });
  assert.deepEqual(queued(c).map((m) => m.content.at(-1).text), ['use pnpm, not npm'], 'a steer with no next step goes at turn end');
  c.editQueued(id, 'too late');
  assert.equal(c.input.q[0].message.content.at(-1).text, 'use pnpm, not npm', 'handed-over messages can no longer change');
});

test('chat: cancel removes a queued message; images become image blocks', () => {
  const c = newChat();
  c.state.status = 'working';
  c.send('later please', [], 'later');
  c.cancelQueued(c.state.queue[0].id);
  assert.equal(c.state.queue.length, 0);
  c.state.status = 'idle';
  c.send('look', [{ data: 'data:image/png;base64,AAAA', mime: 'image/png' }], 'later');
  const content = c.input.q[0].message.content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.data, 'AAAA');
  assert.equal(content[1].text, 'look');
});

test('chat: permissions: allow, always allow (with suggestions) and deny with a reason', async () => {
  const c = newChat();
  const sig = new AbortController().signal;
  const sugg = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }];
  let p = c.ask('Bash', { command: 'ls' }, sugg, sig);
  let card = c.state.items.at(-1);
  assert.equal(card.kind, 'permission');
  assert.equal(card.canAlways, true);
  assert.equal(c.state.status, 'waiting');
  c.respond(card.id, 'always');
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: sugg });

  p = c.ask('Bash', { command: 'rm -rf x' }, undefined, sig);
  card = c.state.items.at(-1);
  c.respond(card.id, 'deny', 'use git clean instead');
  assert.deepEqual(await p, { behavior: 'deny', message: 'use git clean instead' });
  assert.equal(card.status, 'denied');
});

test('chat: plans and questions get their own cards and answers', async () => {
  const c = newChat();
  const sig = new AbortController().signal;
  let p = c.ask('ExitPlanMode', { plan: '1. do x' }, undefined, sig);
  const plan = c.state.items.at(-1);
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.plan, '1. do x');
  c.respond(plan.id, 'allow');
  assert.equal((await p).behavior, 'allow');
  assert.equal(plan.status, 'approved');

  const questions = [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }];
  p = c.ask('AskUserQuestion', { questions }, undefined, sig);
  const q = c.state.items.at(-1);
  assert.equal(q.kind, 'question');
  c.respond(q.id, 'allow', undefined, { 'Which DB?': 'Postgres' });
  assert.deepEqual(await p, { behavior: 'allow', updatedInput: { questions, answers: { 'Which DB?': 'Postgres' } } });
});

test('chat: effort, fast mode and ultracode are applied to the running session', async () => {
  const c = newChat();
  const calls = [];
  c.q = { applyFlagSettings: async (s) => calls.push(s) };
  await c.setUltracode(true);
  await c.setEffort('xhigh');
  await c.setFastMode(true);
  assert.deepEqual(calls, [{ ultracode: true }, { effortLevel: 'xhigh', ultracode: true }, { fastMode: true }], 'changing effort keeps ultracode on');
  assert.equal(c.state.effort, 'xhigh');
  assert.equal(c.state.fastMode, true);
  assert.equal(c.state.ultracode, true);
});

test('chat: try again re-sends the last message with its images', () => {
  const c = newChat();
  c.send('fix it', [{ data: 'data:image/jpeg;base64,BBBB', mime: 'image/jpeg' }], 'later');
  c.input.q.length = 0;
  c.state.status = 'idle';
  c.retry();
  const m = c.input.q[0].message.content;
  assert.equal(m[0].source.media_type, 'image/jpeg');
  assert.equal(m[1].text, 'fix it');
});

test('chat: describes what the agent is doing in words', () => {
  assert.equal(describeTool('Read', { file_path: '/a/b/c.ts' }), 'Reading c.ts…');
  assert.equal(describeTool('Bash', { command: 'npm test', description: 'Run tests' }), 'Running Run tests…');
  assert.equal(describeTool('WebSearch', { query: 'xyflow' }), 'Searching the web for "xyflow"…');
});

test('chat: resumed chats show the earlier conversation', () => {
  const { historyFromTranscript } = load('chat');
  const f = path.join(home, 'hist.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [
    L({ type: 'custom-title', customTitle: 'Fix login' }),
    L({ type: 'user', uuid: 'u1', message: { content: 'Fix the login bug' } }),
    L({ type: 'user', message: { content: '<system-reminder>noise</system-reminder>' } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } }, { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'x', status: 'completed', activeForm: 'x' }] } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } }),
    L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub-agent text' }] } }),
  ].join('\n'));
  const h = historyFromTranscript(f);
  assert.equal(h.title, 'Fix login');
  assert.deepEqual(h.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(h.items[2].patch.length, 1);
  assert.equal(h.todos.length, 1);
  const c = new ChatSession({ cwd: '/r', resume: 'sid', history: h }, () => {});
  assert.equal(c.state.items.length, 5, 'history plus a "resumed" marker');
});

// ------------------------------------------------------------------ links + graph (with a real transcript)

const { Engine } = load('engine');
const { addLink, removeLink, loadLinks, briefing } = load('links');
const { buildGraph } = load('graph');

const writeSession = (dir, sid, title, prompts, edits) => {
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 60_000;
  const lines = [{ type: 'custom-title', customTitle: title, sessionId: sid, cwd: '/repo' }];
  prompts.forEach((p, i) => lines.push({ type: 'user', timestamp: new Date(t0 + i * 10_000).toISOString(), cwd: '/repo', message: { role: 'user', content: p } }));
  edits.forEach(([file, afterPrompt], i) => {
    const ts = new Date(t0 + afterPrompt * 10_000 + 1000 + i).toISOString();
    lines.push({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id: `${sid}-e${i}`, name: 'Edit', input: { file_path: file } }] } });
    lines.push({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: `${sid}-e${i}` }] }, toolUseResult: { filePath: file, oldString: 'a', newString: 'b', originalFile: 'a', structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] } });
  });
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
};
const proj = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'repo');
writeSession(proj, 'aaa', 'Sales flow', ['add approval', 'add badge'], [['/repo/schema.prisma', 0], ['/repo/page.tsx', 1]]);
writeSession(proj, 'bbb', 'DB columns', ['add columns'], [['/repo/schema.prisma', 0]]);

test('links: symmetric, removable, and the briefing points at the live transcript', () => {
  addLink('aaa', 'bbb');
  assert.deepEqual(loadLinks(), { aaa: ['bbb'], bbb: ['aaa'] });
  const s = new Engine().scan(1).find((x) => x.info.id === 'bbb');
  const text = briefing(s);
  assert.match(text, /Linked session: "DB columns"/);
  assert.match(text, /add columns/);
  assert.match(text, /schema\.prisma/);
  assert.ok(text.includes(s.path), 'agent can re-read the live transcript');
  removeLink('aaa', 'bbb');
  assert.deepEqual(loadLinks(), { aaa: [], bbb: [] });
});

test('graph: prompts in order, edits under the right prompt, shared files connect sessions', () => {
  const sessions = new Engine().scan(1);
  const g = buildGraph(sessions, { aaa: ['bbb'], bbb: ['aaa'] });
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes('s:aaa') && ids.includes('p:aaa:0') && ids.includes('p:aaa:1'));
  assert.ok(g.edges.some((e) => e.kind === 'next' && e.source === 'p:aaa:0' && e.target === 'p:aaa:1'));
  const file = g.nodes.find((n) => n.type === 'file');
  assert.match(file.data.path, /schema\.prisma$/, 'only the shared file gets a node');
  assert.equal(g.nodes.filter((n) => n.type === 'file').length, 1);
  assert.ok(g.edges.some((e) => e.kind === 'edited' && e.source === 'p:aaa:0' && e.target === file.id), 'edit attributed to the first prompt');
  assert.ok(g.edges.some((e) => e.kind === 'edited' && e.source === 'p:bbb:0' && e.target === file.id));
  assert.equal(g.nodes.find((n) => n.id === 'p:aaa:1').data.edits, 1, 'page.tsx edit belongs to prompt 2');
  assert.equal(g.edges.filter((e) => e.kind === 'linked').length, 1, 'one edge per linked pair');
});

// ------------------------------------------------------------------ skills, prompts, setup checks

test('skills: shows which agents load each skill', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ws-'));
  process.env.TEST_WS = ws;
  const skill = (dir, name) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test ${name}\n---\nbody`);
  };
  skill(path.join(ws, '.claude', 'skills'), 'api-style');
  skill(path.join(ws, '.agents', 'skills'), 'db-rules');
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const { scanSkills, installedAgents } = load('skills');
  const by = Object.fromEntries(scanSkills().map((s) => [s.name, s.agents.map((a) => a.id).sort()]));
  assert.deepEqual(by['api-style'], ['claude-code', 'cursor'], 'Cursor also reads .claude/skills');
  assert.ok(!by['db-rules'].includes('claude-code'), 'Claude Code does not read .agents/skills');
  assert.ok(by['db-rules'].includes('codex') && by['db-rules'].includes('cursor'));
  assert.ok(installedAgents().some((a) => a.id === 'cursor'));
});

test('prompts: name comes from the text itself', () => {
  const { titleFrom, savePromptText } = load('library');
  assert.equal(titleFrom('# Fix this error\n\n${input:Paste it}'), 'Fix this error');
  assert.equal(titleFrom('Write tests for ${file} using the project framework'), 'Write tests for … using the project framework');
  const f = savePromptText('Review my changes and point out bugs');
  assert.match(path.basename(f), /^review-my-changes/);
  assert.ok(fs.existsSync(savePromptText('Review my changes and point out bugs')), 'same name gets a numbered file');
});

test('setup: login detection', () => {
  const { loginState } = load('doctor');
  delete process.env.ANTHROPIC_API_KEY;
  if (process.platform !== 'darwin') assert.equal(loginState().ok, false);
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{}');
  assert.equal(loginState().ok, true);
  process.env.ANTHROPIC_API_KEY = 'x';
  assert.match(loginState().detail, /API/);
  delete process.env.ANTHROPIC_API_KEY;
});

// ------------------------------------------------------------------ the shipped bundle loads like VS Code loads it

test('bundle: dist/extension.js loads and exports activate', () => {
  execSync('npm run build:ext', { cwd: root, stdio: 'ignore' });
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? require(stub) : orig.call(this, req, ...rest);
  };
  try {
    const ext = require(path.join(root, 'dist', 'extension.js'));
    assert.equal(typeof ext.activate, 'function');
    assert.equal(typeof ext.deactivate, 'function');
  } finally {
    Module._load = orig;
  }
});
