// Token usage and API-equivalent cost, aggregated from session transcripts.
import { Engine, type Session } from './engine';
import { costOf, modelLabel, type Tokens } from './pricing';

import type { UsageRow } from './engine';

type Bucket = Tokens & { cost: number; unpriced: number };
const empty = (): Bucket => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, unpriced: 0 });
function add(b: Bucket, r: UsageRow) {
  b.input += r.input;
  b.output += r.output;
  b.cacheWrite += r.cacheWrite;
  b.cacheRead += r.cacheRead;
  const c = costOf(r.model, r);
  if (c === undefined) b.unpriced += r.input + r.output + r.cacheWrite + r.cacheRead;
  else b.cost += c;
}

export interface UsageReport {
  days: number;
  totals: Bucket;
  byModel: (Bucket & { model: string; label: string })[];
  byDay: { day: string; cost: number; tokens: number; byModel: Record<string, number> }[];
  byProject: (Bucket & { project: string })[];
  topSessions: (Bucket & { id: string; title: string; project: string })[];
}

/** Local calendar day (YYYY-MM-DD), so 'today' matches the user's clock, not UTC. */
export const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const rowsOf = (s: Session): UsageRow[] => [...s.t.usage, ...s.agents.flatMap((a) => a.t.usage)];

export function usageReport(sessions: Session[], days: number, now = Date.now()): UsageReport {
  const since = new Date(now - days * 86_400_000).toISOString();
  const totals = empty();
  const byModel = new Map<string, Bucket>();
  const byDay = new Map<string, { cost: number; tokens: number; byModel: Record<string, number> }>();
  const byProject = new Map<string, Bucket>();
  const bySession: (Bucket & { id: string; title: string; project: string })[] = [];

  for (let i = days - 1; i >= 0; i--) byDay.set(localDay(new Date(now - i * 86_400_000)), { cost: 0, tokens: 0, byModel: {} });

  for (const s of sessions) {
    const sb = { ...empty(), id: s.info.id, title: s.info.title, project: s.info.project };
    for (const r of rowsOf(s)) {
      if (r.ts < since) continue;
      add(totals, r);
      add(sb, r);
      add(byModel.get(r.model) ?? byModel.set(r.model, empty()).get(r.model)!, r);
      add(byProject.get(s.info.project) ?? byProject.set(s.info.project, empty()).get(s.info.project)!, r);
      const d = byDay.get(localDay(new Date(r.ts)));
      if (d) {
        const c = costOf(r.model, r) ?? 0;
        d.cost += c;
        d.tokens += r.input + r.output + r.cacheWrite + r.cacheRead;
        d.byModel[modelLabel(r.model)] = (d.byModel[modelLabel(r.model)] ?? 0) + c;
      }
    }
    if (sb.input + sb.output + sb.cacheWrite + sb.cacheRead > 0) bySession.push(sb);
  }
  return {
    days,
    totals,
    byModel: [...byModel].map(([model, b]) => ({ ...b, model, label: modelLabel(model) })).sort((a, b) => b.cost - a.cost),
    byDay: [...byDay].map(([day, v]) => ({ day, ...v })),
    byProject: [...byProject].map(([project, b]) => ({ ...b, project })).sort((a, b) => b.cost - a.cost),
    topSessions: bySession.sort((a, b) => b.cost - a.cost).slice(0, 12),
  };
}

export { Engine };
