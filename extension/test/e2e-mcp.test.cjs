// Real Claude Code: an MCP server added while a chat runs is connected to it right away (no
// restart) and its tools are listed. Uses a tiny local server, no network. Sends no message, so it
// costs nothing. Run with AGENTLENS_E2E=1 (npm run test:e2e).
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const skip = !process.env.AGENTLENS_E2E && 'set AGENTLENS_E2E=1 to run against the real Claude Code';

test('e2e: Add MCP server connects it to the running chat', { skip, timeout: 90_000 }, async () => {
  const out = path.join(os.tmpdir(), 'agentlens-e2e-mcp');
  const stub = path.join(__dirname, 'vscode-stub.cjs');
  execSync(`npx esbuild src/chat.ts src/util.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
  const { ChatSession } = require(path.join(out, 'chat.js'));
  const { agentExecutable } = require(path.join(out, 'util.js'));
  const c = new ChatSession({ cwd: os.tmpdir(), executable: agentExecutable(), model: 'haiku' }, () => {});
  c.start();
  try {
    await c.addMcp('echo', { type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures', 'echo-mcp.cjs')] });
    let echo;
    for (let i = 0; i < 40; i++) {
      await c.refreshMcp();
      echo = c.state.mcp.find((m) => m.name === 'echo');
      if (echo?.status === 'connected') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.strictEqual(echo?.status, 'connected', JSON.stringify(c.state.mcp));
    assert.strictEqual(echo.tools, 1);
  } finally {
    c.close();
  }
});
