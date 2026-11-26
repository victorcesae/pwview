// OpenCode through `opencode serve`: one local server per chat (127.0.0.1, a free port, basic auth
// with a random OPENCODE_SERVER_PASSWORD), driven over its HTTP API + the /event SSE stream, the way
// t3code's provider-opencode does. Endpoints checked against the server's own OpenAPI doc
// (GET /doc, opencode 1.19.6) and https://opencode.ai/docs/server/: POST /session, GET /session/:id,
// POST /session/:id/prompt_async, POST /session/:id/abort, POST /permission/:id/reply,
// GET /config/providers, GET /event (events are { type, properties }).
import { spawn, execFile, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import type { Hunk } from '../chat';
import { parseHunks } from './codex';
import { EventQueue, type AgentRuntime, type Decision, type RuntimeEvent, type RuntimeSession, type RuntimeStartOptions, type ToolKind } from './types';

export const OPENCODE_LOGIN = 'Add a provider with `opencode auth login`';

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** OpenCode tool name → our tool name and kind */
function toolOf(tool: string): { name: string; kind: ToolKind } {
  switch (tool) {
    case 'bash':
      return { name: 'Bash', kind: 'run' };
    case 'edit':
    case 'patch':
    case 'apply_patch':
    case 'multiedit':
      return { name: 'Edit', kind: 'edit' };
    case 'write':
      return { name: 'Write', kind: 'edit' };
    case 'read':
      return { name: 'Read', kind: 'read' };
    case 'grep':
      return { name: 'Grep', kind: 'search' };
    case 'glob':
    case 'list':
      return { name: 'Glob', kind: 'search' };
    case 'webfetch':
    case 'websearch':
      return { name: 'WebFetch', kind: 'browser' };
    case 'task':
      return { name: 'Agent', kind: 'agent' };
  }
  return /^.+_.+$/.test(tool) && !tool.startsWith('todo') ? { name: tool, kind: 'mcp' } : { name: tool, kind: 'other' };
}

/** OpenCode tool input → the input shape our tool rows read (file_path, command, pattern…) */
function inputOf(tool: string, i: any): any {
  i = i ?? {};
  const file = i.filePath ?? i.file_path ?? i.path;
  switch (tool) {
    case 'bash':
      return { command: i.command ?? '', description: i.description };
    case 'edit':
      return { file_path: file, old_string: i.oldString, new_string: i.newString };
    case 'write':
      return { file_path: file, content: i.content };
    case 'read':
      return { file_path: file };
    case 'grep':
    case 'glob':
      return { pattern: i.pattern ?? '', path: i.path };
    case 'webfetch':
      return { url: i.url };
    case 'task':
      return { description: i.description ?? '', prompt: i.prompt, subagent_type: i.subagent_type };
  }
  return i;
}

function summaryOf(tool: string, i: any, title?: string): string {
  const x = inputOf(tool, i);
  return x.command || (x.file_path && path.basename(x.file_path)) || x.pattern || x.url || x.description || title || tool;
}

/** A new file's content as one added hunk */
const added = (content: string): Hunk[] => {
  const lines = content.replace(/\n$/, '').split('\n');
  return content ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }] : [];
};

const errText = (e: any): string | undefined => (e ? String(e.data?.message ?? e.message ?? e.name ?? 'error') : undefined);
const isAuth = (e: any) => e?.name === 'ProviderAuthError' || /auth|api key|401|unauthori[sz]ed|no provider|provider.*not found|model.*not found/i.test(String(errText(e) ?? e));

/** One OpenCode session on its own `opencode serve`. */
export class OpenCodeSession implements RuntimeSession {
  readonly events = new EventQueue<RuntimeEvent>();
  private child?: ChildProcess;
  private base = '';
  private auth: string;
  private password = crypto.randomBytes(18).toString('base64url');
  private ready: Promise<void>;
  private sessionId?: string;
  private sse = new AbortController();
  private closed = false;
  private stderr = '';
  private roles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  /** text / reasoning already sent per part */
  private sent = new Map<string, number>();
  private done = new Set<string>();
  private started = new Set<string>();
  private busy = false;
  private aborted = false;
  private lastError?: any;
  private usage?: { input: number; output: number; total: number };
  private cost?: number;
  private model?: string;

  constructor(private opts: RuntimeStartOptions) {
    this.auth = 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
    this.model = opts.model;
    this.ready = this.boot();
    this.ready.catch((e) => {
      if (this.closed) return;
      this.events.push({ type: 'status', status: 'error', error: String(e?.message ?? e) });
      this.close();
    });
  }

  private async boot() {
    const port = await freePort();
    const exe = this.opts.executable ?? 'opencode';
    const isScript = /\.c?js$/i.test(exe);
    const args = ['serve', '--hostname=127.0.0.1', `--port=${port}`];
    const child = spawn(isScript ? process.execPath : exe, isScript ? [exe, ...args] : args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}), OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_SERVER_USERNAME: 'opencode' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.base = `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('opencode serve did not start')), 30000);
      t.unref?.();
      const fail = (why: string) => {
        clearTimeout(t);
        reject(new Error(why));
      };
      child.on('error', (e) => fail(String(e.message)));
      child.on('exit', (code, sig) => {
        fail(`opencode serve exited (${sig ?? code})${this.stderr ? ': ' + this.stderr.trim().split('\n').slice(-3).join(' ') : ''}`);
        if (!this.closed) {
          this.events.push({ type: 'status', status: 'error', error: `opencode serve exited (${sig ?? code})` });
          this.events.end();
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-4000)));
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        out += d;
        const m = /listening on\s+(https?:\/\/\S+)/i.exec(out);
        if (m) {
          this.base = m[1].replace(/\/$/, '');
          clearTimeout(t);
          resolve();
        }
      });
    });
    void this.stream();
    const s = this.opts.resume ? await this.api('GET', `/session/${encodeURIComponent(this.opts.resume)}`) : await this.api('POST', '/session', {});
    this.sessionId = s?.id;
    if (!this.sessionId) throw new Error('OpenCode did not create a session');
    this.events.push({ type: 'sessionId', id: this.sessionId });
    const models = await this.models();
    if (!models.length) this.events.push({ type: 'notice', text: `OpenCode has no model provider. ${OPENCODE_LOGIN} in a terminal, then send your message again.` });
    const m = this.model ?? (s?.model?.providerID && s.model.id ? `${s.model.providerID}/${s.model.id}` : this.defaultModel);
    if (m) this.events.push({ type: 'model', model: (this.model = m) });
    this.events.push({ type: 'status', status: 'idle' });
  }
  private defaultModel?: string;

  private async api(method: string, p: string, body?: unknown): Promise<any> {
    const r = await fetch(this.base + p, { method, headers: { authorization: this.auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) {
      let msg = text;
      try {
        const j = JSON.parse(text);
        msg = j?.data?.message ?? j?.message ?? j?.error ?? text;
      } catch {}
      throw new Error(`OpenCode ${method} ${p.split('?')[0]}: ${r.status} ${String(msg).slice(0, 300)}`);
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** the /event SSE stream, for the life of the chat */
  private async stream() {
    try {
      const r = await fetch(this.base + '/event', { headers: { authorization: this.auth, accept: 'text/event-stream' }, signal: this.sse.signal });
      if (!r.ok || !r.body) throw new Error(`OpenCode /event: ${r.status}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data) continue;
          try {
            this.event(JSON.parse(data));
          } catch {}
        }
      }
    } catch (e: any) {
      if (!this.closed) this.events.push({ type: 'notice', text: `OpenCode event stream closed: ${e?.message ?? e}` });
    }
  }

  private async parts(text: string, images: string[], files: string[]) {
    const out: any[] = [];
    const body = files.length ? `${text}\n\n${files.map((f) => `@${f}`).join('\n')}` : text;
    if (body) out.push({ type: 'text', text: body });
    for (const p of images) {
      const mime = MIME[path.extname(p).toLowerCase()] ?? 'image/png';
      const data = await fs.promises.readFile(p);
      out.push({ type: 'file', mime, filename: path.basename(p), url: `data:${mime};base64,${data.toString('base64')}` });
    }
    return out;
  }

  async send(text: string, images: string[], files: string[]) {
    await this.ready;
    this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
    this.busy = true;
    this.aborted = false;
    this.lastError = undefined;
    this.usage = undefined;
    this.cost = undefined;
    try {
      const m = this.model ? /^([^/]+)\/(.+)$/.exec(this.model) : undefined;
      await this.api('POST', `/session/${this.sessionId}/prompt_async`, { parts: await this.parts(text, images, files), ...(m ? { model: { providerID: m[1], modelID: m[2] } } : {}) });
    } catch (e: any) {
      this.busy = false;
      const err = String(e?.message ?? e);
      this.events.push({ type: 'turnEnd', error: isAuth(err) ? `${err}. ${OPENCODE_LOGIN}.` : err });
    }
  }

  async interrupt() {
    await this.ready.catch(() => {});
    if (!this.sessionId) return;
    this.aborted = true;
    await this.api('POST', `/session/${this.sessionId}/abort`).catch(() => {});
  }

  async setModel(model: string) {
    this.model = model;
  }

  async listModels() {
    await this.ready.catch(() => {});
    return this.models();
  }

  private async models() {
    const r = await this.api('GET', '/config/providers').catch(() => undefined);
    const provs = (r?.providers ?? []) as any[];
    const def = r?.default ?? {};
    const first = provs.find((p) => def[p.id]);
    if (first) this.defaultModel = `${first.id}/${def[first.id]}`;
    return provs.flatMap((p) => Object.values(p.models ?? {}).map((m: any) => ({ value: `${p.id}/${m.id}`, displayName: `${p.name ?? p.id} · ${m.name ?? m.id}` })));
  }

  respond(requestId: string, decision: Decision, extra?: { reason?: string }) {
    const reply = decision === 'allow' ? 'once' : decision === 'allowAlways' ? 'always' : 'reject';
    void this.api('POST', `/permission/${encodeURIComponent(requestId)}/reply`, { reply, ...(extra?.reason ? { message: extra.reason } : {}) }).catch((e) => this.events.push({ type: 'notice', text: String(e?.message ?? e) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sse.abort();
    this.events.end();
    try {
      this.child?.kill();
    } catch {}
  }

  // ---------------------------------------------------------------- server → client

  private event(ev: any) {
    const t = ev?.type as string;
    const p = ev?.properties ?? {};
    if (p.sessionID && this.sessionId && p.sessionID !== this.sessionId) return;
    switch (t) {
      case 'message.updated': {
        const info = p.info ?? {};
        if (info.id) this.roles.set(info.id, info.role);
        if (info.role !== 'assistant') return;
        if (info.providerID && info.modelID) {
          const m = `${info.providerID}/${info.modelID}`;
          if (m !== this.lastModel) this.events.push({ type: 'model', model: (this.lastModel = m) });
        }
        if (info.error) this.lastError = info.error;
        const tk = info.tokens;
        if (tk) this.usage = { input: tk.input ?? 0, output: tk.output ?? 0, total: (tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0) + (tk.cache?.read ?? 0) };
        if (typeof info.cost === 'number') this.cost = info.cost;
        return;
      }
      case 'message.part.updated':
        return this.part(p.part);
      case 'message.part.delta': {
        if (this.roles.get(p.messageID) === 'user') return;
        const type = this.partTypes.get(p.partID);
        if (p.field !== 'text' || (type !== 'text' && type !== 'reasoning') || !p.delta) return;
        this.sent.set(p.partID, (this.sent.get(p.partID) ?? 0) + p.delta.length);
        return this.events.push(type === 'text' ? { type: 'textDelta', id: p.partID, delta: p.delta } : { type: 'thinkingDelta', id: p.partID, delta: p.delta });
      }
      case 'permission.asked':
      case 'permission.updated': {
        const tool = toolOf(p.permission ?? p.type ?? 'other');
        const md = p.metadata ?? {};
        const pats = (p.patterns ?? (p.pattern ? [].concat(p.pattern) : [])) as string[];
        const summary = md.command ?? (md.filepath || md.filePath ? path.basename(md.filepath ?? md.filePath) : '') ?? '';
        return this.events.push({
          type: 'permission',
          requestId: p.id,
          tool: tool.name,
          summary: summary || pats.join(' ') || p.title || p.permission || 'Permission',
          input: { ...md, command: md.command, file_path: md.filepath ?? md.filePath, patterns: pats },
          canAlways: true,
        });
      }
      case 'todo.updated':
        return this.events.push({
          type: 'todos',
          todos: (p.todos ?? []).filter((x: any) => x.status !== 'cancelled').map((x: any) => ({ content: x.content, activeForm: x.content, status: x.status === 'in_progress' ? 'in_progress' : x.status === 'completed' ? 'completed' : 'pending' })),
        });
      case 'session.status': {
        const s = p.status ?? {};
        if (s.type === 'busy' && this.busy) this.events.push({ type: 'status', status: 'working', activity: 'Thinking…' });
        else if (s.type === 'retry') this.events.push({ type: 'notice', key: 'opencode-retry', text: `OpenCode: ${s.message ?? 'error'} (retry ${s.attempt ?? ''})` });
        else if (s.type === 'idle') this.idle();
        return;
      }
      case 'session.idle':
        return this.idle();
      case 'session.error':
        this.lastError = p.error ?? { message: 'error' };
        return;
    }
  }
  private lastModel?: string;

  private idle() {
    if (!this.busy) return;
    this.busy = false;
    const e = this.lastError;
    const interrupted = this.aborted || e?.name === 'MessageAbortedError';
    const err = interrupted ? undefined : errText(e);
    this.lastError = undefined;
    this.events.push({ type: 'turnEnd', usage: this.usage, costUsd: this.cost, error: err && isAuth(e) ? `${err}. ${OPENCODE_LOGIN}.` : err, interrupted });
  }

  private part(pt: any) {
    if (!pt?.id) return;
    if (this.roles.get(pt.messageID) === 'user') return;
    this.partTypes.set(pt.id, pt.type);
    if (pt.type === 'text' || pt.type === 'reasoning') {
      if (pt.synthetic || pt.ignored || this.done.has(pt.id)) return;
      const text: string = pt.text ?? '';
      const n = this.sent.get(pt.id) ?? 0;
      if (text.length > n) {
        const delta = text.slice(n);
        this.sent.set(pt.id, text.length);
        this.events.push(pt.type === 'text' ? { type: 'textDelta', id: pt.id, delta } : { type: 'thinkingDelta', id: pt.id, delta });
      }
      if (pt.time?.end) {
        this.done.add(pt.id);
        this.events.push(pt.type === 'text' ? { type: 'textDone', id: pt.id, text } : { type: 'thinkingDone', id: pt.id });
      }
      return;
    }
    if (pt.type !== 'tool') return;
    const st = pt.state ?? {};
    // the todo list shows in the Todos panel (todo.updated)
    if (/^todo(write|read)$/.test(pt.tool)) return;
    if (this.done.has(pt.id)) return;
    const { name, kind } = toolOf(pt.tool);
    if (!this.started.has(pt.id) && st.status !== 'pending') {
      this.started.add(pt.id);
      this.events.push({ type: 'toolStart', id: pt.id, name, kind, summary: summaryOf(pt.tool, st.input, st.title), input: inputOf(pt.tool, st.input) });
    }
    if (st.status === 'completed' || st.status === 'error') {
      this.done.add(pt.id);
      const md = st.metadata ?? {};
      const file = st.input?.filePath ?? st.input?.file_path;
      let patch: Hunk[] | undefined;
      if (kind === 'edit') {
        const diff = typeof md.diff === 'string' ? md.diff : typeof md.patch === 'string' ? md.patch : '';
        patch = diff ? parseHunks(diff) : pt.tool === 'write' && typeof st.input?.content === 'string' ? added(st.input.content) : undefined;
      }
      this.events.push({ type: 'toolEnd', id: pt.id, status: st.status === 'error' ? 'error' : 'done', result: st.status === 'error' ? String(st.error ?? 'error') : String(st.output ?? ''), patch, file });
    }
  }
}

function run(exe: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((res) => {
    const c = execFile(exe, args, { timeout: 8000, windowsHide: true }, (e, so, se) => res({ ok: !e, out: `${so}${se}`.trim() }));
    c.on('error', () => res({ ok: false, out: '' }));
  });
}

export function opencodeRuntime(find: () => string | undefined): AgentRuntime {
  return {
    id: 'opencode',
    label: 'OpenCode',
    vendor: 'other',
    caps: { steer: false, fork: false, rewind: false, thinking: true, todos: true, subagents: false, approvals: true, images: true, effort: false, permissionModes: false },
    async detect() {
      const exe = find();
      if (!exe) return { authed: false, loginHint: 'Install OpenCode: npm i -g opencode-ai' };
      const v = await run(exe, ['--version']);
      // OpenCode ships free models of its own, so no credentials can still work; the session says so when there is no provider
      return { exe, version: v.out.split('\n').pop() || undefined, authed: true, loginHint: 'opencode auth login' };
    },
    start: (opts) => new OpenCodeSession({ ...opts, executable: opts.executable ?? find() }),
  };
}
