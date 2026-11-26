/** What a chat row in the Sessions sidebar says first, like t3code's thread list. Pure (no vscode). */
export type RowKind = 'working' | 'waiting' | 'done' | 'idle';

export interface RowInput {
  /** the engine's state of the transcript */
  state: 'working' | 'recent' | 'idle';
  /** an approval or a question is pending in the open chat */
  waiting?: boolean;
  /** when the chat was first seen working (ms) */
  workingSince?: number;
  /** when the chat was seen to stop working (ms) */
  finishedAt?: number;
  /** when the user last opened it (ms) */
  seenAt?: number;
  /** last activity (ISO), for the relative time */
  updated?: string;
  now: number;
}

/** a finished chat reads "Done" this long, until it is opened */
export const DONE_FOR_MS = 10 * 60_000;

/** "14s", "2m", "1h", "3d" */
export function shortAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

type T = (s: string, ...args: (string | number)[]) => string;
const plain: T = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, n) => String(a[+n]));

export function rowStatus(i: RowInput, t: T = plain): { kind: RowKind; label: string } {
  if (i.waiting) return { kind: 'waiting', label: t('Waiting for you') };
  if (i.state === 'working') return { kind: 'working', label: t('Working {0}', shortAgo(i.now - (i.workingSince ?? i.now))) };
  if (i.finishedAt && i.now - i.finishedAt < DONE_FOR_MS && !(i.seenAt && i.seenAt >= i.finishedAt)) return { kind: 'done', label: t('Done') };
  const u = i.updated ? Date.parse(i.updated) : NaN;
  return { kind: 'idle', label: Number.isFinite(u) ? shortAgo(i.now - u) : '' };
}

/** status first, then folder · branch (empty parts dropped) */
export const rowDescription = (status: string, folder?: string, branch?: string) => [status, folder, branch].filter(Boolean).join(' · ');
