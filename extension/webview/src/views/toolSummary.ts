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
