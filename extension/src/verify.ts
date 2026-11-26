// "Done means green": after a turn that changed files, run the project's verify command (typecheck,
// tests, lint) in the chat's folder, show ✓/✗ on that turn, and on failure hand the output back to the
// agent to fix, a few times at most per prompt.
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatItem, ChatSession } from './chat';

export interface VerifyResult {
  ok: boolean;
  command: string;
  durationMs: number;
  exitCode?: number | null;
  timedOut?: boolean;
  /** stopped: by you, or because you sent a message */
  cancelled?: boolean;
}

/** What the page sees (the output itself is fetched on demand). */
export interface VerifyState {
  /** this chat's toggle; undefined: on once a command is known */
  enabled?: boolean;
  command?: string;
  /** turn (user message id) being verified now */
  running?: string;
  results: Record<string, VerifyResult>;
}

const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
export const OUTPUT_TAIL = 8000;

type Reader = { exists(p: string): boolean; read(p: string): string | undefined };
const diskReader: Reader = {
  exists: (p) => fs.existsSync(p),
  read: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** A verify command guessed from the project files in `dir`, or undefined. */
export function detectVerifyCommand(dir: string, r: Reader = diskReader): string | undefined {
  const at = (f: string) => path.join(dir, f);
  const pkgText = r.read(at('package.json'));
  if (pkgText) {
    let scripts: Record<string, string> = {};
    try {
      scripts = JSON.parse(pkgText)?.scripts ?? {};
    } catch {}
    const pm = r.exists(at('pnpm-lock.yaml')) ? 'pnpm' : r.exists(at('yarn.lock')) ? 'yarn' : r.exists(at('bun.lockb')) || r.exists(at('bun.lock')) ? 'bun' : 'npm';
    const run = (s: string) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : `${pm} ${s === 'test' ? 'test' : 'run ' + s}`);
    // npm's placeholder test script fails on purpose: not a real test
    const real = (s: string) => typeof scripts[s] === 'string' && scripts[s].trim() && !/no test specified/.test(scripts[s]);
    const parts = ['typecheck', 'lint', 'test'].filter(real).map(run);
    if (parts.length) return parts.join(' && ');
  }
  if (r.exists(at('Cargo.toml'))) return 'cargo test';
  if (r.exists(at('go.mod'))) return 'go test ./...';
  if (r.exists(at('pytest.ini')) || r.exists(at('conftest.py')) || /\[tool\.pytest/.test(r.read(at('pyproject.toml')) ?? '') || /\[tool:pytest\]/.test(r.read(at('setup.cfg')) ?? '') || r.exists(at('tox.ini'))) return 'pytest';
  return undefined;
}

/** Colors out, then the last `max` characters (where errors usually are), marked when cut. */
export function trimOutput(text: string, max = OUTPUT_TAIL): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n').trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(-max);
  const nl = tail.indexOf('\n');
  const body = nl >= 0 && nl < 200 ? tail.slice(nl + 1) : tail;
  return `…(${clean.length - body.length} earlier characters cut)\n${body}`;
}

/** What the agent is told when the verify command fails. */
export function fixMessage(command: string): string {
  return `The verify command \`${command}\` failed. Fix it.`;
}

export function fixPromptForAgent(command: string, output: string): string {
  return `${fixMessage(command)}\n\nOutput (last part):\n\`\`\`\n${trimOutput(output)}\n\`\`\``;
}

/** The current (last) turn: its user message, and whether its tools changed files. */
export function lastTurn(items: ChatItem[]): { id?: string; auto: boolean; changed: boolean } {
  let i = items.length - 1;
  let changed = false;
  for (; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') break;
    if (it.kind === 'tool' && it.status !== 'error' && EDIT_TOOLS.test(it.name)) changed = true;
  }
  const u = i >= 0 ? items[i] : undefined;
  return { id: u?.id, auto: !!(u?.kind === 'user' && u.auto), changed };
}

/** Kills a command and what it started. */
function killTree(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
    else process.kill(-p.pid, 'SIGTERM');
  } catch {
    p.kill();
  }
}

const FOLDERS = 'steerhouse.verify.folders';
type Remembered = Record<string, { command?: string; declined?: boolean }>;

/** One per chat: runs the command after turns, keeps the results, sends the fixes. */
export class Verifier {
  private proc?: ChildProcess;
  private outputs = new Map<string, string>();
  private fixes = 0;
  private asking = false;

  constructor(
    private ctx: vscode.ExtensionContext,
    private chat: ChatSession,
    private repaint: () => void,
    prev?: Verifier,
  ) {
    const old = prev?.state;
    chat.state.verify = { enabled: old?.enabled, results: { ...old?.results }, command: this.configured() };
    if (prev) this.outputs = new Map(prev.outputs);
  }

  private get state(): VerifyState {
    return (this.chat.state.verify ??= { results: {} });
  }

  private cfg() {
    return vscode.workspace.getConfiguration('steerhouse.verify', vscode.Uri.file(this.chat.state.cwd));
  }

  /** The setting, else what you confirmed for this folder. */
  private configured(): string | undefined {
    const set = this.cfg().get<string>('command', '').trim();
    if (set) return set;
    return this.ctx.globalState.get<Remembered>(FOLDERS, {})[this.chat.state.cwd]?.command;
  }

  private remember(v: { command?: string; declined?: boolean }) {
    this.ctx.globalState.update(FOLDERS, { ...this.ctx.globalState.get<Remembered>(FOLDERS, {}), [this.chat.state.cwd]: v });
  }

  output(turn: string): string | undefined {
    return this.outputs.get(turn);
  }

  setEnabled(on: boolean) {
    this.state.enabled = on;
    if (!on) this.cancel();
    this.repaint();
  }

  /** A command detected from the project files, asked about once per folder. */
  private async propose(): Promise<string | undefined> {
    const known = this.ctx.globalState.get<Remembered>(FOLDERS, {})[this.chat.state.cwd];
    if (known?.declined || this.asking) return undefined;
    const guess = detectVerifyCommand(this.chat.state.cwd);
    if (!guess) return undefined;
    this.asking = true;
    try {
      const use = vscode.l10n.t('Use it');
      const edit = vscode.l10n.t('Edit…');
      const no = vscode.l10n.t('No');
      const pick = await vscode.window.showInformationMessage(vscode.l10n.t('Steerhouse: verify each turn that changes files by running `{0}` in {1}?', guess, path.basename(this.chat.state.cwd)), use, edit, no);
      let cmd: string | undefined;
      if (pick === use) cmd = guess;
      else if (pick === edit) cmd = (await vscode.window.showInputBox({ prompt: vscode.l10n.t('Verify command (runs in {0})', this.chat.state.cwd), value: guess }))?.trim() || undefined;
      if (pick === no) this.remember({ declined: true });
      else if (cmd) this.remember({ command: cmd });
      return cmd;
    } finally {
      this.asking = false;
    }
  }

  /** A turn ended (and nothing queued started the next one). */
  async turnEnded() {
    const s = this.chat.state;
    const turn = lastTurn(s.items);
    if (!turn.auto) this.fixes = 0;
    if (!turn.id || !turn.changed || this.state.enabled === false || s.status !== 'idle') return;
    let cmd = this.configured();
    if (!cmd) cmd = await this.propose();
    this.state.command = cmd;
    this.repaint();
    // still idle and still the same last turn (you may have typed meanwhile)
    if (!cmd || this.chat.state.status !== 'idle' || lastTurn(this.chat.state.items).id !== turn.id) return;
    this.run(turn.id, cmd);
  }

  private run(turn: string, command: string) {
    this.cancel();
    const started = Date.now();
    const timeoutSec = Math.max(1, this.cfg().get<number>('timeoutSec', 300));
    const p = spawn(command, { cwd: this.chat.state.cwd, shell: true, detached: process.platform !== 'win32', env: { ...process.env, CI: process.env.CI ?? '1', FORCE_COLOR: '0' } });
    this.proc = p;
    this.state.running = turn;
    delete this.state.results[turn];
    this.repaint();
    let out = '';
    const add = (b: Buffer) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    p.stdout?.on('data', add);
    p.stderr?.on('data', add);
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => ((timedOut = true), killTree(p)), timeoutSec * 1000);
    (p as any).cancel = () => ((cancelled = true), killTree(p));
    const done = (code: number | null, err?: Error) => {
      clearTimeout(timer);
      if (this.proc === p) this.proc = undefined;
      if (this.state.running === turn) this.state.running = undefined;
      if (err) out += `\n${err.message}`;
      if (timedOut) out += `\n${vscode.l10n.t('Timed out after {0}s.', timeoutSec)}`;
      const ok = code === 0 && !timedOut && !cancelled && !err;
      this.outputs.set(turn, trimOutput(out, 64_000));
      this.state.results[turn] = { ok, command, durationMs: Date.now() - started, exitCode: code, timedOut: timedOut || undefined, cancelled: cancelled || undefined };
      this.repaint();
      if (!ok && !cancelled) this.afterFailure(turn, command, out);
    };
    let finished = false;
    p.on('error', (e) => !finished && ((finished = true), done(null, e)));
    p.on('close', (code) => !finished && ((finished = true), done(code)));
  }

  private afterFailure(turn: string, command: string, out: string) {
    const s = this.chat.state;
    if (s.status !== 'idle' || lastTurn(s.items).id !== turn) return;
    const max = Math.max(0, this.cfg().get<number>('maxFixes', 2));
    if (this.fixes >= max) {
      if (max > 0) s.items.push({ kind: 'system', id: `verify-${Date.now()}`, text: vscode.l10n.t('Verify still fails after {0} automatic fix attempts; stopping. Check the output on the turn.', max), ts: new Date().toISOString() });
      this.repaint();
      return;
    }
    this.fixes++;
    this.chat.sendAuto(fixMessage(command), fixPromptForAgent(command, out));
  }

  /** Stop a run (you sent a message, stopped the agent, or turned verify off). */
  cancel() {
    const p = this.proc;
    if (!p) return;
    (p as any).cancel?.();
  }

  dispose() {
    this.cancel();
  }
}
