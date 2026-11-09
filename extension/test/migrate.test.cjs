// Steerhouse used to be AgentLens: the old data folder and the Claude Code hook entries that point at
// the old hook script carry over once, without touching anything else.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-migrate-build');
execSync(`npx esbuild src/migrate.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${path.join(__dirname, 'vscode-stub.cjs')}" --log-level=error`, { cwd: root });
const M = require(path.join(out, 'migrate.js'));

test('migrate: the old data folder is copied once, never over a new one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-mig-'));
  fs.mkdirSync(path.join(dir, 'agentlens', 'terminals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agentlens', 'terminals', 't.json'), '{}');
  assert.strictEqual(M.migrateDataDir(dir), true);
  assert.ok(fs.existsSync(path.join(dir, 'steerhouse', 'terminals', 't.json')));
  assert.ok(fs.existsSync(path.join(dir, 'agentlens')), 'the old folder is left in place');
  fs.writeFileSync(path.join(dir, 'steerhouse', 'terminals', 't.json'), '{"new":1}');
  assert.strictEqual(M.migrateDataDir(dir), false, 'second run does nothing');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'steerhouse', 'terminals', 't.json'), 'utf8'), '{"new":1}');
});

test('migrate: our hook entries move to the new script, other hooks untouched, backup kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steerhouse-mig-hooks-'));
  const f = path.join(dir, 'settings.json');
  const doc = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "C:/Users/me/.claude/agentlens/hook.js" stop' }] }, { hooks: [{ type: 'command', command: 'echo mine' }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/home/me/.claude/agentlens/hook.js" posttool' }] }],
    },
  };
  fs.writeFileSync(f, JSON.stringify(doc));
  assert.strictEqual(M.migrateHooks(f), 2);
  const now = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(now.hooks.Stop[0].hooks[0].command, 'node "C:/Users/me/.claude/steerhouse/hook.js" stop');
  assert.strictEqual(now.hooks.PostToolUse[0].hooks[0].command, 'node "/home/me/.claude/steerhouse/hook.js" posttool');
  assert.strictEqual(now.hooks.Stop[1].hooks[0].command, 'echo mine');
  assert.strictEqual(now.model, 'opus');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f + '.agentlens-rename-bak', 'utf8')), doc, 'backup of the original');
  assert.strictEqual(M.migrateHooks(f), 0, 'second run does nothing');
  assert.strictEqual(M.migrateHooks(path.join(dir, 'missing.json')), 0);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  assert.strictEqual(M.migrateHooks(path.join(dir, 'broken.json')), 0, 'a broken file is left alone');
});

test('migrate: old project prompts folder is still read', () => {
  assert.strictEqual(M.legacyPromptsDir(path.join('/w', 'app')), path.join('/w', 'app', '.agentlens', 'prompts'));
});
