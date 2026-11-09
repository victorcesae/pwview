// Claude Code hook entry point: `node hook.js <stop|prompt|posttool|sessionstart>`.
// - Delivers the developer's messages (steer between steps, queue at turn end / next prompt).
// - Records which terminal runs each session, so the extension can "send now" into it.
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { deliver, formatComments, HookEvent } from './comments';
import { dataDir } from './paths';

const event = (process.argv[2] ?? 'stop') as HookEvent | 'sessionstart';

function parentOf(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || undefined;
    }
    if (process.platform !== 'win32') return Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' }).trim()) || undefined;
  } catch {
    /* process gone */
  }
}

/** Ancestors of the hook: claude, then the shell/terminal that started it, and up. */
function ancestry(): number[] {
  if (process.platform === 'win32') {
    if (event !== 'sessionstart') return []; // too slow to do on every hook on Windows
    try {
      const csv = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId),$($_.ParentProcessId)\\" }"', { encoding: 'utf8', timeout: 4000 });
      const parent = new Map(csv.split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map(Number) as [number, number]));
      const out: number[] = [];
      for (let p: number | undefined = process.ppid; p && out.length < 8; p = parent.get(p)) out.push(p);
      return out;
    } catch {
      return [process.ppid];
    }
  }
  const out: number[] = [];
  for (let p: number | undefined = process.ppid; p && p > 1 && out.length < 8; p = parentOf(p)) out.push(p);
  return out;
}

function recordTerminal(sessionId: string, cwd?: string) {
  const dir = path.join(dataDir(), 'terminals');
  const file = path.join(dir, `${sessionId}.json`);
  const token = process.env.STEERHOUSE_TERMINAL;
  const pids = ancestry();
  if (!token && !pids.length) return; // keep what SessionStart recorded (Windows)
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionId, token, pids, cwd, ts: new Date().toISOString() }));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let p: { session_id?: string; agent_id?: string; cwd?: string } = {};
  try {
    p = JSON.parse(input);
  } catch {
    return;
  }
  if (!p.session_id) return;
  try {
    if (event !== 'posttool') recordTerminal(p.session_id, p.cwd);
  } catch {
    /* never break the agent over bookkeeping */
  }
  if (event === 'sessionstart') return;

  const picked = deliver(p.session_id, event, p.agent_id);
  if (!picked.length) return;
  const text = formatComments(picked, event);
  const hookEventName = event === 'posttool' ? 'PostToolUse' : event === 'prompt' ? 'UserPromptSubmit' : 'Stop';
  const out = event === 'stop' ? { decision: 'block', reason: text } : { hookSpecificOutput: { hookEventName, additionalContext: text } };
  process.stdout.write(JSON.stringify(out));
});
