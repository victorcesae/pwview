// A turn's steps (thinking, tool calls, in-between notes) under one heading, like t3code:
// "Working for 9s" while it runs, then "Worked for 19s ›", folded, with only the answer showing.
import type { ChatItem } from '@/types';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
export type Row = ChatItem | Tool[];
export type WorkRow = { kind: 'work'; id: string; live: boolean; since?: number; durationMs?: number; steps: number; open: boolean };

/** Rows that are part of the work, not something the user must see or answer. */
const isStep = (g: Row) => Array.isArray(g) || g.kind === 'thinking' || g.kind === 'assistant' || (g.kind === 'tool' && g.status !== 'running');

const tsOf = (g: Row): number | undefined => {
  const it = Array.isArray(g) ? g.at(-1) : g;
  const ts = it && 'ts' in it ? (it as { ts?: string }).ts : undefined;
  const n = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Puts a heading before each turn's steps. A finished turn's steps are hidden unless opened; its
 * last answer stays. The running turn shows everything. Approvals, questions, plans and errors
 * always stay where they are.
 */
export function foldTurns(rows: Row[], opened: ReadonlySet<string>, working: boolean): (Row | WorkRow)[] {
  const out: (Row | WorkRow)[] = [];
  let i = 0;
  // rows before the first prompt (resumed history notes) stay as they are
  while (i < rows.length && !(!Array.isArray(rows[i]) && (rows[i] as ChatItem).kind === 'user')) out.push(rows[i++]);
  while (i < rows.length) {
    const user = rows[i] as Extract<ChatItem, { kind: 'user' }>;
    out.push(user);
    let end = i + 1;
    while (end < rows.length && (Array.isArray(rows[end]) || (rows[end] as ChatItem).kind !== 'user')) end++;
    const seg = rows.slice(i + 1, end);
    const live = working && end === rows.length;
    // the answer: the turn's last top-level text (not while the turn still runs)
    let answer = -1;
    if (!live) for (let k = seg.length - 1; k >= 0; k--) {
      const g = seg[k];
      if (!Array.isArray(g) && g.kind === 'assistant' && !g.parent) {
        answer = k;
        break;
      }
    }
    const steps = seg.filter((g, k) => k !== answer && isStep(g));
    if (steps.length < (live ? 1 : 2)) {
      out.push(...seg);
    } else {
      const id = `work:${user.id}`;
      const open = live || opened.has(id);
      const since = Date.parse(user.ts);
      const ans = answer >= 0 ? (seg[answer] as Extract<ChatItem, { kind: 'assistant' }>) : undefined;
      const lastTs = [...seg].reverse().map(tsOf).find((x) => x !== undefined);
      const durationMs = ans?.durationMs ?? (lastTs !== undefined && Number.isFinite(since) ? lastTs - since : undefined);
      out.push({ kind: 'work', id, live, since: Number.isFinite(since) ? since : undefined, durationMs, steps: steps.length, open });
      seg.forEach((g, k) => {
        if (k === answer || !isStep(g) || open) out.push(g);
      });
    }
    i = end;
  }
  return out;
}
