// Commands an agent left running in the background (dev servers, watchers, long test runs): Bash
// calls with run_in_background. Claude Code writes each one's output to a file and later records a
// <task-notification> when it ends. Steerhouse runs where the agent runs, so it can read that file
// live, for chats it drives and for sessions running in a terminal alike.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type BgStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

export interface BgTask {
  id: string;
  toolUseId?: string;
  command: string;
  description?: string;
  outputFile?: string;
  status: BgStatus;
  started?: string;
  ended?: string;
  /** started by a sub-agent */
  agentId?: string;
}

/** "Command running in background with ID: b2tazn3ft. Output is being written to: C:\…\b2tazn3ft.output." */
export function parseStarted(text: string): { id: string; outputFile?: string } | undefined {
  const m = /running in (?:the )?background with ID:\s*([\w-]+)/i.exec(text);
  if (!m) return undefined;
  const f = /Output is being written to:\s*(.+?\.output)\b/i.exec(text);
  return { id: m[1], outputFile: f?.[1]?.trim() };
}

/** Every <task-notification> in a text: which task ended, how, and where its output is. */
export function parseNotifications(text: string): { id: string; status: BgStatus; outputFile?: string; toolUseId?: string }[] {
  const out: { id: string; status: BgStatus; outputFile?: string; toolUseId?: string }[] = [];
  for (const block of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(block)?.[1]?.trim();
    const id = tag('task-id');
    if (!id) continue;
    const s = (tag('status') ?? '').toLowerCase();
    const status: BgStatus = s === 'completed' ? 'completed' : s === 'failed' ? 'failed' : s === 'stopped' || s === 'killed' ? 'stopped' : 'unknown';
    out.push({ id, status, outputFile: tag('output-file'), toolUseId: tag('tool-use-id') });
  }
  return out;
}

/** Collects background commands from transcript records, in order (used for every session). */
export class BgTaskTracker {
  readonly tasks: BgTask[] = [];
  private calls = new Map<string, { command: string; description?: string; ts?: string; agentId?: string }>();

  /** A Bash tool call: remembered when it asks to run in the background. */
  toolUse(id: string, name: string, input: any, ts?: string, agentId?: string) {
    if ((name === 'Bash' || name === 'PowerShell') && input?.run_in_background) this.calls.set(id, { command: String(input.command ?? ''), description: input.description, ts, agentId });
  }

  /** A tool result: the "running in background" answer gives the task id and output file. */
  toolResult(toolUseId: string, text: string, ts?: string) {
    const call = this.calls.get(toolUseId);
    // Any tool can return these words (reading this very file does). Only a background call counts,
    // or a result that is that notice (a command moved to the background while it ran).
    if (!call && !/^\s*Command running in (?:the )?background/i.test(text)) return;
    const s = parseStarted(text);
    if (!s || this.tasks.some((t) => t.id === s.id)) return;
    this.tasks.push({ id: s.id, toolUseId, command: call?.command ?? '', description: call?.description, outputFile: s.outputFile, status: 'running', started: call?.ts ?? ts, agentId: call?.agentId });
  }

  /** Any text (a user record, an attachment) can carry task notifications. */
  text(text: string, ts?: string) {
    if (!text.includes('<task-notification>')) return;
    for (const n of parseNotifications(text)) {
      const t = this.tasks.find((x) => x.id === n.id);
      if (!t) continue;
      t.status = n.status;
      t.ended = ts;
      t.outputFile ??= n.outputFile;
    }
  }
}

/**
 * Where Claude Code keeps the output of a session's commands. The SDK only names the file when a
 * command ends, and for a command the agent waits on it deletes the file at that moment.
 */
export function sessionTasksDir(cwd: string, sessionId: string, platform = process.platform, tmp = process.env.CLAUDE_CODE_TMPDIR || os.tmpdir(), uid = process.getuid?.()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(tmp, platform === 'win32' || uid === undefined ? 'claude' : `claude-${uid}`, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'tasks');
}

/** The end of a task's output (default 16 KiB), as text without terminal colour codes. */
export function readTail(file: string | undefined, bytes = 16 * 1024): { text: string; size: number; mtime?: number; missing?: boolean } {
  if (!file) return { text: '', size: 0, missing: true };
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(bytes, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      let text = buf.toString('utf8');
      if (len < st.size) text = text.slice(text.indexOf('\n') + 1); // start at a whole line
      return { text: stripAnsi(text), size: st.size, mtime: st.mtimeMs };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { text: '', size: 0, missing: true };
  }
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\r(?!\n)/g, '\n');

/** Local addresses a dev server printed (http://localhost:5173/ …), newest last, no repeats. */
export function findUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/g)) {
    seen.delete(m[0]);
    seen.add(m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, ''));
  }
  return [...seen];
}

/**
 * For a session whose agent is not driven by Steerhouse, a task without a notification may still
 * run, or may have died with its CLI. Output written recently means it is alive.
 */
export function guessStatus(t: BgTask, sessionWorking: boolean, now = Date.now()): BgStatus {
  if (t.status !== 'running') return t.status;
  if (sessionWorking) return 'running';
  try {
    const age = now - fs.statSync(t.outputFile ?? '').mtimeMs;
    return age < 5 * 60_000 ? 'running' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Every string inside a record value, joined (to find task notifications wherever they are). */
export function textsOf(x: unknown, depth = 0): string {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object' || depth > 6) return '';
  return (Array.isArray(x) ? x : Object.values(x)).map((v) => textsOf(v, depth + 1)).filter(Boolean).join('\n');
}

/** SDK task status words → ours. */
export function sdkStatus(s?: string): BgStatus | undefined {
  if (!s) return undefined;
  if (s === 'running' || s === 'pending' || s === 'paused') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'killed' || s === 'stopped') return 'stopped';
  return undefined;
}
