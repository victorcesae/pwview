// Graph of the work: sessions → their prompts (in order) → sub-agents spawned and files changed
// under each prompt. Prompts from different sessions that touched the same file meet at that file;
// sessions the user linked get an explicit edge. Pure function: unit-tested.
import { Engine, type Session } from './engine';
import { norm } from './paths';

export type GNode =
  | { id: string; type: 'session'; data: { sessionId: string; title: string; state: string; project: string; branch?: string } }
  | { id: string; type: 'prompt'; data: { sessionId: string; text: string; ts: string; index: number; edits: number } }
  | { id: string; type: 'agent'; data: { sessionId: string; agentId: string; description: string; state: string; edits: number } }
  | { id: string; type: 'file'; data: { path: string; sessions: number; edits: number } };

export interface GEdge {
  id: string;
  source: string;
  target: string;
  kind: 'next' | 'spawned' | 'edited' | 'linked' | 'start';
  label?: string;
}

export function buildGraph(sessions: Session[], links: Record<string, string[]>, opts = { promptsPerSession: 8, maxSessions: 14 }) {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const shown = sessions.slice(0, opts.maxSessions);
  const ids = new Set(shown.map((s) => s.info.id));

  // which files are shared between sessions (only those get their own node, to keep it readable)
  const fileSessions = new Map<string, { path: string; sessions: Set<string>; edits: number }>();
  for (const s of shown)
    for (const c of Engine.allChanges(s)) {
      const k = norm(c.file);
      const f = fileSessions.get(k) ?? { path: c.file, sessions: new Set(), edits: 0 };
      f.sessions.add(s.info.id);
      f.edits++;
      fileSessions.set(k, f);
    }
  const shared = new Map([...fileSessions].filter(([, f]) => f.sessions.size > 1));
  for (const [k, f] of shared) nodes.push({ id: `f:${k}`, type: 'file', data: { path: f.path, sessions: f.sessions.size, edits: f.edits } });

  for (const s of shown) {
    const sid = s.info.id;
    nodes.push({ id: `s:${sid}`, type: 'session', data: { sessionId: sid, title: s.info.title, state: s.info.state, project: s.info.project, branch: s.info.branch } });
    const prompts = s.t.events.filter((e) => e.kind === 'prompt' && !e.agentId);
    const offset = Math.max(0, prompts.length - opts.promptsPerSession);
    const recent = prompts.slice(offset);
    // a change / sub-agent belongs to the last prompt sent before it
    const owner = (ts: string) => {
      let idx = -1;
      for (let i = 0; i < recent.length; i++) if (recent[i].ts <= ts) idx = i;
      return idx;
    };
    const edits = new Array(recent.length).fill(0);
    const sharedByPrompt = new Map<number, Set<string>>();
    for (const c of Engine.allChanges(s)) {
      const i = owner(c.timestamp);
      if (i < 0) continue;
      edits[i]++;
      const k = norm(c.file);
      if (shared.has(k)) (sharedByPrompt.get(i) ?? sharedByPrompt.set(i, new Set()).get(i)!).add(k);
    }
    recent.forEach((p, i) => {
      const pid = `p:${sid}:${i + offset}`;
      nodes.push({ id: pid, type: 'prompt', data: { sessionId: sid, text: p.text.slice(0, 220), ts: p.ts, index: i + offset + 1, edits: edits[i] } });
      edges.push(i === 0 ? { id: `e:${sid}:start`, source: `s:${sid}`, target: pid, kind: 'start' } : { id: `e:${pid}:next`, source: `p:${sid}:${i + offset - 1}`, target: pid, kind: 'next' });
      for (const k of sharedByPrompt.get(i) ?? []) edges.push({ id: `e:${pid}:f:${k}`, source: pid, target: `f:${k}`, kind: 'edited' });
    });
    for (const a of s.agents) {
      const i = owner(a.t.started ?? a.info.updated ?? '');
      const aid = `a:${sid}:${a.info.id}`;
      nodes.push({ id: aid, type: 'agent', data: { sessionId: sid, agentId: a.info.id, description: a.info.description, state: a.info.state, edits: a.info.edits } });
      edges.push({ id: `e:${aid}`, source: i >= 0 ? `p:${sid}:${i + offset}` : `s:${sid}`, target: aid, kind: 'spawned' });
      for (const c of a.t.changes) {
        const k = norm(c.file);
        if (shared.has(k) && !edges.some((e) => e.source === aid && e.target === `f:${k}`)) edges.push({ id: `e:${aid}:f:${k}`, source: aid, target: `f:${k}`, kind: 'edited' });
      }
    }
  }

  // explicit links the user made (each pair once)
  const seen = new Set<string>();
  for (const [a, list] of Object.entries(links))
    for (const b of list) {
      const key = [a, b].sort().join('|');
      if (seen.has(key) || !ids.has(a) || !ids.has(b)) continue;
      seen.add(key);
      edges.push({ id: `e:link:${key}`, source: `s:${a}`, target: `s:${b}`, kind: 'linked', label: 'linked' });
    }
  return { nodes, edges };
}
