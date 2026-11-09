// Adding MCP servers: command parsing, `claude mcp add` arguments, the config a running chat gets,
// and (with the real Claude Code) a server saved in a project's .mcp.json.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-mcp-build');
execSync(`npx esbuild src/mcp.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const M = require(path.join(out, 'mcp.js'));

test('mcp: a typed command line becomes command + args (quotes keep spaces)', () => {
  assert.deepStrictEqual(M.splitCommand('npx -y @upstash/context7-mcp'), { command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
  assert.deepStrictEqual(M.splitCommand('node "C:/My Tools/server.js" --port 3'), { command: 'node', args: ['C:/My Tools/server.js', '--port', '3'] });
});

test('mcp: claude mcp add arguments per transport and scope', () => {
  assert.deepStrictEqual(M.mcpAddArgs({ name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' }, 'user'), ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'sentry', 'https://mcp.sentry.dev/mcp']);
  assert.deepStrictEqual(M.mcpAddArgs({ name: 'pw', transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] }, 'project'), ['mcp', 'add', '--scope', 'project', 'pw', '--', 'npx', '@playwright/mcp@latest']);
});

test('mcp: the same server for a running chat; names; presets are complete', () => {
  assert.deepStrictEqual(M.sdkConfig({ name: 'x', transport: 'http', url: 'https://a/mcp' }), { type: 'http', url: 'https://a/mcp' });
  assert.deepStrictEqual(M.sdkConfig({ name: 'x', transport: 'stdio', command: 'npx', args: ['a'] }), { type: 'stdio', command: 'npx', args: ['a'] });
  assert.ok(M.validName('context7') && M.validName('my_server-2') && !M.validName('has space') && !M.validName(''));
  for (const p of M.MCP_PRESETS) assert.ok(M.validName(p.name) && (p.transport === 'http' ? /^https:\/\//.test(p.url) : p.command), p.label);
});

const claude = [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')].find((p) => fs.existsSync(p));
test('mcp (real Claude Code): a server added for the team lands in the project .mcp.json', { skip: !claude && 'Claude Code not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-mcp-proj-'));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-mcp-cfg-'));
  const server = { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
  const r = await M.runClaude(claude, M.mcpAddArgs(server, 'project'), dir, { CLAUDE_CONFIG_DIR: config });
  assert.ok(r.ok, r.out);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.context7;
  assert.strictEqual(saved.command, 'npx');
  assert.deepStrictEqual(saved.args, ['-y', '@upstash/context7-mcp']);
  const web = await M.runClaude(claude, M.mcpAddArgs({ name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' }, 'project'), dir, { CLAUDE_CONFIG_DIR: config });
  assert.ok(web.ok, web.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.sentry.url, 'https://mcp.sentry.dev/mcp');
});
