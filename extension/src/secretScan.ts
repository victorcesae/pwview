// Looks for secrets in what is about to be committed or pushed: gitleaks-style patterns (cloud and
// API keys, tokens, private keys, JWTs, hard-coded passwords, high-entropy assignments) over the
// added lines of a diff, plus files that should never be committed (.env, keys). Pure: no vscode.

export interface SecretFinding {
  file: string;
  /** line in the new version of the file (0 for a whole-file finding) */
  line: number;
  rule: string;
  /** the match with its middle hidden */
  redacted: string;
}

/** Lines containing this are never reported. */
export const ALLOW_MARK = 'steerhouse-allow-secret';

interface Rule {
  name: string;
  re: RegExp;
  /** which capture group holds the secret (default: the whole match) */
  group?: number;
}

const RULES: Rule[] = [
  { name: 'AWS access key', re: /\b((?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16})\b/, group: 1 },
  { name: 'AWS secret key', re: /aws.{0,20}?(?:secret|key).{0,20}?['"]?\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})\b/i, group: 1 },
  { name: 'GitHub token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/, group: 1 },
  { name: 'GitLab token', re: /\b(gl(?:pat|dt|rt|ptt|soat|cbt)-[A-Za-z0-9_-]{20,})\b/, group: 1 },
  { name: 'Slack token', re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})\b/, group: 1 },
  { name: 'Slack webhook', re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/, group: 1 },
  { name: 'Stripe key', re: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/, group: 1 },
  { name: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/, group: 1 },
  { name: 'Anthropic API key', re: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,})/, group: 1 },
  { name: 'OpenAI API key', re: /\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,})/, group: 1 },
  { name: 'Private key', re: /(-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----)/, group: 1 },
  { name: 'JWT', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/, group: 1 },
  { name: 'Hard-coded secret', re: /(?:password|passwd|pwd|secret|token|api[_-]?key|auth)\w*['"]?\s*[:=]\s*['"]([^'"\s]{12,})['"]/i, group: 1 },
];

/** Placeholder-looking values: docs examples, templates, env references. */
const PLACEHOLDER = /example|sample|dummy|placeholder|changeme|change_me|your[_-]|<[^>]*>|\$\{|\{\{|xxxx|\*\*\*\*|redacted|fake|test[_-]?key|0{8,}|(.)\1{9,}|process\.env|os\.environ|getenv/i;

/** Lockfiles and the like: hashes everywhere, never secrets. */
const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|flake\.lock|packages\.lock\.json|[^/]*\.min\.(?:js|css)|[^/]*\.map|[^/]*\.svg)$/i;

/** Files that are secrets by name. */
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[^/]*\.pem|[^/]*\.key|[^/]*\.p12|[^/]*\.pfx|[^/]*\.keystore|[^/]*\.jks|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|credentials\.json|service[-_]account[^/]*\.json)$/i;

export const isSecretFile = (file: string) => SECRET_FILE.test(file.replace(/\\/g, '/'));

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of n.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** "AKIA…MPLE" style: enough to recognise, not enough to use. */
export function redact(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length);
  const k = Math.min(4, Math.floor(s.length / 6));
  return `${s.slice(0, k)}${'*'.repeat(Math.min(12, s.length - 2 * k))}${s.slice(-k)}`;
}

/** `name = "value"` with a long, random-looking value (letters, digits and symbols mixed). */
const ASSIGN = /([A-Za-z_][\w.-]*)['"]?\s*(?::=|=|:)\s*['"`]([A-Za-z0-9+/=_\-.]{24,})['"`]/;
const SENSITIVE_NAME = /key|secret|token|pass|cred|auth|private|signature|salt/i;
const HASHY_NAME = /hash|sha|md5|integrity|checksum|digest|etag|uuid|guid|id$|commit|rev/i;

/** snake_case / kebab-case / dotted names and paths: words, not secrets. */
const isIdentifier = (v: string) => /^[a-z0-9_./-]+$/.test(v) && /[._/-]/.test(v) && !/\d{3}/.test(v);

function highEntropy(line: string): string | undefined {
  const m = ASSIGN.exec(line);
  if (!m) return undefined;
  const [, name, value] = m;
  if (!SENSITIVE_NAME.test(name) || HASHY_NAME.test(name)) return undefined;
  if (/^[0-9a-f]+$/i.test(value) && !/key|secret|token/i.test(name)) return undefined; // plain hex: usually a hash
  if (isIdentifier(value)) return undefined;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(value)).length;
  return classes >= 2 && entropy(value) >= 4 ? value : undefined;
}

/** Secrets in one added line. */
export function scanLine(text: string): { rule: string; match: string }[] {
  if (text.includes(ALLOW_MARK)) return [];
  const out: { rule: string; match: string }[] = [];
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const match = m[r.group ?? 0];
    if (r.name !== 'Private key' && PLACEHOLDER.test(match)) continue;
    if (r.name === 'Hard-coded secret' && (PLACEHOLDER.test(text) || entropy(match) < 3 || isIdentifier(match))) continue;
    out.push({ rule: r.name, match });
  }
  if (!out.length) {
    const v = highEntropy(text);
    if (v && !PLACEHOLDER.test(v)) out.push({ rule: 'High-entropy value', match: v });
  }
  return out;
}

/** Scans the added lines of a unified diff (git diff output). */
export function scanDiff(diff: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  let file = '';
  let line = 0;
  let skip = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '').trim();
      skip = file === '/dev/null' || SKIP_FILE.test(file);
      continue;
    }
    if (raw.startsWith('diff --git') || raw.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      if (!skip) for (const f of scanLine(raw.slice(1))) found.push({ file, line, rule: f.rule, redacted: redact(f.match) });
      line++;
    } else if (raw.startsWith(' ')) line++;
  }
  return found;
}

/** Whole-file findings for staged paths named like secrets (.env, *.pem, id_rsa). */
export function scanFileNames(files: string[]): SecretFinding[] {
  return files.filter(isSecretFile).map((file) => ({ file, line: 0, rule: 'Secret file', redacted: file.split('/').pop() ?? file }));
}

/** One line per finding, for the warning. */
export const describeFindings = (f: SecretFinding[], max = 15) =>
  [...f.slice(0, max).map((x) => `${x.file}${x.line ? `:${x.line}` : ''}  ${x.rule}: ${x.redacted}`), ...(f.length > max ? [`… +${f.length - max}`] : [])].join('\n');
