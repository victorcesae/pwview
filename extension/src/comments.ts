// Messages and review comments for agents. Shared by the extension and the hook script,
// so it must stay free of `vscode` imports.
import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from './paths';

/**
 * steer: injected between the agent's steps (PostToolUse), without stopping it.
 * queue: handed over when the current turn ends (Stop), or on the next prompt.
 * now:   typed into the session's terminal after interrupting it (done by the extension);
 *        stored here only as history, or as a steer fallback when no terminal is attached.
 */
export type Mode = 'steer' | 'queue' | 'now';

export interface Comment {
  id: string;
  sessionId: string;
  agentId?: string;
  changeId?: string;
  file?: string;
  line?: number;
  snippet?: string;
  text: string;
  mode?: Mode;
  created: string;
  status: 'pending' | 'delivered' | 'cancelled';
  deliveredAt?: string;
  deliveredVia?: 'step' | 'turn-end' | 'prompt' | 'terminal';
}

const file = () => path.join(dataDir(), 'comments.json');

export function loadComments(): Comment[] {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return [];
  }
}

export function saveComments(all: Comment[]) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, file());
}

export function addComment(c: Omit<Comment, 'id' | 'created' | 'status'> & Partial<Pick<Comment, 'status' | 'deliveredAt' | 'deliveredVia'>>): Comment {
  const full: Comment = {
    status: 'pending',
    ...c,
    mode: c.mode ?? 'queue',
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    created: new Date().toISOString(),
  };
  saveComments([...loadComments(), full]);
  return full;
}

export function editComment(id: string, text: string) {
  const all = loadComments();
  const c = all.find((x) => x.id === id && x.status === 'pending');
  if (c && text.trim()) {
    c.text = text;
    saveComments(all);
  }
}

export function cancelComment(id: string) {
  const all = loadComments();
  const c = all.find((x) => x.id === id && x.status === 'pending');
  if (c) {
    c.status = 'cancelled';
    saveComments(all);
  }
}

export type HookEvent = 'stop' | 'prompt' | 'posttool';

/**
 * Pick and mark delivered what this hook event should hand to the agent.
 * - posttool: steer messages for exactly this thread (main agent, or the targeted sub-agent)
 * - stop / prompt: everything still pending for the session (sub-agent comments included,
 *   since a finished sub-agent can only be followed up by the main agent)
 */
export function deliver(sessionId: string, event: HookEvent, agentId?: string): Comment[] {
  const all = loadComments();
  const picked = all.filter((c) => {
    if (c.sessionId !== sessionId || c.status !== 'pending') return false;
    if (event !== 'posttool') return !agentId; // turn-level events belong to the main agent
    const steer = c.mode === 'steer' || c.mode === 'now';
    return steer && (c.agentId ? c.agentId === agentId : !agentId);
  });
  if (!picked.length) return [];
  const now = new Date().toISOString();
  const via = event === 'posttool' ? 'step' : event === 'stop' ? 'turn-end' : 'prompt';
  for (const c of picked) {
    c.status = 'delivered';
    c.deliveredAt = now;
    c.deliveredVia = via;
  }
  saveComments(all);
  return picked;
}

export function formatComments(cs: Comment[], event: HookEvent): string {
  let out =
    event === 'posttool'
      ? 'The developer is steering you mid-task (via AgentLens). Take this into account from your next step on, without abandoning the task unless told to:\n'
      : 'The developer sent you these messages via AgentLens. Address each one (change the code where asked, or briefly explain why not):\n';
  cs.forEach((c, i) => {
    const loc = c.file ? (c.line !== undefined ? `${c.file}:${c.line + 1}` : c.file) : '';
    out += `\n${i + 1}. ${loc ? `[${loc}] ` : ''}${c.text.trim()}`;
    if (c.snippet?.trim()) out += `\n   on: \`${c.snippet.trim().slice(0, 200)}\``;
  });
  return out;
}
