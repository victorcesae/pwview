// Sessions the user linked together ("this chat should know what that session is doing").
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from './engine';
import { dataDir } from './paths';

const file = () => path.join(dataDir(), 'links.json');

export function loadLinks(): Record<string, string[]> {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

export function addLink(a: string, b: string) {
  const all = loadLinks();
  for (const [x, y] of [[a, b], [b, a]]) {
    all[x] = [...new Set([...(all[x] ?? []), y])];
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

export function removeLink(a: string, b: string) {
  const all = loadLinks();
  all[a] = (all[a] ?? []).filter((x) => x !== b);
  all[b] = (all[b] ?? []).filter((x) => x !== a);
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

/** Briefing an agent gets about a linked session, plus where to read its live transcript. */
export function briefing(s: Session): string {
  const i = s.info;
  const prompts = s.t.events.filter((e) => e.kind === 'prompt' && !e.agentId).slice(-6);
  const notes = s.t.events.filter((e) => e.kind === 'text' && !e.agentId).slice(-3);
  const lines = [
    `The developer linked another agent session to this one so you can see what it is doing. Treat it as read-only context: another agent may still be working there.`,
    ``,
    `Linked session: "${i.title}" (${i.state}, last activity ${i.updated ?? 'unknown'})`,
    `Project: ${i.project}${i.branch ? ` · branch ${i.branch}` : ''}`,
  ];
  if (prompts.length) lines.push('', 'Its recent prompts:', ...prompts.map((p) => `- ${p.text.replace(/\s+/g, ' ').slice(0, 300)}`));
  if (i.files.length) lines.push('', `Files it changed (${i.files.length}):`, ...i.files.slice(0, 40).map((f) => `- ${f}`));
  if (i.agents.length) lines.push('', 'Its sub-agents:', ...i.agents.map((a) => `- ${a.description} (${a.state}, ${a.edits} edits)`));
  if (notes.length) lines.push('', 'Its latest notes:', ...notes.map((n) => `- ${n.text.replace(/\s+/g, ' ').slice(0, 400)}`));
  lines.push(
    '',
    `Live transcript (JSONL, one event per line; read the end for the latest state): ${s.path}`,
    `Re-read it whenever you need to know what that session is doing now. Do not edit files it is changing without telling the developer.`,
  );
  return lines.join('\n');
}
