// Usage: counting each reply once, API-equivalent prices, the report, and mid-turn messages.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'agentlens-usage-build');
execSync(`npx esbuild src/usage.ts src/pricing.ts src/engine.ts src/chat.ts --bundle --platform=node --format=cjs --outdir="${out}" --define:import.meta.url=importMetaUrl --inject:build/import-meta-url.js --log-level=error`, { cwd: root });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-usage-'));
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
const { costOf, modelLabel } = require(path.join(out, 'pricing.js'));
const { parse, Engine } = require(path.join(out, 'engine.js'));
const { usageReport } = require(path.join(out, 'usage.js'));
const { historyFromTranscript } = require(path.join(out, 'chat.js'));

const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
const L = (o) => JSON.stringify(o);
const usage = (input, output, cw = 0, cr = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

function writeSession(sid, lines) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'repo');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, sid + '.jsonl');
  fs.writeFileSync(f, lines.map(L).join('\n'));
  return f;
}

test('pricing: list prices and labels', () => {
  assert.equal(costOf('claude-opus-5-5', { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 }), 24);
  assert.equal(costOf('claude-sonnet-5-5', { input: 0, output: 0, cacheWrite: 1e6, cacheRead: 1e6 }), 2 * 1.25 + 0.2);
  assert.equal(costOf('claude-haiku-5-5', { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 1e6 }), 0.1 + 0.01);
  assert.equal(costOf('some-other-model', { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }), undefined);
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
});

test('usage: a reply split over several records is counted once', () => {
  const f = writeSession('s1', [
    { type: 'custom-title', customTitle: 'Usage test' },
    { type: 'user', cwd: '/repo', timestamp: iso(30), message: { content: 'go' } },
    { type: 'assistant', timestamp: iso(29), message: { id: 'msg1', model: 'claude-opus-5-5', usage: usage(1000, 200, 5000, 100000), content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', timestamp: iso(29), message: { id: 'msg1', model: 'claude-opus-5-5', usage: usage(1000, 250, 5000, 100000), content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'assistant', timestamp: iso(28), message: { id: 'msg2', model: 'claude-haiku-5-5', usage: usage(500, 50), content: [{ type: 'text', text: 'b' }] } },
  ]);
  const t = parse(f, 's1');
  assert.equal(t.usage.length, 2, 'two replies, not three records');
  assert.equal(t.usage[0].output, 250, 'the final output count is kept');
  const r = usageReport(new Engine().scan(1), 7, now);
  assert.equal(r.totals.input, 1500);
  assert.equal(r.totals.output, 300);
  assert.equal(r.totals.cacheRead, 100000);
  const expected = costOf('claude-opus-5-5', { input: 1000, output: 250, cacheWrite: 5000, cacheRead: 100000 }) + costOf('claude-haiku-5-5', { input: 500, output: 50, cacheWrite: 0, cacheRead: 0 });
  assert.ok(Math.abs(r.totals.cost - expected) < 1e-9);
  assert.deepEqual(r.byModel.map((m) => m.label), ['Opus 5.5', 'Haiku 5.5']);
  assert.equal(r.byDay.length, 7);
  assert.ok(r.byDay.at(-1).cost > 0, 'today has the usage');
  assert.equal(r.topSessions[0].title, 'Usage test');
});

test('mid-turn messages (steer / queue) appear in the timeline and in resumed history', () => {
  const f = writeSession('s2', [
    { type: 'user', cwd: '/repo', timestamp: iso(10), message: { content: 'Fix the bug' } },
    { type: 'assistant', timestamp: iso(9), message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Looking.' }] } },
    { type: 'queue-operation', operation: 'enqueue', content: 'use pnpm' },
    { type: 'attachment', timestamp: iso(8), attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'use pnpm' }], timestamp: iso(8) } },
  ]);
  const t = parse(f, 's2');
  const prompts = t.events.filter((e) => e.kind === 'prompt');
  assert.deepEqual(prompts.map((p) => [p.text, !!p.midTurn]), [['Fix the bug', false], ['use pnpm', true]]);
  const h = historyFromTranscript(f);
  const users = h.items.filter((i) => i.kind === 'user');
  assert.deepEqual(users.map((u) => [u.text, u.priority ?? null]), [['Fix the bug', null], ['use pnpm', 'next']]);
});
