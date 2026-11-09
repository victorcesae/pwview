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
export const KIND = (n: string) =>
  n === 'Read' ? 'read' : n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit' ? 'edit' : n === 'Bash' || n === 'PowerShell' ? 'run' : n === 'Grep' || n === 'Glob' || n === 'WebSearch' ? 'search' : n === 'WebFetch' ? 'fetch' : 'other';

/** One sentence for a run of tool calls, e.g. "Read and edited chat.ts, ran 1 command". */
export function summarizeTools(items: ToolItem[]): string {
  const files = (k: string) => [...new Set(items.filter((i) => KIND(i.name) === k).map(fileOf).filter(Boolean))];
  const count = (k: string) => items.filter((i) => KIND(i.name) === k).length;
  const read = files('read');
  const edited = files('edit');
  const parts: string[] = [];
  const one = (list: string[], single: string, many: string) => (list.length === 1 ? t(single, list[0]) : t(many, list.length));
  if (read.length === 1 && edited.length === 1 && read[0] === edited[0]) parts.push(t('read and edited {0}', read[0]));
  else {
    if (read.length) parts.push(one(read, 'read {0}', 'read {0} files'));
    if (edited.length) parts.push(one(edited, 'edited {0}', 'edited {0} files'));
  }
  const n = (k: string, s: string, p: string) => count(k) && parts.push(count(k) === 1 ? t(s) : t(p, count(k)));
  n('run', 'ran 1 command', 'ran {0} commands');
  n('search', 'searched once', 'searched {0} times');
  n('fetch', 'fetched 1 page', 'fetched {0} pages');
  n('other', 'used 1 tool', 'used {0} tools');
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Consecutive plain tool calls become one group; sub-agents keep their own row (they nest their steps). */
export function groupTools(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const out: (ChatItem | ToolItem[])[] = [];
  for (const it of items) {
    const groupable = it.kind === 'tool' && it.name !== 'Agent' && it.name !== 'Task' && it.name !== 'TodoWrite';
    const last = out.at(-1);
    if (groupable && Array.isArray(last)) last.push(it as ToolItem);
    else if (groupable) out.push([it as ToolItem]);
    else if (!(it.kind === 'tool' && it.name === 'TodoWrite')) out.push(it); // the plan card already shows TodoWrite
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
