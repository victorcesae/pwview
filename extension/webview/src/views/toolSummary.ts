// Grouping consecutive tool calls and the one-line summary ("Read and edited chat.ts, ran 1 command").
// Kept free of UI components so it can be unit-tested in Node.
import { t } from '@/i18n';
import { base } from '@/lib/utils';
import type { ChatItem } from '@/types';

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

export const stat = (it: ToolItem) => {
  const lines = (it.patch ?? []).flatMap((h) => h.lines);
  return { add: lines.filter((l) => l[0] === '+').length, del: lines.filter((l) => l[0] === '-').length };
};
export const fileOf = (it: ToolItem) => (it.file ? base(it.file) : '');
export const inp = (it: ToolItem) => (it.input ?? {}) as Record<string, unknown>;
const BROWSER = /^mcp__.*(browser|playwright|puppeteer|chrome|pwview)/i;
export const KIND = (n: string) =>
  n === 'Read'
    ? 'read'
    : n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit'
      ? 'edit'
      : n === 'Bash' || n === 'PowerShell'
        ? 'run'
        : n === 'Grep' || n === 'Glob' || n === 'WebSearch'
          ? 'search'
          : n === 'WebFetch' || BROWSER.test(n)
            ? 'browser'
            : n.startsWith('mcp__')
              ? 'mcp'
              : 'other';

/** One sentence for a run of tool calls, e.g. "Ran 4 commands and searched code 1 time". */
export function summarizeTools(items: ToolItem[]): string {
  const count = (k: string) => items.filter((i) => KIND(i.name) === k).length;
  const parts: string[] = [];
  const n = (k: string, one: string, many: string) => {
    const c = count(k);
    if (c) parts.push(c === 1 ? t(one) : t(many, c));
  };
  n('run', 'ran 1 command', 'ran {0} commands');
  n('read', 'read 1 file', 'read {0} files');
  n('edit', 'edited 1 file', 'edited {0} files');
  n('search', 'searched code 1 time', 'searched code {0} times');
  n('browser', 'used browser 1 time', 'used browser {0} times');
  n('mcp', 'used 1 tool', 'used {0} tools');
  n('other', 'performed 1 other action', 'performed {0} other actions');
  const s = parts.length > 1 ? t('{0} and {1}', parts.slice(0, -1).join(', '), parts.at(-1)!) : (parts[0] ?? '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const AGENT = (n: string) => n === 'Agent' || n === 'Task';
export const isAgentCall = (it: ChatItem): it is ToolItem => it.kind === 'tool' && AGENT(it.name);

/**
 * Consecutive plain tool calls become one group. Sub-agents keep their own row (they nest their steps);
 * several launched back to back (running side by side) become one agents group.
 */
export function groupTools(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const out: (ChatItem | ToolItem[])[] = [];
  for (const it of items) {
    if (it.kind === 'tool' && it.name === 'TodoWrite') continue; // the plan card already shows TodoWrite
    const last = out.at(-1);
    if (it.kind === 'tool' && AGENT(it.name)) {
      if (Array.isArray(last) && isAgentCall(last[0])) last.push(it as ToolItem);
      else if (last && !Array.isArray(last) && isAgentCall(last)) out[out.length - 1] = [last as ToolItem, it as ToolItem];
      else out.push(it);
    } else if (it.kind === 'tool') {
      if (Array.isArray(last) && !isAgentCall(last[0])) last.push(it as ToolItem);
      else out.push([it as ToolItem]);
    } else out.push(it);
  }
  return out;
}

// ---- right rail: PRs the agent opened and files changed per project

const PR_RE = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|gitlab\.[\w.-]+\/[\w./-]+\/-\/merge_requests\/\d+|dev\.azure\.com\/[\w./-]+\/pullrequest\/\d+|bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+)/g;

export interface PrRef {
  url: string;
  /** owner/repo#123 */
  label: string;
}

/** Pull/merge request links found in tool output and answers, oldest first, no repeats. */
export function findPRs(items: { kind: string; text?: string; result?: string }[]): PrRef[] {
  const seen = new Map<string, PrRef>();
  for (const it of items) {
    const text = `${it.text ?? ''}\n${it.result ?? ''}`;
    for (const url of text.match(PR_RE) ?? []) {
      if (seen.has(url)) continue;
      const gh = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url);
      const n = /(\d+)$/.exec(url)?.[1];
      seen.set(url, { url, label: gh ? `${gh[1]}#${gh[2]}` : `!${n}` });
    }
  }
  return [...seen.values()];
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** The project a file belongs to: the chat's folder, or a sibling folder next to it (e.g. ../api-gateway). */
export function projectOf(file: string, cwd: string): { name: string; root: string } {
  const f = norm(file);
  const c = norm(cwd);
  const lower = (s: string) => s.toLowerCase();
  if (lower(f).startsWith(lower(c) + '/')) return { name: c.split('/').pop() || c, root: c };
  const parent = c.slice(0, c.lastIndexOf('/'));
  if (parent && lower(f).startsWith(lower(parent) + '/')) {
    const name = f.slice(parent.length + 1).split('/')[0];
    return { name, root: `${parent}/${name}` };
  }
  const parts = f.split('/');
  const root = parts.slice(0, Math.max(1, parts.length - 1)).join('/');
  return { name: parts.at(-2) ?? root, root };
}

export interface ProjectChanges {
  name: string;
  root: string;
  files: { path: string; rel: string; edits: number; added: number; removed: number }[];
}

/** Edited files grouped by project, the chat's own project first. */
export function changesByProject(items: { kind: string; name?: string; file?: string; patch?: { lines: string[] }[] }[], cwd: string): ProjectChanges[] {
  const projects = new Map<string, ProjectChanges>();
  for (const it of items) {
    if (it.kind !== 'tool' || !it.file || !/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(it.name ?? '')) continue;
    const p = projectOf(it.file, cwd);
    const proj = projects.get(p.root) ?? projects.set(p.root, { ...p, files: [] }).get(p.root)!;
    const f = norm(it.file);
    let entry = proj.files.find((x) => x.path === f);
    if (!entry) proj.files.push((entry = { path: f, rel: f.slice(p.root.length + 1) || f, edits: 0, added: 0, removed: 0 }));
    entry.edits++;
    for (const h of it.patch ?? []) for (const l of h.lines) l[0] === '+' ? entry.added++ : l[0] === '-' && entry.removed++;
  }
  const own = norm(cwd).toLowerCase();
  return [...projects.values()].sort((a, b) => Number(b.root.toLowerCase() === own) - Number(a.root.toLowerCase() === own) || a.name.localeCompare(b.name));
}

/** "claude-opus-5-5" / "claude-sonnet-4-5-20250929" → "Opus 5.5" / "Sonnet 4.5"; other ids unchanged. */
export function prettyModel(id?: string): string | undefined {
  if (!id) return id;
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}${m[4] ? ' (1M)' : ''}`;
}
