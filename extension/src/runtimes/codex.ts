// Codex through `codex app-server`: JSON-RPC 2.0 over stdio, one JSON object per line (the wire
// leaves out the "jsonrpc" field). Method and field names follow the schema the installed codex
// prints with `codex app-server generate-ts` (v2 protocol): initialize → initialized, thread/start
// or thread/resume, turn/start, turn/steer, turn/interrupt; item/* and turn/* notifications; the
// server asks for approvals with item/commandExecution/requestApproval and
// item/fileChange/requestApproval.
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { Hunk } from '../chat';
import { EventQueue, type AgentRuntime, type Decision, type RuntimeEvent, type RuntimeSession, type RuntimeStartOptions, type ToolKind } from './types';

const LOGIN = 'Log in with `codex login`';

/** Unified diff → hunks (the "@@ -a,b +c,d @@" blocks). */
export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | undefined;
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      cur = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      out.push(cur);
    } else if (cur && /^[ +\-\\]/.test(line) && !/^(\+\+\+|---) /.test(line)) cur.lines.push(line);
  }
  return out;
}

/** A diff without @@ headers (Codex sends a new file's whole content): one added hunk. */
function hunksOf(diff: string, kind?: string): Hunk[] {
  const h = parseHunks(diff);
  if (h.length || !diff) return h;
  const lines = diff.replace(/\n$/, '').split('\n');
  return kind === 'delete' ? [{ oldStart: 1, oldLines: lines.length, newStart: 0, newLines: 0, lines: lines.map((l) => '-' + l) }] : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }];
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** JSON-RPC over a child's stdio. */
class Rpc {
  private next = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  stderr = '';
  exited?: string;
  constructor(
    private child: ChildProcess,
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
    const exit = (why: string) => {
      if (this.exited) return;
      this.exited = why;
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.onExit(why);
    };
    child.on('error', (e) => exit(String(e.message)));
    child.on('exit', (code, sig) => exit(`codex app-server exited (${sig ?? code})${this.stderr ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' ') : ''}`));
  }
  private line(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.method && m.id !== undefined) return this.onRequest(m.id, m.method, m.params);
    if (m.method) return this.onNotify(m.method, m.params);
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error.message ?? 'error'), { code: m.error.code, data: m.error.data }));
    else p.resolve(m.result);
  }
  private write(o: unknown) {
    if (!this.exited) this.child.stdin!.write(JSON.stringify(o) + '\n');
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
    this.write(params === undefined ? { method } : { method, params });
  }
  reply(id: number | string, result: unknown) {
    this.write({ id, result });
  }
  replyError(id: number | string, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }
}

const needsLogin = (e: any) => /auth|login|logged in|401|unauthori[sz]ed|api key/i.test(String(e?.message ?? e));

/** One Codex thread driven over app-server. */
export class CodexSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>();
  private rpc: Rpc;
  private ready: Promise<void>;
  private threadId?: string;
  private turnId?: string;
  /** approval requests waiting for the user: our id → JSON-RPC id and kind */
  private asks = new Map<string, { rpcId: number | string; kind: 'command' | 'file' | 'input'; ids?: string[]; texts?: string[] }>();
  /** item ids already reported as tools / text */
  private kinds = new Map<string, string>();
  private closed = false;

  constructor(private opts: RuntimeStartOptions) {
    const exe = opts.executable ?? 'codex';
    const isScript = /\.c?js$/i.test(exe);
    const child = spawn(isScript ? process.execPath : exe, isScript ? [exe, 'app-server'] : ['app-server'], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'steerhouse' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.rpc = new Rpc(
      child,
      (m, p) => this.notification(m, p),
      (id, m, p) => this.request(id, m, p),
      (why) => {
        if (!this.closed) this.events.push({ type: 'status', status: 'error', error: needsLogin(why) ? `${why}. ${LOGIN}.` : why });
        this.events.end();
      },
    );
    this.ready = this.boot();
    this.ready.catch((e) => {
      this.events.push({ type: 'status', status: 'error', error: needsLogin(e) ? `${e.message}. ${LOGIN}.` : String(e?.message ?? e) });
    });
  }

  private async boot() {
    // nothing answers within 20 s: say so instead of hanging
    const timeout = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error('codex app-server did not answer')), 20000);
      t.unref?.();
    });
    await Promise.race([this.rpc.request('initialize', { clientInfo: { name: 'steerhouse', title: 'Steerhouse', version: '1' }, capabilities: { experimentalApi: true } }), timeout]);
    this.rpc.notify('initialized');
    // not logged in: tell the user before they type (the turn would fail anyway)
    const acct = await this.rpc.request('account/read', {}).catch(() => undefined);
    if (acct && !acct.account && acct.requiresOpenaiAuth) this.events.push({ type: 'notice', text: `Codex is not logged in. ${LOGIN} in a terminal, then send your message again.` });
    const common = { cwd: this.opts.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(this.opts.model ? { model: this.opts.model } : {}) };
    const r = this.opts.resume ? await this.rpc.request('thread/resume', { threadId: this.opts.resume, ...common }) : await this.rpc.request('thread/start', common);
    this.threadId = r?.thread?.id;
    if (this.threadId) this.events.push({ type: 'sessionId', id: this.threadId });
    if (r?.model) this.events.push({ type: 'model', model: r.model });
    this.events.push({ type: 'status', status: 'idle' });
  }

  private input(text: string, images: string[], files: string[] = []) {
    const body = files.length ? `${text}\n\n${files.map((f) => `@${f}`).join('\n')}` : text;
    return [...(body ? [{ type: 'text', text: body, text_elements: [] }] : []), ...images.map((p) => ({ type: 'localImage', path: p }))];
  }

  async send(text: string, images: string[], files: string[]) {
    await this.ready;
    this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
    try {
      const r = await this.rpc.request('turn/start', { threadId: this.threadId, input: this.input(text, images, files), ...(this.pendingModel ? { model: this.pendingModel } : {}) });
      this.pendingModel = undefined;
      this.turnId = r?.turn?.id ?? this.turnId;
    } catch (e: any) {
      this.events.push({ type: 'turnEnd', error: needsLogin(e) ? `${e.message}. ${LOGIN}.` : String(e?.message ?? e) });
    }
  }

  async steer(text: string, images: string[]) {
    await this.ready;
    if (!this.turnId) return this.send(text, images, []);
    await this.rpc.request('turn/steer', { threadId: this.threadId, input: this.input(text, images), expectedTurnId: this.turnId });
  }

  async interrupt() {
    await this.ready.catch(() => {});
    if (this.threadId && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  async setModel(model: string) {
    this.opts.model = model;
    // applies from the next turn on (turn/start takes model overrides too, but this one is sticky)
    await this.ready;
    this.pendingModel = model;
  }
  private pendingModel?: string;

  async listModels() {
    await this.ready.catch(() => {});
    const r = await this.rpc.request('model/list', {}).catch(() => undefined);
    return (r?.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ value: m.model ?? m.id, displayName: m.displayName ?? m.model ?? m.id }));
  }

  respond(requestId: string, decision: Decision, extra?: { reason?: string; answers?: Record<string, string> }) {
    const a = this.asks.get(requestId);
    if (!a) return;
    this.asks.delete(requestId);
    if (a.kind === 'input') {
      const answers = Object.fromEntries((a.ids ?? []).map((id, i) => [id, { answers: [extra?.answers?.[a.texts![i]] ?? extra?.answers?.[id] ?? ''].filter(Boolean) }]));
      return this.rpc.reply(a.rpcId, { answers });
    }
    this.rpc.reply(a.rpcId, { decision: decision === 'allow' ? 'accept' : decision === 'allowAlways' ? 'acceptForSession' : 'decline' });
  }

  close() {
    this.closed = true;
    this.events.end();
    try {
      (this.rpc as any).child.kill();
    } catch {}
  }

  // ---------------------------------------------------------------- server → client

  private request(id: number | string, method: string, p: any) {
    const rid = `ask-${id}`;
    if (method === 'item/commandExecution/requestApproval') {
      this.asks.set(rid, { rpcId: id, kind: 'command' });
      const command = p?.command ?? '';
      this.events.push({ type: 'permission', requestId: rid, tool: 'Bash', summary: command || p?.reason || 'Run a command', input: { command, cwd: p?.cwd, description: p?.reason ?? undefined }, canAlways: true });
    } else if (method === 'item/fileChange/requestApproval') {
      this.asks.set(rid, { rpcId: id, kind: 'file' });
      const changes = this.fileChanges.get(p?.itemId) ?? [];
      const file = changes[0]?.path;
      this.events.push({ type: 'permission', requestId: rid, tool: 'Edit', summary: file ? `Edit ${path.basename(file)}${changes.length > 1 ? ` (+${changes.length - 1})` : ''}` : p?.reason || 'Change files', input: { file_path: file, files: changes.map((c) => c.path), reason: p?.reason ?? undefined }, canAlways: true });
    } else if (method === 'item/tool/requestUserInput') {
      const qs = (p?.questions ?? []) as any[];
      this.asks.set(rid, { rpcId: id, kind: 'input', ids: qs.map((q) => q.id), texts: qs.map((q) => q.question) });
      this.events.push({ type: 'question', requestId: rid, questions: qs.map((q) => ({ question: q.question, header: q.header ?? '', multiSelect: false, options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description ?? '' })) })) });
    } else {
      this.rpc.replyError(id, -32601, `Steerhouse does not handle ${method}`);
    }
  }

  private fileChanges = new Map<string, { path: string; kind?: string; diff: string }[]>();
  private outputs = new Map<string, string>();

  private notification(method: string, p: any) {
    switch (method) {
      case 'turn/started':
        this.turnId = p?.turn?.id ?? this.turnId;
        return this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
      case 'item/started':
        return this.itemStarted(p?.item);
      case 'item/completed':
        return this.itemCompleted(p?.item);
      case 'item/agentMessage/delta':
        return this.events.push({ type: 'textDelta', id: p.itemId, delta: p.delta ?? '' });
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.events.push({ type: 'thinkingDelta', id: p.itemId, delta: p.delta ?? '' });
      case 'item/reasoning/summaryPartAdded':
        return this.events.push({ type: 'thinkingDelta', id: p.itemId, delta: '\n\n' });
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.outputs.set(p.itemId, (this.outputs.get(p.itemId) ?? '') + (p.delta ?? ''));
        return this.events.push({ type: 'toolOutput', id: p.itemId, delta: p.delta ?? '' });
      case 'turn/plan/updated':
        return this.events.push({
          type: 'todos',
          todos: (p?.plan ?? []).map((s: any) => ({ content: s.step, activeForm: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending' })),
        });
      case 'thread/tokenUsage/updated': {
        const u = p?.tokenUsage;
        if (u) this.usage = { input: u.last?.inputTokens ?? 0, output: u.last?.outputTokens ?? 0, total: u.total?.totalTokens ?? 0, contextWindow: u.modelContextWindow ?? undefined };
        return;
      }
      case 'error':
        if (!p?.willRetry) this.lastError = p?.error?.message;
        else this.events.push({ type: 'notice', key: `retry-${p?.turnId}`, text: `Codex: ${p?.error?.message ?? 'error'} (retrying)` });
        return;
      case 'turn/completed': {
        const t = p?.turn ?? {};
        this.turnId = undefined;
        const err = t.status === 'failed' ? (t.error?.message ?? this.lastError ?? 'The turn failed') : undefined;
        this.lastError = undefined;
        this.events.push({ type: 'turnEnd', usage: this.usage, error: err && needsLogin(err) ? `${err}. ${LOGIN}.` : err, interrupted: t.status === 'interrupted' });
        return;
      }
    }
  }
  private usage?: { input: number; output: number; total: number; contextWindow?: number };
  private lastError?: string;

  private itemStarted(it: any) {
    if (!it?.id) return;
    this.kinds.set(it.id, it.type);
    const start = (name: string, kind: ToolKind, summary: string, input: unknown) => this.events.push({ type: 'toolStart', id: it.id, name, kind, summary, input });
    switch (it.type) {
      case 'commandExecution': {
        const a = it.commandActions?.[0];
        const kind: ToolKind = it.commandActions?.length && it.commandActions.every((x: any) => x.type === 'read') ? 'read' : a?.type === 'search' || a?.type === 'listFiles' ? 'search' : 'run';
        return start(kind === 'read' ? 'Read' : kind === 'search' ? 'Grep' : 'Bash', kind, it.command, kind === 'read' ? { file_path: a.path, command: it.command } : kind === 'search' ? { pattern: a.query ?? '', path: a.path ?? undefined, command: it.command } : { command: it.command, cwd: it.cwd });
      }
      case 'fileChange': {
        const changes = (it.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type, diff: c.diff ?? '' }));
        this.fileChanges.set(it.id, changes);
        return start('Edit', 'edit', changes.map((c: any) => path.basename(c.path)).join(', '), { file_path: changes[0]?.path, files: changes.map((c: any) => c.path) });
      }
      case 'mcpToolCall':
        return start(`mcp__${it.server}__${it.tool}`, 'mcp', `${it.server}: ${it.tool}`, it.arguments ?? {});
      case 'dynamicToolCall':
        return start(it.tool, 'other', it.tool, it.arguments ?? {});
      case 'webSearch':
        return start('WebSearch', 'browser', it.query ?? 'Web search', { query: it.query });
      case 'collabAgentToolCall':
        return start('Agent', 'agent', it.prompt ?? 'Sub-agent', { description: (it.prompt ?? '').slice(0, 60), prompt: it.prompt, model: it.model });
      case 'imageView':
        return start('Read', 'read', it.path, { file_path: it.path });
    }
  }

  private itemCompleted(it: any) {
    if (!it?.id) return;
    const seen = this.kinds.has(it.id);
    if (!seen && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'collabAgentToolCall', 'imageView'].includes(it.type)) this.itemStarted(it);
    const failed = ['failed', 'declined'].includes(it.status) || it.success === false;
    switch (it.type) {
      case 'agentMessage':
        return this.events.push({ type: 'textDone', id: it.id, text: it.text });
      case 'reasoning':
        return this.events.push({ type: 'thinkingDone', id: it.id });
      case 'plan':
        return this.events.push({ type: 'plan', text: it.text ?? '' });
      case 'commandExecution':
        return this.events.push({ type: 'toolEnd', id: it.id, status: failed || (it.exitCode ?? 0) !== 0 ? 'error' : 'done', result: (it.aggregatedOutput ?? this.outputs.get(it.id) ?? '') + (it.status === 'declined' ? 'Declined' : '') });
      case 'fileChange': {
        const changes = (it.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type, diff: c.diff ?? '' }));
        const patch = changes.flatMap((c: any) => hunksOf(c.diff, c.kind));
        return this.events.push({ type: 'toolEnd', id: it.id, status: failed ? 'error' : 'done', result: it.status === 'declined' ? 'Declined' : changes.map((c: any) => c.path).join('\n'), patch, file: changes[0]?.path });
      }
      case 'mcpToolCall':
        return this.events.push({ type: 'toolEnd', id: it.id, status: failed ? 'error' : 'done', result: it.error?.message ?? JSON.stringify(it.result?.content ?? it.result ?? '') });
      case 'dynamicToolCall':
      case 'webSearch':
      case 'collabAgentToolCall':
      case 'imageView':
        return this.events.push({ type: 'toolEnd', id: it.id, status: failed ? 'error' : 'done', result: it.contentItems ? JSON.stringify(it.contentItems) : '' });
    }
  }
}

/** Runs `codex --version`; logged in when `codex login status` says so. */
function run(exe: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const c = execFile(exe, args, { timeout: 8000, windowsHide: true }, (e, so, se) => res({ ok: !e, out: `${so}${se}`.trim() }));
    c.on('error', () => res({ ok: false, out: '' }));
  });
}

export function codexRuntime(find: () => string | undefined): AgentRuntime {
  return {
    id: 'codex',
    label: 'Codex',
    vendor: 'openai',
    caps: { steer: true, fork: false, rewind: false, thinking: true, todos: true, subagents: true, approvals: true, images: true, effort: false, permissionModes: false },
    async detect() {
      const exe = find();
      if (!exe) return { authed: false, loginHint: 'Install Codex: npm i -g @openai/codex' };
      const v = await run(exe, ['--version']);
      const st = await run(exe, ['login', 'status']);
      return { exe, version: v.out.replace(/^codex(-cli)?\s*/i, '') || undefined, authed: st.ok && !/not logged in/i.test(st.out), loginHint: 'codex login' };
    },
    start: (opts) => new CodexSession({ ...opts, executable: opts.executable ?? find() }),
  };
}
