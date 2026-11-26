#!/usr/bin/env node
// A scripted cursor-agent: prints the stream-json of one turn (text, a shell call, an edit, result).
// FAKE_CURSOR_LOG: each run's argv appended as a JSON line. FAKE_CURSOR_MODE: ok | noauth | hang.
const fs = require('fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CURSOR_LOG) fs.appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify({ args, xdg: process.env.XDG_CONFIG_HOME }) + '\n');
if (args.includes('--list-models')) {
  process.stdout.write('Available models\n\nauto - Auto (default)\ncomposer-2.5 - Composer 2.5 (current)\n');
  process.exit(0);
}
const mode = process.env.FAKE_CURSOR_MODE || 'ok';
const r = args.indexOf('--resume');
const sid = r >= 0 ? args[r + 1] : 'chat_fake_1';
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), model: 'Composer 2.5', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: args[args.length - 1] }] } });
if (mode === 'noauth') {
  process.stderr.write('Error: Not logged in. Run cursor-agent login\n');
  process.exit(1);
}
if (mode === 'hang') {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working' }] }, timestamp_ms: 1 });
  setInterval(() => {}, 1000);
} else {
  out({ type: 'thinking', subtype: 'delta', text: 'Let me look.' });
  out({ type: 'thinking', subtype: 'completed' });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] }, timestamp_ms: 1 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'lo' }] }, timestamp_ms: 2 });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' } } } });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'a.txt\n', exitCode: 0 } } } } });
  out({ type: 'tool_call', subtype: 'started', call_id: 'c2', tool_call: { editToolCall: { args: { path: '/tmp/a.txt' } } } });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'c2', tool_call: { editToolCall: { args: { path: '/tmp/a.txt' }, result: { success: { path: '/tmp/a.txt', diffString: '@@ -1 +1 @@\n-hi\n+bye\n' } } } } });
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, timestamp_ms: 3 });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, result: 'HelloDone.', usage: { inputTokens: 100, outputTokens: 5 } });
}
