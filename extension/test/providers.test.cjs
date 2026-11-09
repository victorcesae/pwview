// Model providers (Ollama, LM Studio, LiteLLM, OpenRouter, custom) and vendor detection.
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-providers-build');
execSync(`npx esbuild src/providers.ts src/accounts.ts --bundle --platform=node --format=cjs --outdir="${out}" --log-level=error`, { cwd: root });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-prov-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.HOME = home;
process.env.USERPROFILE = home;
const P = require(path.join(out, 'providers.js'));
const A = require(path.join(out, 'accounts.js'));

test('providers: env points every model slot at the provider, never at an Anthropic key', () => {
  const env = P.providerEnv({ id: 'p', name: 'Ollama', preset: 'ollama', baseUrl: 'http://localhost:11434/', model: 'qwen3-coder', hasKey: false }, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama', 'local servers get their placeholder token');
  assert.equal(env.ANTHROPIC_API_KEY, '');
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'qwen3-coder', k);
  const or = P.providerEnv({ id: 'o', name: 'OpenRouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'openai/gpt-5', hasKey: true }, 'sk-or-x');
  assert.equal(or.ANTHROPIC_AUTH_TOKEN, 'sk-or-x');
});

test('providers: lists models from Ollama and OpenAI-style gateways', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.3:70b' }, { name: 'qwen3-coder:30b' }] }));
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'claude-sonnet-5-5' }], auth: req.headers.authorization }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ollama = P.PRESETS.find((p) => p.id === 'ollama');
    assert.deepEqual(await P.listModels(ollama, base), ['llama3.3:70b', 'qwen3-coder:30b']);
    const litellm = P.PRESETS.find((p) => p.id === 'litellm');
    assert.deepEqual(await P.listModels(litellm, base, 'key'), ['claude-sonnet-5-5', 'gpt-5']);
    const openrouter = P.PRESETS.find((p) => p.id === 'openrouter');
    assert.deepEqual(await P.listModels(openrouter, base), [], 'no listing: user types the model');
  } finally {
    srv.close();
  }
});

test('providers: vendor of a model id', () => {
  const cases = { 'claude-opus-5-5': 'anthropic', 'openai/gpt-5': 'openai', 'gemini-2.5-pro': 'google', 'llama3.3:70b': 'meta', 'qwen3-coder': 'qwen', 'deepseek-r1': 'deepseek', 'devstral': 'mistral', 'grok-4': 'xai', 'phi-4': 'other' };
  for (const [m, v] of Object.entries(cases)) assert.equal(P.vendorOf(m), v, m);
});

test('providers: added as accounts that share the default Claude folder', () => {
  const acc = A.addProvider({ name: 'Ollama · llama', preset: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3.3', hasKey: false });
  assert.match(acc.id, /^p-/);
  assert.equal(acc.configDir, A.defaultAccount().configDir);
  assert.ok(A.listAccounts().some((a) => a.id === acc.id && a.provider?.model === 'llama3.3'));
  assert.equal(A.accountEnv(acc).ANTHROPIC_MODEL, 'llama3.3');
  assert.equal(A.accountEnv(acc).CLAUDE_CONFIG_DIR, undefined, 'no separate folder');
});
