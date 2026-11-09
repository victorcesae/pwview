// Run: npm test  (builds src/engine.ts + hooks.ts for node, then checks them on a synthetic transcript)
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-test-build');
execSync(`npx esbuild src/engine.ts src/hooks.ts src/hook.ts --bundle --platform=node --format=cjs --outdir="${out}"`, { cwd: root, stdio: 'ignore' });

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-home-'));
process.env.CLAUDE_CONFIG_DIR = home;
const { Engine, changeDetail } = require(path.join(out, 'engine.js'));
const { installHooks } = require(path.join(out, 'hooks.js'));

const proj = path.join(home, 'projects', 'c--repo');
const sid = '11111111-2222-3333-4444-555555555555';
fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
const ts = (s) => new Date(Date.now() - s * 1000).toISOString();
const line = (o) => JSON.stringify({ cwd: '/repo', gitBranch: 'main', sessionId: sid, ...o });
fs.writeFileSync(
  path.join(proj, sid + '.jsonl'),
  [
    line({ type: 'custom-title', customTitle: 'Fix login' }),
    line({ type: 'user', timestamp: ts(60), message: { role: 'user', content: 'Fix the login bug' } }),
    line({ type: 'assistant', timestamp: ts(50), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The check is inverted.' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/repo/a.ts' } }] } }),
    line({
      type: 'user', timestamp: ts(40),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
      toolUseResult: { filePath: '/repo/a.ts', oldString: 'if (!ok)', newString: 'if (ok)', originalFile: 'x\nif (!ok) go()\n', replaceAll: false, structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-if (!ok) go()', '+if (ok) go()'] }] },
    }),
    // the same tool result replayed (happens after resume/compaction) must not count twice
    line({
      type: 'user', timestamp: ts(35),
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
      toolUseResult: { filePath: '/repo/a.ts', oldString: 'if (!ok)', newString: 'if (ok)', originalFile: 'x\nif (!ok) go()\n', structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-if (!ok) go()', '+if (ok) go()'] }] },
    }),
    line({ type: 'assistant', timestamp: ts(30), message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Write tests' } }] } }),
    '{"partial line',
  ].join('\n'),
);
const aid = 'abc123';
fs.writeFileSync(path.join(proj, sid, 'subagents', `agent-${aid}.meta.json`), JSON.stringify({ description: 'Write tests', agentType: 'general-purpose', toolUseId: 'tu2' }));
fs.writeFileSync(
  path.join(proj, sid, 'subagents', `agent-${aid}.jsonl`),
  [
    line({ type: 'user', isSidechain: true, timestamp: ts(20), message: { content: 'Write tests for a.ts' } }),
    line({ type: 'assistant', timestamp: ts(15), message: { content: [{ type: 'tool_use', id: 'tu3', name: 'Write', input: { file_path: '/repo/a.test.ts' } }] } }),
    line({ type: 'user', timestamp: ts(10), message: { content: [{ type: 'tool_result', tool_use_id: 'tu3' }] }, toolUseResult: { type: 'create', filePath: '/repo/a.test.ts', content: 'test()\nexpect()\n', structuredPatch: [], originalFile: null } }),
  ].join('\n'),
);

test('scans sessions, sub-agents and changes', () => {
  const [s] = new Engine().scan(1);
  assert.equal(s.info.title, 'Fix login');
  assert.equal(s.info.branch, 'main');
  assert.equal(s.info.model, 'claude-opus-5-5');
  assert.equal(s.info.state, 'working');
  assert.equal(s.info.edits, 2);
  assert.deepEqual(s.info.files, ['/repo/a.test.ts', '/repo/a.ts']);
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].info.description, 'Write tests');
  const c = s.t.changes[0];
  assert.equal(c.why, 'The check is inverted.');
  assert.equal([c.added, c.removed].join(), '1,1');
  assert.equal(s.agents[0].t.changes[0].kind, 'create');
  assert.equal(s.agents[0].t.changes[0].added, 3);
});

test('reconstructs before/after for edits and creates', () => {
  const [s] = new Engine().scan(1);
  assert.deepEqual(changeDetail(s.path, 'tu1'), { original: 'x\nif (!ok) go()\n', after: 'x\nif (ok) go()\n' });
  assert.deepEqual(changeDetail(s.agents[0].path, 'tu3'), { original: null, after: 'test()\nexpect()\n' });
});

test('hook delivers queued comments once, as a Stop block', () => {
  fs.mkdirSync(path.join(home, 'steerhouse'), { recursive: true });
  fs.writeFileSync(path.join(home, 'steerhouse', 'comments.json'), JSON.stringify([{ id: 'c1', sessionId: sid, file: '/repo/a.ts', line: 1, text: 'Use === here', created: ts(1), status: 'pending' }]));
  const run = () => spawnSync(process.execPath, [path.join(out, 'hook.js'), 'stop'], { input: JSON.stringify({ session_id: sid }), env: { ...process.env, CLAUDE_CONFIG_DIR: home }, encoding: 'utf8' });
  const first = JSON.parse(run().stdout);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /\/repo\/a\.ts:2\] Use === here/);
  assert.equal(run().stdout, '', 'second run must not re-deliver (no infinite Stop loop)');
});

test('installs hooks idempotently and keeps other settings', () => {
  const p = path.join(home, 'settings.json');
  fs.writeFileSync(p, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  assert.equal(installHooks(p), 4);
  assert.equal(installHooks(p), 0);
  const v = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(v.model, 'opus');
  assert.equal(v.hooks.Stop.length, 2);
  assert.equal(v.hooks.UserPromptSubmit.length, 1);
  assert.equal(v.hooks.PostToolUse.length, 1);
  assert.equal(v.hooks.SessionStart.length, 1);
  assert.ok(fs.existsSync(p + '.steerhouse-bak'));
});

const runHook = (event, payload, env = {}) =>
  spawnSync(process.execPath, [path.join(out, "hook.js"), event], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_CONFIG_DIR: home, ...env }, encoding: "utf8" });
const setComments = (cs) => {
  fs.mkdirSync(path.join(home, "steerhouse"), { recursive: true });
  fs.writeFileSync(path.join(home, "steerhouse", "comments.json"), JSON.stringify(cs.map((c, i) => ({ id: "m" + i, sessionId: sid, created: ts(1), status: "pending", ...c }))));
};
const status = () => Object.fromEntries(JSON.parse(fs.readFileSync(path.join(home, "steerhouse", "comments.json"), "utf8")).map((c) => [c.id, c.status + ":" + (c.deliveredVia ?? "")]));

test("steer is injected between steps; queue waits for the turn end", () => {
  setComments([{ text: "use pnpm", mode: "steer" }, { text: "then update docs", mode: "queue" }]);
  const r = JSON.parse(runHook("posttool", { session_id: sid }).stdout);
  assert.equal(r.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(r.hookSpecificOutput.additionalContext, /steering you mid-task[^]*use pnpm/);
  assert.doesNotMatch(r.hookSpecificOutput.additionalContext, /update docs/);
  assert.deepEqual(status(), { m0: "delivered:step", m1: "pending:" });
  const stop = JSON.parse(runHook("stop", { session_id: sid }).stdout);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /update docs/);
  assert.deepEqual(status(), { m0: "delivered:step", m1: "delivered:turn-end" });
});

test("steering a sub-agent reaches only that sub-agent", () => {
  setComments([{ text: "fix the selector", mode: "steer", agentId: "abc123" }]);
  assert.equal(runHook("posttool", { session_id: sid }).stdout, "", "main agent must not get it");
  assert.equal(runHook("posttool", { session_id: sid, agent_id: "other" }).stdout, "", "other sub-agent must not get it");
  const r = JSON.parse(runHook("posttool", { session_id: sid, agent_id: "abc123" }).stdout);
  assert.match(r.hookSpecificOutput.additionalContext, /fix the selector/);
});

test("turn-level hooks of a sub-agent do not swallow the main agent messages", () => {
  setComments([{ text: "for main", mode: "queue" }]);
  assert.equal(runHook("stop", { session_id: sid, agent_id: "abc123" }).stdout, "");
  assert.match(JSON.parse(runHook("prompt", { session_id: sid }).stdout).hookSpecificOutput.additionalContext, /for main/);
});

test("records which terminal runs the session", () => {
  runHook("sessionstart", { session_id: sid, cwd: "/repo" }, { STEERHOUSE_TERMINAL: "tok42" });
  const rec = JSON.parse(fs.readFileSync(path.join(home, "steerhouse", "terminals", sid + ".json"), "utf8"));
  assert.equal(rec.token, "tok42");
  assert.equal(rec.cwd, "/repo");
  assert.ok(Array.isArray(rec.pids) && rec.pids.length > 0, "parent pids recorded");
});
