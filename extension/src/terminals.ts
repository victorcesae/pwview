// Which VS Code terminal runs which agent session, and typing into it ("send now").
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { dataDir } from './paths';

/** AGENTLENS_TERMINAL token → terminal, for terminals AgentLens started itself. */
export const launched = new Map<string, vscode.Terminal>();

interface Record {
  sessionId: string;
  token?: string;
  pids: number[];
  ts: string;
}

function records(): Record[] {
  const dir = path.join(dataDir(), 'terminals');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as Record];
    } catch {
      return [];
    }
  });
}

let attached = new Map<string, vscode.Terminal>();

/** Recompute session → terminal (call on refresh). A terminal belongs to the session it ran most recently. */
export async function resolveTerminals(): Promise<Map<string, vscode.Terminal>> {
  const open = vscode.window.terminals;
  const byPid = new Map<number, vscode.Terminal>();
  await Promise.all(
    open.map(async (t) => {
      const pid = await t.processId;
      if (pid) byPid.set(pid, t);
    }),
  );
  const best = new Map<vscode.Terminal, Record>();
  for (const r of records()) {
    let t = r.token ? launched.get(r.token) : undefined;
    if (t && !open.includes(t)) t = undefined;
    t ??= r.pids.map((p) => byPid.get(p)).find(Boolean);
    if (!t) continue;
    const prev = best.get(t);
    if (!prev || r.ts > prev.ts) best.set(t, r);
  }
  attached = new Map([...best.entries()].map(([t, r]) => [r.sessionId, t]));
  return attached;
}

export const terminalFor = (sessionId: string) => attached.get(sessionId);
export const attachedSessions = () => new Set(attached.keys());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Type a message into the agent's terminal and submit it. When `interrupt` is set the
 * running turn is stopped first (Esc), like pressing Esc yourself. Bracketed paste keeps
 * multi-line text as one message.
 */
export async function typeInto(t: vscode.Terminal, text: string, interrupt: boolean) {
  t.show(true);
  if (interrupt) {
    t.sendText('\x1b', false);
    await sleep(700);
  }
  t.sendText(`\x1b[200~${text.trim()}\x1b[201~`, false);
  await sleep(150);
  t.sendText('\r', false);
}
