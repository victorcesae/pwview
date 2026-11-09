// Minimal stdio MCP server for tests: one tool, "echo". Newline-delimited JSON-RPC.
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications
  if (m.method === 'initialize')
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  if (m.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params?.arguments?.text ?? '') }] } });
  send({ jsonrpc: '2.0', id: m.id, result: {} });
});
