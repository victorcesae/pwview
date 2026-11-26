// Richer @-mentions in the chat box: @problems, @diff[:ref], @chat:<title>, @url:<https://…> and
// path#L5-10. They stay as written in the user's bubble; on send the host resolves each one to text
// the agent reads with the message (as a hidden note). Kept free of vscode so it can be unit-tested.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Mention =
  | { kind: 'problems'; raw: string }
  | { kind: 'diff'; raw: string; ref?: string }
  | { kind: 'chat'; raw: string; title: string }
  | { kind: 'url'; raw: string; url: string }
  | { kind: 'lines'; raw: string; file: string; from: number; to: number };

export const CAP = { problems: 100, diff: 60_000, chat: 15_000, url: 20_000, lines: 2_000 };

/** The mentions in a message (Markdown from the box: completed ones come as `code`), each once. */
export function parseMentions(md: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    raw = raw.trim();
    if (seen.has(raw)) return;
    const m = toMention(raw);
    if (m) {
      seen.add(raw);
      out.push(m);
    }
  };
  for (const m of md.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  // typed without completing: Markdown escapes some characters (x_y arrives as x\_y)
  const bare = md.replace(/`[^`\n]*`/g, ' ');
  for (const m of bare.matchAll(/(?:^|\s)(@(?:problems|diff(?::[^\s`]+)?|url:https?:\/\/[^\s`]+))/g)) add(m[1].replace(/\\(?=[^\s])/g, ''));
  return out;
}

function toMention(raw: string): Mention | undefined {
  if (raw === '@problems') return { kind: 'problems', raw };
  if (raw === '@diff') return { kind: 'diff', raw };
  let m = /^@diff:([\w./\-]+)$/.exec(raw);
  if (m) return { kind: 'diff', raw, ref: m[1] };
  m = /^@chat:(.+)$/.exec(raw);
  if (m) return { kind: 'chat', raw, title: m[1].trim() };
  m = /^@url:(https?:\/\/\S+)$/.exec(raw);
  if (m) return { kind: 'url', raw, url: m[1] };
  m = /^(\S+)#L(\d+)(?:-L?(\d+))?$/.exec(raw);
  if (m) {
    const from = Number(m[2]);
    const to = Math.max(from, Number(m[3] ?? m[2]));
    return { kind: 'lines', raw, file: m[1], from, to };
  }
  return undefined;
}

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (truncated, ${s.length - n} more characters)` : s);

/** The suggestions after the files in the @ menu, for what is typed after @. */
export function mentionCompletions(query: string, chats: string[], defaultBranch?: string): string[] {
  const q = query.toLowerCase();
  if (q.startsWith('url:')) return /^url:https?:\/\/\S+/i.test(query) ? [`@${query}`] : [];
  if (q.startsWith('chat:')) return chats.filter((c) => c.toLowerCase().includes(q.slice(5))).slice(0, 8).map((c) => `@chat:${c}`);
  const all = ['@problems', '@diff', ...(defaultBranch ? [`@diff:${defaultBranch}`] : []), ...chats.slice(0, 5).map((c) => `@chat:${c}`)];
  return all.filter((s) => s.slice(1).toLowerCase().startsWith(q) || (q.length >= 2 && s.toLowerCase().includes(q)));
}

/** An HTML page as plain text: no scripts, styles or tags, entities decoded, blank runs collapsed. */
export function htmlToText(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (named[e.toLowerCase()] ?? all),
    )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Item = { kind: string; text?: string; parent?: string };
/** Another chat in short: each prompt and the last answer of its turn. */
export function transcriptSummary(title: string, items: Item[]): string {
  const turns: { q: string; a?: string }[] = [];
  for (const it of items) {
    if (it.kind === 'user' && it.text?.trim()) turns.push({ q: it.text.trim() });
    else if (it.kind === 'assistant' && !it.parent && it.text?.trim() && turns.length) turns[turns.length - 1].a = it.text.trim();
  }
  const body = turns.map((t, i) => `## Prompt ${i + 1}\n${t.q}\n\n## Answer ${i + 1}\n${t.a ?? '(no answer)'}`).join('\n\n');
  return cap(`Chat "${title}":\n\n${body || '(empty)'}`, CAP.chat);
}

/** The lines of a file, numbered, for path#L5-10. */
export function readLines(cwd: string, file: string, from: number, to: number): string {
  const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const end = Math.min(to, lines.length, from + CAP.lines - 1);
  const shown = lines.slice(from - 1, end).map((l, i) => `${from + i}: ${l}`);
  const ext = path.extname(file).slice(1);
  return `${file} lines ${from}-${end}:\n\`\`\`${ext}\n${shown.join('\n')}\n\`\`\``;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((ok, bad) =>
    execFile(cmd, args, { cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => (err ? bad(new Error(stderr.trim() || err.message)) : ok(stdout))),
  );
}

/** origin's default branch (main, master…), else a local main or master. */
export async function defaultBranch(cwd: string): Promise<string | undefined> {
  const head = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).catch(() => '');
  if (head.trim()) return head.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (await run('git', ['rev-parse', '--verify', '--quiet', b], cwd).then(() => true, () => false)) return b;
  return undefined;
}

/** The working tree's diff against HEAD, or against a branch (its merge base, as a PR would show). */
export async function gitDiff(cwd: string, ref?: string): Promise<string> {
  let base = 'HEAD';
  if (ref) {
    const r = (await run('git', ['rev-parse', '--verify', '--quiet', ref], cwd).catch(() => '')) ? ref : `origin/${ref}`;
    base = (await run('git', ['merge-base', r, 'HEAD'], cwd).catch(() => r)).trim() || r;
  }
  const [stat, diff] = await Promise.all([run('git', ['diff', '--stat', base], cwd), run('git', ['diff', base], cwd)]);
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '')).trim();
  const head = `git diff ${ref ? ref + ' (merge base) ' : 'HEAD '}vs the working tree:\n${stat.trim() || '(no changes)'}${untracked ? `\nUntracked files:\n${untracked}` : ''}`;
  return cap(`${head}\n\n\`\`\`diff\n${diff}\n\`\`\``, CAP.diff);
}

/** A web page as text (only http/https, at most CAP.url characters). */
export async function fetchUrl(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Steerhouse (VS Code)', accept: 'text/html,text/plain,*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text|json|xml|javascript/.test(type) && type) throw new Error(`not text (${type})`);
    const body = (await res.text()).slice(0, 2_000_000);
    const text = /html/.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
    return cap(`Page ${url}:\n\n${text}`, CAP.url);
  } finally {
    clearTimeout(timer);
  }
}

export interface Resolvers {
  cwd: string;
  problems: () => string;
  chat: (title: string) => string | undefined;
}

/** Each mention as a note for the agent; one that fails says so instead of blocking the message. */
export async function resolveMentions(md: string, r: Resolvers): Promise<string[]> {
  const one = async (m: Mention): Promise<string> => {
    switch (m.kind) {
      case 'problems':
        return r.problems();
      case 'diff':
        return gitDiff(r.cwd, m.ref);
      case 'chat':
        return r.chat(m.title) ?? `No chat named "${m.title}" is open.`;
      case 'url':
        return fetchUrl(m.url);
      case 'lines':
        return readLines(r.cwd, m.file, m.from, m.to);
    }
  };
  return Promise.all(parseMentions(md).map(async (m) => `${m.raw} resolves to:\n${await one(m).catch((e) => `(could not be read: ${e instanceof Error ? e.message : e})`)}`));
}
