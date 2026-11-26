// Cursor Agent through its headless print mode: one `cursor-agent --print --output-format stream-json
// --stream-partial-output` process per user message, the chat id from the first run's system/init
// event passed as --resume to the next one. Stop kills the process. Print mode cannot ask for
// approval, so Steerhouse never passes --force: Cursor applies edits, and commands it would ask
// about are refused (the chat says so when it starts).
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as path from 'path';
import { EventQueue, type AgentRuntime, type Decision, type RuntimeEvent, type RuntimeSession, type RuntimeStartOptions, type ToolKind } from './types';
import { parseHunks } from './codex';

const LOGIN = 'Log in with `cursor-agent login`';
export const CURSOR_APPROVAL_NOTE = "Cursor's CLI cannot ask for approval in a chat: it edits files directly, and commands it would ask about are refused (Steerhouse does not pass --force).";

const needsLogin = (s: string) => /not logged in|login|unauthori[sz]ed|401|api key/i.test(s);

/** a tool_call payload ({ shellToolCall: { args, result } }) → its name and body */
function toolOf(tc: any): { key: string; args: any; result: any } {
  const key = Object.keys(tc ?? {})[0] ?? 'tool';
  const v = tc?.[key] ?? {};
  return { key, args: v.args ?? (key === 'function' ? safeJson(v.arguments) : {}) ?? {}, result: v.result };
}
const safeJson = (s: unknown) => {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return { arguments: s };
  }
};

function describe(key: string, a: any, raw: any): { name: string; kind: ToolKind; summary: string; input: unknown } {
  const p = a.path ?? a.filePath ?? a.file_path;
  switch (key) {
    case 'shellToolCall':
      return { name: 'Bash', kind: 'run', summary: a.command ?? '', input: { command: a.command, cwd: a.workingDirectory ?? a.cwd } };
    case 'readToolCall':
      return { name: 'Read', kind: 'read', summary: p ?? '', input: { file_path: p } };
    case 'editToolCall':
    case 'writeToolCall':
    case 'deleteToolCall':
      return { name: key === 'writeToolCall' ? 'Write' : 'Edit', kind: 'edit', summary: p ? path.basename(p) : '', input: { file_path: p } };
    case 'grepToolCall':
      return { name: 'Grep', kind: 'search', summary: a.pattern ?? '', input: { pattern: a.pattern, path: a.path } };
    case 'globToolCall':
    case 'lsToolCall':
      return { name: key === 'lsToolCall' ? 'LS' : 'Glob', kind: 'search', summary: a.globPattern ?? a.pattern ?? p ?? '', input: { pattern: a.globPattern ?? a.pattern, path: p } };
    case 'webSearchToolCall':
      return { name: 'WebSearch', kind: 'browser', summary: a.query ?? a.searchTerm ?? '', input: { query: a.query ?? a.searchTerm } };
    case 'mcpToolCall':
      return { name: `mcp__${a.providerIdentifier ?? a.server ?? 'mcp'}__${a.toolName ?? a.name ?? 'tool'}`, kind: 'mcp', summary: a.toolName ?? a.name ?? '', input: a.args ?? a };
    case 'function':
      return { name: raw?.function?.name ?? 'tool', kind: 'other', summary: raw?.function?.name ?? '', input: a };
    default:
      return { name: key.replace(/ToolCall$/, ''), kind: 'other', summary: key.replace(/ToolCall$/, ''), input: a };
  }
}

const todoStatus = (s: string) => (/progress/i.test(s) ? 'in_progress' : /complete|done/i.test(s) ? 'completed' : 'pending') as 'pending' | 'in_progress' | 'completed';

export class CursorSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>();
  private chatId?: string;
  private child?: ChildProcess;
  private running?: Promise<void>;
  private killed = false;
  private closed = false;
  private turn = 0;
  /** unique ids for text blocks: two in the same millisecond must not share one */
  private seq = 0;
  private textId?: string;
  private text = '';
  private thinkId?: string;
  private models?: Promise<{ value: string; displayName: string }[]>;

  constructor(private opts: RuntimeStartOptions & { exe: string }) {
    this.chatId = opts.resume;
    queueMicrotask(() => {
      if (opts.resume) this.events.push({ type: 'sessionId', id: opts.resume });
      if (opts.model) this.events.push({ type: 'model', model: opts.model });
      this.events.push({ type: 'notice', key: 'cursor-approvals', text: CURSOR_APPROVAL_NOTE });
      this.events.push({ type: 'status', status: 'idle' });
    });
  }

  private spawnArgs(args: string[]): [string, string[]] {
    const exe = this.opts.exe;
    return /\.c?js$/i.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
  }

  async send(text: string, _images: string[], files: string[]) {
    // RuntimeChat queues while working (steer: false); the last run may still be exiting after its result
    await this.running;
    const prompt = files.length ? `${text}\n\n${files.map((f) => `@${f}`).join('\n')}` : text;
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--trust', ...(this.chatId ? ['--resume', this.chatId] : []), ...(this.opts.model ? ['--model', this.opts.model] : []), prompt];
    const [cmd, argv] = this.spawnArgs(args);
    this.turn++;
    this.killed = false;
    this.textId = undefined;
    this.thinkId = undefined;
    this.text = '';
    this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
    const child = spawn(cmd, argv, { cwd: this.opts.cwd, env: { ...process.env, ...(this.opts.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buf = '';
    let stderr = '';
    let ended = false;
    const end = (e: Extract<RuntimeEvent, { type: 'turnEnd' }>) => {
      if (ended) return;
      ended = true;
      this.closeText();
      this.events.push(e);
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.line(line, end);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => (stderr = (stderr + d).slice(-4000)));
    this.running = new Promise<void>((resolve) => {
      const done = (code: number | null, why?: string) => {
        if (this.child === child) this.child = undefined;
        if (this.closed) return resolve();
        if (this.killed) end({ type: 'turnEnd', interrupted: true });
        else if (!ended) {
          const msg = why ?? (stderr.trim().split('\n').slice(-3).join(' ') || `cursor-agent exited (${code})`);
          end({ type: 'turnEnd', error: needsLogin(msg) ? `${msg}. ${LOGIN}.` : msg });
        }
        resolve();
      };
      child.on('error', (e) => done(null, String(e.message)));
      child.on('close', (code) => done(code));
    });
    await this.running;
  }

  private closeText() {
    if (this.textId) this.events.push({ type: 'textDone', id: this.textId, text: this.text });
    if (this.thinkId) this.events.push({ type: 'thinkingDone', id: this.thinkId });
    this.textId = this.thinkId = undefined;
    this.text = '';
  }

  private line(line: string, end: (e: Extract<RuntimeEvent, { type: 'turnEnd' }>) => void) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id && m.session_id !== this.chatId) {
            this.chatId = m.session_id;
            this.events.push({ type: 'sessionId', id: m.session_id });
          }
          if (m.model) this.events.push({ type: 'model', model: m.model });
        }
        return;
      case 'thinking':
        if (m.subtype === 'delta' && m.text) {
          this.thinkId ??= `think-${this.turn}-${++this.seq}`;
          this.events.push({ type: 'thinkingDelta', id: this.thinkId, delta: m.text });
        } else if (m.subtype === 'completed' && this.thinkId) {
          this.events.push({ type: 'thinkingDone', id: this.thinkId });
          this.thinkId = undefined;
        }
        return;
      case 'assistant': {
        const t = (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('');
        if (!t) return;
        // with --stream-partial-output the deltas carry timestamp_ms; the full message that follows does not
        if (m.timestamp_ms === undefined && this.textId && t === this.text) return;
        if (this.thinkId) {
          this.events.push({ type: 'thinkingDone', id: this.thinkId });
          this.thinkId = undefined;
        }
        this.textId ??= `text-${this.turn}-${++this.seq}`;
        this.text += t;
        this.events.push({ type: 'textDelta', id: this.textId, delta: t });
        return;
      }
      case 'tool_call': {
        const id = `${this.turn}:${m.call_id ?? Date.now()}`;
        const { key, args, result } = toolOf(m.tool_call);
        if (m.subtype === 'started') {
          this.closeText();
          if (key === 'updateTodosToolCall' || key === 'todoToolCall') {
            const todos = (args.todos ?? []).map((t: any) => ({ content: t.content ?? '', activeForm: t.content ?? '', status: todoStatus(String(t.status ?? '')) }));
            this.events.push({ type: 'todos', todos });
          }
          const d = describe(key, args, m.tool_call);
          this.events.push({ type: 'toolStart', id, ...d });
        } else if (m.subtype === 'completed') {
          const ok = result?.success;
          const err = result?.error ?? result?.failure ?? (result?.rejected ? { message: 'Rejected (Cursor would have asked for approval)' } : undefined);
          const out = ok
            ? [ok.stdout ?? ok.output ?? ok.content ?? '', ok.stderr ?? ''].filter(Boolean).join('\n') || (typeof ok === 'object' ? (ok.path ?? ok.message ?? '') : String(ok))
            : String(err?.message ?? err?.errorMessage ?? (err ? JSON.stringify(err) : ''));
          const diff = ok?.diffString ?? ok?.diff;
          const exit = ok?.exitCode ?? 0;
          this.events.push({ type: 'toolEnd', id, status: !ok || exit !== 0 ? 'error' : 'done', result: out, ...(typeof diff === 'string' ? { patch: parseHunks(diff) } : {}), file: args.path });
        }
        return;
      }
      case 'result': {
        const u = m.usage;
        const usage = u ? { input: u.inputTokens ?? u.input_tokens ?? 0, output: u.outputTokens ?? u.output_tokens ?? 0, total: (u.inputTokens ?? u.input_tokens ?? 0) + (u.outputTokens ?? u.output_tokens ?? 0) } : undefined;
        if (!this.textId && !this.text && typeof m.result === 'string' && m.result && m.subtype === 'success') {
          this.textId = `text-${this.turn}-r`;
          this.text = m.result;
        }
        const error = m.is_error || (m.subtype && m.subtype !== 'success') ? String(m.result || m.error || 'The turn failed') : undefined;
        end({ type: 'turnEnd', usage, error: error && needsLogin(error) ? `${error}. ${LOGIN}.` : error });
        return;
      }
    }
  }

  async interrupt() {
    if (!this.child) return;
    this.killed = true;
    this.child.kill('SIGTERM');
    const c = this.child;
    setTimeout(() => c.exitCode === null && c.signalCode === null && c.kill('SIGKILL'), 2000).unref?.();
  }

  respond(_id: string, _d: Decision) {}

  async setModel(model: string) {
    this.opts.model = model; // the next run passes --model
  }

  listModels() {
    this.models ??= new Promise((res) => {
      const [cmd, argv] = this.spawnArgs(['--list-models']);
      const c = execFile(cmd, argv, { timeout: 15000, env: { ...process.env, ...(this.opts.env ?? {}) }, windowsHide: true }, (_e, so) => res(parseModels(String(so ?? ''))));
      c.on('error', () => res([]));
    });
    return this.models;
  }

  close() {
    this.closed = true;
    this.child?.kill('SIGKILL');
    this.events.end();
  }
}

/** `--list-models` lines ("composer-2.5 - Composer 2.5 (current)") → models */
export function parseModels(out: string) {
  return out
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => /^\s*([\w.\-\[\]=,]+)\s+-\s+(.+?)\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ value: m[1], displayName: m[2].replace(/\s*\((current|default)\)\s*$/i, '') }));
}

function run(exe: string, args: string[], env?: Record<string, string | undefined>): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const c = execFile(exe, args, { timeout: 8000, windowsHide: true, env: { ...process.env, ...(env ?? {}) } }, (e, so, se) => res({ ok: !e, out: `${so}${se}`.trim() }));
    c.on('error', () => res({ ok: false, out: '' }));
  });
}

export function cursorRuntime(find: () => string | undefined): AgentRuntime {
  return {
    id: 'cursor',
    label: 'Cursor Agent',
    vendor: 'cursor',
    caps: { steer: false, fork: false, rewind: false, thinking: true, todos: true, subagents: false, approvals: false, images: false, effort: false, permissionModes: false },
    async detect() {
      const exe = find();
      if (!exe) return { authed: false, loginHint: 'Install Cursor Agent: https://cursor.com/cli' };
      const v = await run(exe, ['--version']);
      const st = await run(exe, ['status']);
      return { exe, version: v.out || undefined, authed: st.ok && !/not logged in/i.test(st.out), loginHint: 'cursor-agent login' };
    },
    start: (opts) => new CursorSession({ ...opts, exe: opts.executable ?? find() ?? 'cursor-agent' }),
  };
}
