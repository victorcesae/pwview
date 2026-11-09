// Commands the user runs from the chat box with !: their own shell, in the chat's folder.
import { spawn, spawnSync, type ChildProcess } from 'child_process';

/** Output kept per command: long-running commands keep their latest output. */
export const OUTPUT_LIMIT = 256 * 1024;
/** Output handed to the agent with the next message. */
const CONTEXT_LIMIT = 20 * 1024;

export const tail = (text: string, limit: number) => (text.length > limit ? `[…earlier output cut…]\n${text.slice(-limit)}` : text);

/** How the agent is told about a command the user ran. */
export const shellContext = (command: string, output: string, exitCode: number | null) =>
  `<user-ran-command exit-code="${exitCode ?? 'stopped'}">\n$ ${command}\n${tail(output, CONTEXT_LIMIT)}\n</user-ran-command>`;

export interface ShellDone {
  exitCode: number | null;
  error?: string;
}

/** Runs one command line. No stdin, so a command waiting for input ends instead of hanging. */
export class ShellRun {
  private child: ChildProcess;
  private done = false;
  output = '';

  constructor(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }, onOutput: () => void, onDone: (r: ShellDone) => void) {
    const win = process.platform === 'win32';
    this.child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: win ? true : process.env.SHELL || true, stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true });
    const add = (d: Buffer) => {
      this.output = (this.output + d.toString('utf8')).slice(-OUTPUT_LIMIT);
      onOutput();
    };
    this.child.stdout?.on('data', add);
    this.child.stderr?.on('data', add);
    const finish = (r: ShellDone) => {
      if (this.done) return;
      this.done = true;
      onDone(r);
    };
    this.child.on('error', (e) => finish({ exitCode: null, error: e.message }));
    this.child.on('close', (code) => finish({ exitCode: code }));
  }

  /** Ends the command and whatever it started. */
  stop() {
    if (this.done || !this.child.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      return;
    }
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

/** A message as the user wrote it, without the command output that was added for the agent. */
export const withoutShellContext = (text: string) => text.replace(/\s*<user-ran-command\b[^>]*>[\s\S]*?<\/user-ran-command>/g, '');
