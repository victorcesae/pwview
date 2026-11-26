// Secret scan before commit / push / PR: real-looking keys are caught in added lines, examples,
// lockfile hashes and allow-marked lines are not; files named like secrets are flagged. Also the CI
// log helpers (run id from a check URL, trimming a long log, the fix prompt).
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const out = path.join(os.tmpdir(), 'steerhouse-secretscan-build');
const stub = path.join(__dirname, 'vscode-stub.cjs');
execSync(`npx esbuild src/secretScan.ts src/prs.ts --bundle --platform=node --format=cjs --outdir="${out}" --alias:vscode="${stub}" --log-level=error`, { cwd: root });
const S = require(path.join(out, 'secretScan.js'));
const P = require(path.join(out, 'prs.js'));

// built at run time so this file itself holds no scannable secrets
const rnd = (n, abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => {
  let s = '';
  let x = 7;
  for (let i = 0; i < n; i++) s += abc[((x = (x * 1103515245 + 12345) % 2147483648) >>> 16) % abc.length];
  return s;
};
const rules = (line) => S.scanLine(line).map((f) => f.rule);

test('secretScan: true positives', () => {
  assert.deepStrictEqual(rules(`const k = "${'AKIA' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}"`), ['AWS access key']);
  assert.ok(rules(`token: ${'ghp_' + rnd(36)}`).includes('GitHub token'));
  assert.ok(rules(`${'github_pat_' + rnd(70)}`).includes('GitHub token'));
  assert.ok(rules(`GITLAB=${'glpat-' + rnd(20)}`).includes('GitLab token'));
  assert.ok(rules(`slack ${'xoxb-' + rnd(12, '0123456789') + '-' + rnd(24)}`).includes('Slack token'));
  assert.ok(rules(`Stripe.key = '${'sk_live_' + rnd(24)}'`).includes('Stripe key'));
  assert.ok(rules(`maps(${'"AIza' + rnd(35)}")`).includes('Google API key'));
  assert.ok(rules(`ANTHROPIC_API_KEY=${'sk-ant-api03-' + rnd(90)}`).includes('Anthropic API key'));
  assert.ok(rules(`OPENAI=${'sk-proj-' + rnd(60)}`).includes('OpenAI API key'));
  assert.ok(rules('-----BEGIN RSA ' + 'PRIVATE KEY-----').includes('Private key'));
  assert.ok(rules('-----BEGIN OPENSSH ' + 'PRIVATE KEY-----').includes('Private key'));
  assert.ok(rules(`auth: ${'eyJ' + rnd(20)}.${'eyJ' + rnd(30)}.${rnd(30)}`).includes('JWT'));
  assert.ok(rules(`db_password = "${'Tr0ub4dor&' + rnd(6)}"`).includes('Hard-coded secret'));
  assert.ok(rules(`signingKey = "${rnd(40)}"`).length);
});

test('secretScan: false positives stay quiet', () => {
  assert.deepStrictEqual(rules('aws_key = "AKIAIOSFODNN7EXAMPLE"'), []);
  assert.deepStrictEqual(rules('password = "your-password-here"'), []);
  assert.deepStrictEqual(rules('token: "${GITHUB_TOKEN}"'), []);
  assert.deepStrictEqual(rules('const apiKey = process.env.OPENAI_API_KEY'), []);
  assert.deepStrictEqual(rules('password = "xxxxxxxxxxxxxxxx"'), []);
  assert.deepStrictEqual(rules('"integrity": "sha512-' + rnd(80) + '=="'), []);
  assert.deepStrictEqual(rules('commitHash = "' + rnd(40, '0123456789abcdef') + '"'), []);
  assert.deepStrictEqual(rules('const tokenKind = "access_token_refresh_kind"'), []);
  assert.deepStrictEqual(rules(`k = "${'ghp_' + rnd(36)}" // steerhouse-allow-secret`), []);
});

test('secretScan: diff lines, file names and redaction', () => {
  const key = 'ghp_' + rnd(36);
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,0 +11,2 @@',
    '+const ok = 1;',
    `+const t = "${key}";`,
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,0 +1,1 @@',
    `+      "resolved": "x", "token": "${key}"`,
    '--- a/old.ts',
    '+++ b/old.ts',
    '@@ -3 +3 @@',
    `-const t = "${key}";`,
    '+const t = process.env.T;',
  ].join('\n');
  const f = S.scanDiff(diff);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].file, 'src/a.ts');
  assert.strictEqual(f[0].line, 12);
  assert.ok(!f[0].redacted.includes(key) && f[0].redacted.startsWith('ghp_'));
  assert.deepStrictEqual(
    S.scanFileNames(['.env', 'config/.env.production', '.env.example', 'certs/server.pem', 'home/.ssh/id_rsa', 'id_rsa.pub', 'src/env.ts']).map((x) => x.file),
    ['.env', 'config/.env.production', 'certs/server.pem', 'home/.ssh/id_rsa'],
  );
  assert.match(S.describeFindings(f), /src\/a\.ts:12 {2}GitHub token: ghp_\*+/);
});

test('ci: run id from check URLs, log trimming, fix prompt, newly failed checks', () => {
  assert.deepStrictEqual(P.runIdFromUrl('https://github.com/o/r/actions/runs/123/job/456'), { run: '123', job: '456' });
  assert.deepStrictEqual(P.runIdFromUrl('https://github.com/o/r/actions/runs/123'), { run: '123', job: undefined });
  assert.strictEqual(P.runIdFromUrl('https://ci.example.com/build/1'), undefined);
  const noise = Array.from({ length: 3000 }, (_, i) => `build\tCompile\t2024-01-01T00:00:00.0000000Z compiling module ${i}`);
  noise[1500] = 'build\tCompile\t2024-01-01T00:00:00.0000000Z src/a.ts(3,1): error TS2304: Cannot find name x';
  const log = P.trimLog([...noise, 'build\tCompile\t2024-01-01T00:00:00Z Process completed with exit code 2.'].join('\n'));
  assert.ok(log.length <= 15_000);
  assert.match(log, /error TS2304/);
  assert.match(log, /exit code 2\.$/);
  assert.ok(!/2024-01-01T/.test(log) && !log.includes('\t'));
  assert.strictEqual(P.ciFixPrompt('test', { url: 'u', number: 7, branch: 'fix/x' }, 'boom'), 'CI check test failed on PR #7 (fix/x). Fix it. Log:\n```\nboom\n```');
  const prev = { state: 'open', checked: 1, checks: [{ name: 'a', state: 'pending' }, { name: 'b', state: 'fail' }] };
  const next = { state: 'open', checked: 2, checks: [{ name: 'a', state: 'fail' }, { name: 'b', state: 'fail' }] };
  assert.deepStrictEqual(P.newlyFailed(prev, next).map((c) => c.name), ['a']);
});

test('ci: tracker reports a check that turns red, not one red from the start', async () => {
  let checks = [{ name: 'a', state: 'pending' }];
  const failed = [];
  const t = new P.PrTracker(() => {}, async () => ({ state: 'open', checks, checked: Date.now() }), (url, c) => failed.push(c.name));
  await t.check('u');
  assert.deepStrictEqual(failed, []);
  checks = [{ name: 'a', state: 'fail' }];
  await t.check('u');
  await t.check('u');
  assert.deepStrictEqual(failed, ['a']);
  t.dispose();
});
