#!/usr/bin/env node
// A scripted ACP agent (JSON-RPC 2.0 over stdio, one message per line). session/prompt streams:
// a thought, message chunks, a plan, a shell tool call that asks permission, a diff edit (written
// through fs/write_text_file after reading through fs/read_text_file), then end_turn.
// A prompt containing "wait" streams a chunk and waits for session/cancel.
// FAKE_ACP_LOG: file that gets every message received. FAKE_ACP_NOAUTH=1: session/new fails with
// auth_required (-32000). FAKE_ACP_NOLOAD=1: no loadSession capability.
const fs = require('fs');
const log = process.env.FAKE_ACP_LOG;
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
let nextSrv = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((res) => { const id = nextSrv++; waiting.set(id, res); send({ id, method, params }); });
const sid = 'sess_fake_1';
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let cancel;

async function prompt(id, p) {
  const s = p.sessionId;
  const text = p.prompt.find((b) => b.type === 'text')?.text ?? '';
  if (text.includes('wait')) {
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it' } });
    await new Promise((r) => (cancel = r));
    return send({ id, result: { stopReason: 'cancelled' } });
  }
  update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking at ' } });
  update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the repo' } });
  update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'I will run ' } });
  update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the tests.' } });
  update(s, { sessionUpdate: 'plan', entries: [{ content: 'Run tests', priority: 'high', status: 'completed' }, { content: 'Fix file', priority: 'high', status: 'in_progress' }] });
  update(s, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'npm test', kind: 'execute', status: 'pending', rawInput: { command: 'npm test' } });
  const options = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ];
  const r1 = await ask('session/request_permission', { sessionId: s, toolCall: { toolCallId: 'tc1', title: 'npm test', kind: 'execute' }, options });
  const ok1 = r1.result?.outcome?.optionId !== 'no';
  update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: ok1 ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: ok1 ? 'ok 1 tests' : 'rejected' } }] });
  const file = p.__file;
  update(s, { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'Edit a.txt', kind: 'edit', status: 'pending', locations: [{ path: file }] });
  const r2 = await ask('session/request_permission', { sessionId: s, toolCall: { toolCallId: 'tc2' }, options });
  if (r2.result?.outcome?.optionId === 'no') {
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'failed' });
  } else {
    const old = (await ask('fs/read_text_file', { sessionId: s, path: file })).result.content;
    const neu = old.replace('two', 'TWO');
    await ask('fs/write_text_file', { sessionId: s, path: file, content: neu });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: 'completed', content: [{ type: 'diff', path: file, oldText: old, newText: neu }] });
  }
  update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done: ' + text } });
  send({ id, result: { stopReason: 'end_turn' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (log) fs.appendFileSync(log, line + '\n');
    if (!m.method) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      w?.(m);
      continue;
    }
    const p = m.params ?? {};
    switch (m.method) {
      case 'initialize':
        send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: process.env.FAKE_ACP_NOLOAD !== '1', promptCapabilities: { image: true } }, authMethods: [{ id: 'oauth', name: 'Log in with Google' }] } });
        break;
      case 'session/new':
        if (process.env.FAKE_ACP_NOAUTH === '1') send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
        else {
          update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'memory', description: 'Memory' }, { name: 'tools', description: 'Tools' }] });
          send({ id: m.id, result: { sessionId: sid, models: { availableModels: [{ modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, { modelId: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }], currentModelId: 'gemini-2.5-pro' } } });
        }
        break;
      case 'session/load':
        // replays history; the client must not show it again
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } });
        send({ id: m.id, result: {} });
        break;
      case 'session/set_model':
        send({ id: m.id, result: {} });
        break;
      case 'session/prompt':
        prompt(m.id, { ...p, __file: process.env.FAKE_ACP_FILE });
        break;
      case 'session/cancel':
        cancel?.();
        break;
      default:
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no ' + m.method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
