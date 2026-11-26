// Agents that speak the Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0 over
// stdio, one message per line. Gemini CLI (`gemini --acp`), Kiro (`kiro-cli acp`), GitHub Copilot CLI
// (`copilot --acp --stdio`), Grok (`grok agent stdio`) and any command the user lists in
// steerhouse.acpAgents. Flow (protocol v1): initialize → session/new (or session/load when the agent
// advertises loadSession) → session/prompt, streamed back as session/update notifications; the agent
// asks with session/request_permission and reads / writes files with fs/read_text_file and
// fs/write_text_file; Stop is the session/cancel notification. Launch arguments follow t3code's
// provider-kiro / provider-grok / provider-acp-registry.
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Hunk, Todo } from '../chat';
import { EventQueue, type AgentRuntime, type Decision, type RuntimeEvent, type RuntimeSession, type RuntimeStartOptions, type ToolKind } from './types';

export interface AcpAgentDef {
  id: string;
  label: string;
  vendor: string;
  /** executables to look for (first found wins), or the configured command */
  bins: string[];
  args: string[];
  /** what to run in a terminal to sign in */
  login: string;
}

export const ACP_AGENTS: AcpAgentDef[] = [
  { id: 'gemini', label: 'Gemini CLI', vendor: 'google', bins: ['gemini'], args: ['--acp'], login: 'gemini' },
  { id: 'kiro', label: 'Kiro', vendor: 'other', bins: ['kiro-cli'], args: ['acp'], login: 'kiro-cli login' },
  { id: 'copilot', label: 'GitHub Copilot CLI', vendor: 'other', bins: ['copilot'], args: ['--acp', '--stdio'], login: 'copilot' },
  { id: 'grok', label: 'Grok', vendor: 'xai', bins: ['grok'], args: ['agent', 'stdio'], login: 'grok login' },
];

/** steerhouse.acpAgents entries → definitions (ids prefixed so they never shadow a built-in one). */
export function customAcpAgents(list: unknown): AcpAgentDef[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a.command === 'string' && a.command.trim())
    .map((a, i) => ({
      id: `acp:${String(a.id ?? i)}`,
      label: String(a.label ?? a.id ?? a.command),
      vendor: 'other',
      bins: [a.command],
      args: Array.isArray(a.args) ? a.args.map(String) : [],
      login: a.command,
    }));
}

// ---------------------------------------------------------------- diffs

/** old text → new text as hunks (line LCS, 3 lines of context; big files: one replace hunk). */
export function textHunks(oldText: string | null | undefined, newText: string): Hunk[] {
  const split = (s: string) => (s ? s.replace(/\n$/, '').split('\n') : []);
  const a = split(oldText ?? '');
  const b = split(newText);
  if (a.length * b.length > 4_000_000) return [{ oldStart: a.length ? 1 : 0, oldLines: a.length, newStart: b.length ? 1 : 0, newLines: b.length, lines: [...a.map((l) => '-' + l), ...b.map((l) => '+' + l)] }];
  // trim the common head and tail, LCS on the middle
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  type Op = { t: ' ' | '-' | '+'; s: string };
  const ops: Op[] = a.slice(0, pre).map((s) => ({ t: ' ' as const, s }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) (ops.push({ t: ' ', s: A[i] }), i++, j++);
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) ops.push({ t: '-', s: A[i++] });
    else ops.push({ t: '+', s: B[j++] });
  }
  for (const s of a.slice(a.length - suf)) ops.push({ t: ' ', s });
  // group changes with 3 lines of context
  const out: Hunk[] = [];
  const C = 3;
  let k = 0;
  let oldNo = 1;
  let newNo = 1;
  const pos: { o: number; n: number }[] = ops.map((op) => {
    const p = { o: oldNo, n: newNo };
    if (op.t !== '+') oldNo++;
    if (op.t !== '-') newNo++;
    return p;
  });
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    let start = Math.max(0, k - C);
    let end = k;
    // extend while the next change is within 2*C context lines
    for (;;) {
      while (end < ops.length && ops[end].t !== ' ') end++;
      let gap = end;
      while (gap < ops.length && ops[gap].t === ' ' && gap - end < 2 * C) gap++;
      if (gap < ops.length && ops[gap].t !== ' ') end = gap;
      else break;
    }
    const stop = Math.min(ops.length, end + C);
    const slice = ops.slice(start, stop);
    const oldLines = slice.filter((o) => o.t !== '+').length;
    const newLines = slice.filter((o) => o.t !== '-').length;
    out.push({ oldStart: oldLines ? pos[start].o : pos[start].o - 1, oldLines, newStart: newLines ? pos[start].n : pos[start].n - 1, newLines, lines: slice.map((o) => o.t + o.s) });
    k = stop;
    start = stop;
  }
  return out;
}

// ---------------------------------------------------------------- JSON-RPC 2.0

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class Rpc {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  stderr = '';
  exited?: string;
  constructor(
    readonly child: ChildProcess,
    name: string,
    private onNotify: (method: string, params: any) => void,
    private onRequest: (id: number | string, method: string, params: any) => void,
    private onExit: (why: string) => void,
  ) {
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.line(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
    child.stdin!.on('error', () => {});
    const exit = (why: string) => {
      if (this.exited) return;
      this.exited = why;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.onExit(why);
    };
    child.on('error', (e) => exit(String(e.message)));
    child.on('exit', (code, sig) => exit(`${name} exited (${sig ?? code})${this.stderr ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' ') : ''}`));
  }
  private line(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // agents may log to stdout
    }
    if (m.method && m.id !== undefined && m.id !== null) return this.onRequest(m.id, m.method, m.params);
    if (m.method) return this.onNotify(m.method, m.params);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error.message ?? 'error'), { code: m.error.code, data: m.error.data }));
    else p.resolve(m.result);
  }
  private write(o: object) {
    if (!this.exited) this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  }
  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error(this.exited));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method: string, params?: unknown) {
    this.write({ method, params });
  }
  reply(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  replyError(id: number | string, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }
}

const isAuthError = (e: any) => e?.code === -32000 || /auth|log ?in|sign ?in|logged in|401|unauthori[sz]ed|api key|credential/i.test(String(e?.message ?? e));

const TOOL: Record<string, { name: string; kind: ToolKind }> = {
  execute: { name: 'Bash', kind: 'run' },
  edit: { name: 'Edit', kind: 'edit' },
  delete: { name: 'Edit', kind: 'edit' },
  move: { name: 'Edit', kind: 'edit' },
  read: { name: 'Read', kind: 'read' },
  search: { name: 'Grep', kind: 'search' },
  fetch: { name: 'WebFetch', kind: 'browser' },
};

/** One ACP session. */
export class AcpSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>();
  private rpc: Rpc;
  private ready: Promise<void>;
  private sessionId?: string;
  private closed = false;
  private loading = false;
  private canImage = false;
  private authMsg?: string;
  /** permission requests waiting for the user: our id → JSON-RPC id and the agent's options */
  private asks = new Map<string, { rpcId: number | string; options: { optionId: string; kind: string }[] }>();
  private tools = new Map<string, { title: string; kind?: string; started: boolean; out: string; patch: Hunk[]; file?: string; rawInput?: unknown }>();
  private models: { value: string; displayName: string }[] = [];
  /** how the model is set: session/set_model (unstable) or a "model" config option */
  private modelVia?: { kind: 'setModel' } | { kind: 'config'; configId: string };
  private turn = 0;
  private seg = 0;
  /** the stream the last chunk went to, so a new one starts a new item */
  private cur?: { kind: 'text' | 'thought'; id: string };

  constructor(
    private def: AcpAgentDef,
    private opts: RuntimeStartOptions,
  ) {
    const exe = opts.executable ?? def.bins[0];
    const isScript = /\.c?js$/i.test(exe);
    const child = spawn(isScript ? process.execPath : exe, isScript ? [exe, ...def.args] : def.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
    });
    this.rpc = new Rpc(
      child,
      def.label,
      (m, p) => this.notification(m, p),
      (id, m, p) => void this.request(id, m, p),
      (why) => {
        if (!this.closed) this.events.push({ type: 'status', status: 'error', error: isAuthError(why) ? `${why}. ${this.loginText()}` : why });
        this.events.end();
      },
    );
    this.ready = this.boot();
    this.ready.catch((e) => {
      if (isAuthError(e)) {
        this.authMsg = this.loginText();
        this.events.push({ type: 'notice', text: this.authMsg });
        this.events.push({ type: 'status', status: 'idle' });
      } else this.events.push({ type: 'status', status: 'error', error: String(e?.message ?? e) });
    });
  }

  private loginText() {
    return `${this.def.label} is not signed in. Run \`${this.def.login}\` once in a terminal to sign in, then send your message again.`;
  }

  private async boot() {
    const timeout = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.def.label} did not answer`)), 30000);
      t.unref?.();
    });
    const init = await Promise.race([
      this.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'steerhouse', title: 'Steerhouse', version: '1' },
      }),
      timeout,
    ]);
    const caps = init?.agentCapabilities ?? {};
    this.canImage = !!caps.promptCapabilities?.image;
    const base = { cwd: this.opts.cwd, mcpServers: [] };
    let r: any;
    if (this.opts.resume && caps.loadSession) {
      // the agent replays the conversation as session/update: the chat already shows it
      this.loading = true;
      try {
        r = await Promise.race([this.rpc.request('session/load', { sessionId: this.opts.resume, ...base }), timeout]);
        this.sessionId = this.opts.resume;
      } finally {
        this.loading = false;
      }
    } else {
      if (this.opts.resume) this.events.push({ type: 'notice', text: `${this.def.label} cannot reopen earlier sessions: this is a new one.` });
      r = await Promise.race([this.rpc.request('session/new', base), timeout]);
      this.sessionId = r?.sessionId;
    }
    if (this.sessionId) this.events.push({ type: 'sessionId', id: this.sessionId });
    this.readModels(r);
    this.events.push({ type: 'status', status: 'idle' });
  }

  /** session/new|load answers: `models` (unstable) or a config option of category "model". */
  private readModels(r: any) {
    const m = r?.models;
    if (Array.isArray(m?.availableModels) && m.availableModels.length) {
      this.models = m.availableModels.map((x: any) => ({ value: String(x.modelId), displayName: String(x.name ?? x.modelId) }));
      this.modelVia = { kind: 'setModel' };
      const cur = this.opts.model && this.models.some((x) => x.value === this.opts.model) ? undefined : m.currentModelId;
      if (cur) this.events.push({ type: 'model', model: String(cur) });
      else if (this.opts.model) void this.setModel(this.opts.model).catch(() => {});
      return;
    }
    const opt = (r?.configOptions ?? []).find((o: any) => o?.category === 'model' && Array.isArray(o.options));
    if (opt) {
      const flat = opt.options.flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o]));
      this.models = flat.map((x: any) => ({ value: String(x.value), displayName: String(x.name ?? x.value) }));
      this.modelVia = { kind: 'config', configId: opt.id };
      if (opt.currentValue) this.events.push({ type: 'model', model: String(opt.currentValue) });
    }
  }

  async send(text: string, images: string[], files: string[]) {
    try {
      await this.ready;
    } catch {}
    if (!this.sessionId) return this.events.push({ type: 'turnEnd', error: this.authMsg ?? `${this.def.label} has no session` });
    this.turn++;
    this.cur = undefined;
    // agents may reuse tool call ids from turn to turn
    this.tools.clear();
    this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
    const prompt: any[] = [];
    if (text) prompt.push({ type: 'text', text });
    for (const p of images) {
      if (!this.canImage) {
        prompt.push({ type: 'resource_link', uri: 'file://' + p, name: path.basename(p) });
        continue;
      }
      const ext = path.extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png';
      try {
        prompt.push({ type: 'image', mimeType: `image/${ext}`, data: fs.readFileSync(p).toString('base64') });
      } catch {}
    }
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.join(this.opts.cwd, f);
      prompt.push({ type: 'resource_link', uri: 'file://' + abs, name: path.basename(f) });
    }
    try {
      const r = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt });
      this.endStream();
      const why = r?.stopReason;
      this.events.push({ type: 'turnEnd', interrupted: why === 'cancelled', error: why === 'refusal' ? `${this.def.label} refused to continue` : why === 'max_tokens' || why === 'max_turn_requests' ? `${this.def.label} stopped: ${why}` : undefined });
    } catch (e: any) {
      this.endStream();
      this.events.push({ type: 'turnEnd', error: isAuthError(e) ? `${e.message}. ${this.loginText()}` : String(e?.message ?? e) });
    }
  }

  async interrupt() {
    await this.ready.catch(() => {});
    for (const [rid, a] of this.asks) {
      this.asks.delete(rid);
      this.rpc.reply(a.rpcId, { outcome: { outcome: 'cancelled' } });
    }
    if (this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId });
  }

  async setModel(model: string) {
    this.opts.model = model;
    await this.ready.catch(() => {});
    if (!this.sessionId || !this.modelVia) return;
    if (this.modelVia.kind === 'setModel') await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model });
    else await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modelVia.configId, value: model });
  }

  async listModels() {
    await this.ready.catch(() => {});
    return this.models;
  }

  respond(requestId: string, decision: Decision) {
    const a = this.asks.get(requestId);
    if (!a) return;
    this.asks.delete(requestId);
    const want = decision === 'allow' ? ['allow_once', 'allow_always'] : decision === 'allowAlways' ? ['allow_always', 'allow_once'] : ['reject_once', 'reject_always'];
    const opt = want.map((k) => a.options.find((o) => o.kind === k)).find(Boolean);
    this.rpc.reply(a.rpcId, opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  close() {
    this.closed = true;
    this.events.end();
    try {
      this.rpc.child.kill();
    } catch {}
  }

  // ---------------------------------------------------------------- agent → client

  private inside(p: string) {
    return path.isAbsolute(p) ? p : path.join(this.opts.cwd, p);
  }

  private async request(id: number | string, method: string, p: any) {
    try {
      if (method === 'session/request_permission') {
        const tc = p?.toolCall ?? {};
        const known = this.tools.get(tc.toolCallId);
        const kind = tc.kind ?? known?.kind;
        const t = TOOL[kind] ?? { name: tc.title ?? known?.title ?? 'Tool', kind: 'other' };
        const rid = `ask-${id}`;
        const options = (p?.options ?? []).map((o: any) => ({ optionId: String(o.optionId), kind: String(o.kind) }));
        this.asks.set(rid, { rpcId: id, options });
        const input = tc.rawInput ?? known?.rawInput ?? {};
        const file = tc.locations?.[0]?.path;
        this.events.push({ type: 'permission', requestId: rid, tool: t.name, summary: tc.title ?? known?.title ?? t.name, input: { ...(typeof input === 'object' && input ? input : { value: input }), ...(file ? { file_path: file } : {}) }, canAlways: options.some((o: any) => o.kind === 'allow_always') });
        return;
      }
      if (method === 'fs/read_text_file') {
        let text = fs.readFileSync(this.inside(p.path), 'utf8');
        if (p.line || p.limit) {
          const lines = text.split('\n');
          const from = Math.max(0, (p.line ?? 1) - 1);
          text = lines.slice(from, p.limit ? from + p.limit : undefined).join('\n');
        }
        return this.rpc.reply(id, { content: text });
      }
      if (method === 'fs/write_text_file') {
        const f = this.inside(p.path);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, p.content ?? '');
        return this.rpc.reply(id, null);
      }
      this.rpc.replyError(id, -32601, `Steerhouse does not handle ${method}`);
    } catch (e: any) {
      this.rpc.replyError(id, -32603, String(e?.message ?? e));
    }
  }

  private endStream() {
    if (this.cur?.kind === 'thought') this.events.push({ type: 'thinkingDone', id: this.cur.id });
    if (this.cur?.kind === 'text') this.events.push({ type: 'textDone', id: this.cur.id });
    this.cur = undefined;
  }

  private chunk(kind: 'text' | 'thought', c: any) {
    const text = c?.type === 'text' ? String(c.text ?? '') : '';
    if (!text) return;
    if (this.cur?.kind !== kind) {
      this.endStream();
      this.cur = { kind, id: `${kind}-${this.turn}-${++this.seg}` };
    }
    this.events.push(kind === 'text' ? { type: 'textDelta', id: this.cur.id, delta: text } : { type: 'thinkingDelta', id: this.cur.id, delta: text });
  }

  private toolContent(t: { out: string; patch: Hunk[]; file?: string }, content: any[] | undefined) {
    if (!Array.isArray(content)) return;
    let out = '';
    const patch: Hunk[] = [];
    for (const c of content) {
      if (c?.type === 'content' && c.content?.type === 'text') out += (out ? '\n' : '') + c.content.text;
      else if (c?.type === 'diff') {
        patch.push(...textHunks(c.oldText, c.newText ?? ''));
        t.file ??= c.path;
      }
    }
    if (out) t.out = out;
    if (patch.length) t.patch = patch;
  }

  private toolCall(u: any) {
    const key = String(u.toolCallId);
    const id = `${this.turn}-${key}`;
    let t = this.tools.get(key);
    if (!t) this.tools.set(key, (t = { title: u.title ?? 'Tool', kind: u.kind, started: false, out: '', patch: [] }));
    if (u.title) t.title = u.title;
    if (u.kind) t.kind = u.kind;
    if (u.rawInput !== undefined) t.rawInput = u.rawInput;
    if (u.locations?.[0]?.path) t.file ??= u.locations[0].path;
    this.toolContent(t, u.content);
    if (!t.started) {
      t.started = true;
      this.endStream();
      const m = TOOL[t.kind ?? ''] ?? { name: t.title, kind: 'other' as ToolKind };
      const raw = (t.rawInput && typeof t.rawInput === 'object' ? t.rawInput : {}) as Record<string, unknown>;
      const input = m.kind === 'run' ? { command: raw.command ?? t.title, ...raw } : { ...raw, ...(t.file ? { file_path: t.file } : {}) };
      this.events.push({ type: 'toolStart', id, name: m.name, kind: m.kind, summary: t.title, input });
    }
    if (u.status === 'completed' || u.status === 'failed') {
      this.events.push({ type: 'toolEnd', id, status: u.status === 'failed' ? 'error' : 'done', result: t.out, patch: t.patch.length ? t.patch : undefined, file: t.file });
    }
  }

  private notification(method: string, p: any) {
    if (method !== 'session/update' || this.loading) return;
    const u = p?.update ?? {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return this.chunk('text', u.content);
      case 'agent_thought_chunk':
        return this.chunk('thought', u.content);
      case 'tool_call':
      case 'tool_call_update':
        return this.toolCall(u);
      case 'plan':
        return this.events.push({
          type: 'todos',
          todos: (u.entries ?? []).map((e: any): Todo => ({ content: e.content, activeForm: e.content, status: e.status === 'in_progress' ? 'in_progress' : e.status === 'completed' ? 'completed' : 'pending' })),
        });
      case 'available_commands_update':
        return this.events.push({ type: 'commands', names: (u.availableCommands ?? []).map((c: any) => String(c.name)) });
      case 'current_mode_update':
        return this.events.push({ type: 'notice', key: 'acp-mode', text: `Mode: ${u.currentModeId}` });
    }
  }
}

function run(exe: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const c = execFile(exe, args, { timeout: 8000, windowsHide: true }, (e, so, se) => res({ ok: !e, out: `${so}${se}`.trim() }));
    c.on('error', () => res({ ok: false, out: '' }));
  });
}

export function acpRuntime(def: AcpAgentDef, find: () => string | undefined): AgentRuntime {
  return {
    id: def.id,
    label: def.label,
    vendor: def.vendor,
    caps: { steer: false, fork: false, rewind: false, thinking: true, todos: true, subagents: false, approvals: true, images: true, effort: false, permissionModes: false },
    async detect() {
      const exe = find();
      if (!exe) return { authed: false, loginHint: def.login };
      const v = await run(exe, ['--version']);
      // ACP has no "am I signed in" call outside a session: session/new says so when it is not
      return { exe, version: v.ok ? v.out.split('\n')[0] : undefined, authed: true, loginHint: def.login };
    },
    start: (opts) => new AcpSession(def, { ...opts, executable: opts.executable ?? find() ?? def.bins[0] }),
  };
}
