#!/usr/bin/env node
// A scripted stand-in for `codex app-server` (v2 protocol, newline-delimited JSON-RPC without the
// "jsonrpc" field). Each turn/start streams: reasoning, an agent message, a command that needs
// approval, a file change that needs approval (with a diff), a plan, token usage, turn/completed.
// FAKE_CODEX_LOG: file that gets every message received (one JSON per line).
// FAKE_CODEX_NOAUTH=1: account/read says nobody is logged in and turn/start fails with 401.
const fs = require('fs');
const log = process.env.FAKE_CODEX_LOG;
const noAuth = process.env.FAKE_CODEX_NOAUTH === '1';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const note = (method, params) => send({ method, params });
let nextSrv = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((res) => { const id = nextSrv++; waiting.set(id, res); send({ id, method, params }); });
const threadId = 'thr_fake_1';
let turn = 0;
let interrupted = false;

async function runTurn(turnId, text) {
  const base = { threadId, turnId };
  note('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
  note('item/started', { ...base, item: { type: 'reasoning', id: 'rs1', summary: [], content: [] } });
  note('item/reasoning/summaryTextDelta', { ...base, itemId: 'rs1', delta: 'Looking at the repo', summaryIndex: 0 });
  note('item/completed', { ...base, item: { type: 'reasoning', id: 'rs1', summary: ['Looking at the repo'], content: [] } });
  note('item/started', { ...base, item: { type: 'agentMessage', id: 'msg1', text: '' } });
  note('item/agentMessage/delta', { ...base, itemId: 'msg1', delta: 'I will run ' });
  note('item/agentMessage/delta', { ...base, itemId: 'msg1', delta: 'the tests.' });
  note('item/completed', { ...base, item: { type: 'agentMessage', id: 'msg1', text: 'I will run the tests.' } });
  const cmd = { type: 'commandExecution', id: 'cmd1', command: 'npm test', cwd: '/w', processId: null, status: 'inProgress', commandActions: [{ type: 'unknown', command: 'npm test' }], aggregatedOutput: null, exitCode: null, durationMs: null };
  note('item/started', { ...base, item: cmd });
  const r1 = await ask('item/commandExecution/requestApproval', { ...base, itemId: 'cmd1', command: 'npm test', cwd: '/w', reason: 'run tests', startedAtMs: Date.now() });
  if (interrupted) return;
  const ran = r1.decision === 'accept' || r1.decision === 'acceptForSession';
  if (ran) note('item/commandExecution/outputDelta', { ...base, itemId: 'cmd1', delta: 'ok 1 tests\n' });
  note('item/completed', { ...base, item: { ...cmd, status: ran ? 'completed' : 'declined', aggregatedOutput: ran ? 'ok 1 tests\n' : null, exitCode: ran ? 0 : null } });
  const diff = '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n';
  const fc = { type: 'fileChange', id: 'fc1', changes: [{ path: '/w/a.txt', kind: { type: 'update', move_path: null }, diff }], status: 'inProgress' };
  note('item/started', { ...base, item: fc });
  const r2 = await ask('item/fileChange/requestApproval', { ...base, itemId: 'fc1', reason: null, startedAtMs: Date.now() });
  if (interrupted) return;
  note('item/completed', { ...base, item: { ...fc, status: r2.decision === 'decline' ? 'declined' : 'completed' } });
  note('turn/diff/updated', { ...base, diff });
  note('turn/plan/updated', { ...base, explanation: null, plan: [{ step: 'Run tests', status: 'completed' }, { step: 'Fix a.txt', status: 'inProgress' }] });
  note('thread/tokenUsage/updated', { ...base, tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 10 }, last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 10 }, modelContextWindow: 200000 } });
  note('item/completed', { ...base, item: { type: 'agentMessage', id: 'msg2', text: `Done: ${text}` } });
  note('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } });
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
      w?.(m.result ?? {});
      continue;
    }
    const reply = (result) => send({ id: m.id, result });
    switch (m.method) {
      case 'initialize':
        reply({ userAgent: 'codex_cli_rs/0.172.0 (fake)', codexHome: '/tmp/fake-codex', platformFamily: 'unix', platformOs: 'linux' });
        break;
      case 'initialized':
        break;
      case 'account/read':
        reply(noAuth ? { account: null, userId: null, requiresOpenaiAuth: true } : { account: { type: 'apiKey' }, userId: null, requiresOpenaiAuth: true });
        break;
      case 'model/list':
        reply({ data: [{ id: 'gpt-5.5-codex', model: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex', hidden: false }, { id: 'h', model: 'hidden', displayName: 'Hidden', hidden: true }], nextCursor: null });
        break;
      case 'thread/start':
      case 'thread/resume':
        reply({ thread: { id: m.params.threadId ?? threadId }, model: 'gpt-5.5-codex', cwd: m.params.cwd });
        break;
      case 'turn/start': {
        if (noAuth) {
          send({ id: m.id, error: { code: -32000, message: 'unexpected status 401 Unauthorized' } });
          break;
        }
        const turnId = `turn_${++turn}`;
        interrupted = false;
        reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
        const text = (m.params.input.find((x) => x.type === 'text') || {}).text || '';
        setTimeout(() => runTurn(turnId, text), 5);
        break;
      }
      case 'turn/steer':
        reply({ turnId: m.params.expectedTurnId });
        break;
      case 'turn/interrupt':
        interrupted = true;
        reply({});
        for (const [id, w] of waiting) (waiting.delete(id), w({ decision: 'cancel' }));
        note('turn/completed', { threadId, turn: { id: m.params.turnId, items: [], status: 'interrupted', error: null } });
        break;
      default:
        send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
