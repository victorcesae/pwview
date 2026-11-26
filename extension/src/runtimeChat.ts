// A Steerhouse chat on another coding agent (Codex…): the RuntimeEvents of an AgentRuntime folded
// into the same ChatState / ChatItems the Claude chat shows, with the same public surface the chat
// panel drives (send / steer / queue, interrupt, permissions…). Claude chats keep using ChatSession.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatItem, ChatOptions, ChatSession, ChatState, Effort, Priority } from './chat';
import { ShellRun } from './shell';
import type { AgentRuntime, RuntimeEvent, RuntimeSession } from './runtimes/types';

type Img = { data: string; mime: string };
const uid = () => Math.random().toString(36).slice(2, 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Every public member of ChatSession: RuntimeChat stands in for it in the chat panel. */
export type ChatSurface = { [K in keyof ChatSession]: ChatSession[K] };

export interface RuntimeChatOptions {
  runtime: AgentRuntime;
  cwd: string;
  resume?: string;
  title?: string;
  model?: string;
  executable?: string;
  env?: Record<string, string | undefined>;
  host?: string;
  hostIcon?: string;
  /** earlier turns to show (a reopened chat) */
  history?: ChatItem[];
}

export class RuntimeChat implements ChatSurface {
  readonly state: ChatState;
  turns = 0;
  onTurnEnd?: () => void;
  followUpWaitMs = 0;
  steerGraceMs = 3000;
  private session?: RuntimeSession;
  private queued: { id: string; text: string; images: Img[]; priority: 'later' | 'next'; files?: string[]; held?: boolean }[] = [];
  private pending = new Set<string>();
  private stopping = false;
  private shells = new Map<string, ShellRun>();
  private notes: string[] = [];

  get options(): ChatOptions {
    return { cwd: this.opts.cwd, resume: this.state.sessionId, title: this.state.title, model: this.state.model, executable: this.opts.executable };
  }
  get runtimeOptions(): RuntimeChatOptions {
    return this.opts;
  }

  constructor(
    private opts: RuntimeChatOptions,
    private onChange: (s: ChatState) => void,
  ) {
    const r = opts.runtime;
    this.state = {
      key: uid(),
      sessionId: opts.resume,
      cwd: opts.cwd,
      title: opts.title ?? 'New chat',
      model: opts.model,
      models: [],
      permissionMode: 'default',
      fastMode: false,
      ultracode: false,
      status: 'starting',
      todos: [],
      items: opts.history ? [...opts.history] : opts.resume ? [{ kind: 'system', id: uid(), text: `Resumed ${r.label} thread` }] : [],
      earlier: 0,
      tasks: [],
      queue: [],
      slashCommands: [],
      mcp: [],
      costUsd: 0,
      account: { name: r.label, provider: r.id },
      host: opts.host,
      hostIcon: opts.hostIcon,
      runtime: r.id,
      caps: r.caps,
    };
  }

  private changed() {
    const busy = this.state.status === 'working' || this.state.status === 'waiting';
    if (busy && !this.state.turnStarted) this.state.turnStarted = Date.now();
    if (!busy) this.state.turnStarted = undefined;
    this.state.queue = this.queued.map((m) => ({ id: m.id, text: m.text, images: m.images.length, priority: m.priority }));
    this.onChange(this.state);
  }

  start() {
    this.session = this.opts.runtime.start({ cwd: this.opts.cwd, resume: this.opts.resume, model: this.opts.model, executable: this.opts.executable, env: this.opts.env });
    this.loop().catch((e) => this.fail(String(e?.message ?? e)));
    this.session
      .listModels()
      .then((ms) => {
        this.state.models = ms;
        this.changed();
      })
      .catch(() => {});
    this.changed();
  }

  /** resolves once the session has nothing more to say (tests) */
  done?: Promise<void>;

  private async loop() {
    let resolve!: () => void;
    this.done = new Promise((r) => (resolve = r));
    try {
      for await (const e of this.session!.events) this.apply(e);
    } finally {
      resolve();
    }
  }

  private fail(error: string) {
    this.state.status = 'error';
    this.state.error = error;
    this.state.activity = undefined;
    this.state.items.push({ kind: 'result', id: uid(), text: error, isError: true, ts: new Date().toISOString() });
    this.changed();
  }

  private find<K extends ChatItem['kind']>(id: string, kind: K) {
    return this.state.items.find((x) => x.id === id && x.kind === kind) as Extract<ChatItem, { kind: K }> | undefined;
  }

  /** One runtime event into the chat state. */
  apply(e: RuntimeEvent) {
    const s = this.state;
    const ts = new Date().toISOString();
    switch (e.type) {
      case 'sessionId':
        s.sessionId = e.id;
        break;
      case 'model':
        s.model ??= e.model;
        break;
      case 'status':
        if (e.status === 'error') return this.fail(e.error ?? 'Error');
        if (e.status === 'idle' && (s.status === 'starting' || s.status === 'idle')) s.status = 'idle';
        else if (e.status === 'working' && s.status !== 'waiting') {
          s.status = 'working';
          s.activity = e.activity ?? s.activity;
        }
        break;
      case 'commands':
        s.slashCommands = e.names;
        break;
      case 'notice': {
        const same = e.key ? this.find(e.key, 'system') : undefined;
        if (same) same.text = e.text;
        else s.items.push({ kind: 'system', id: e.key ?? uid(), text: e.text, ts });
        break;
      }
      case 'textDelta': {
        const it = this.find(e.id, 'assistant');
        if (it) it.text += e.delta;
        else s.items.push({ kind: 'assistant', id: e.id, text: e.delta, streaming: true, ts });
        s.activity = 'Writing…';
        break;
      }
      case 'textDone': {
        const it = this.find(e.id, 'assistant');
        if (it) {
          if (e.text !== undefined) it.text = e.text;
          it.streaming = false;
        } else if (e.text) s.items.push({ kind: 'assistant', id: e.id, text: e.text, ts });
        break;
      }
      case 'thinkingDelta': {
        const it = this.find(e.id, 'thinking');
        if (it) it.text += e.delta;
        else s.items.push({ kind: 'thinking', id: e.id, text: e.delta, streaming: true, started: Date.now(), ts });
        s.activity = 'Thinking…';
        break;
      }
      case 'thinkingDone': {
        const it = this.find(e.id, 'thinking');
        if (it) {
          it.streaming = false;
          if (it.started) it.durationMs = Date.now() - it.started;
          if (!it.text.trim()) s.items = s.items.filter((x) => x !== it);
        }
        break;
      }
      case 'toolStart':
        if (!this.find(e.id, 'tool')) s.items.push({ kind: 'tool', id: e.id, name: e.name, summary: e.summary, input: e.input, status: 'running', file: (e.input as any)?.file_path, ts });
        s.activity = clip(`${e.name}: ${e.summary}`, 80);
        break;
      case 'toolOutput': {
        const it = this.find(e.id, 'tool');
        if (it) it.result = (it.result ?? '') + e.delta;
        break;
      }
      case 'toolEnd': {
        const it = this.find(e.id, 'tool');
        if (!it) break;
        it.status = e.status;
        if (e.result !== undefined && (e.result || !it.result)) it.result = e.result;
        if (e.patch?.length) it.patch = e.patch;
        if (e.file) it.file = e.file;
        if (it.ts) it.elapsed = Date.now() - Date.parse(it.ts);
        break;
      }
      case 'permission':
        this.pending.add(e.requestId);
        s.items.push({ kind: 'permission', id: e.requestId, tool: e.tool, summary: e.summary, input: e.input, canAlways: e.canAlways, status: 'pending' });
        s.status = 'waiting';
        s.activity = `Waiting for permission: ${e.tool}`;
        break;
      case 'question':
        this.pending.add(e.requestId);
        s.items.push({ kind: 'question', id: e.requestId, questions: e.questions, status: 'pending' });
        s.status = 'waiting';
        s.activity = 'Waiting for your answer';
        break;
      case 'plan':
        if (e.text.trim()) s.items.push({ kind: 'assistant', id: uid(), text: e.text, ts });
        break;
      case 'todos':
        s.todos = e.todos;
        break;
      case 'turnEnd': {
        this.turns++;
        for (const it of s.items) {
          if ((it.kind === 'assistant' || it.kind === 'thinking') && it.streaming) it.streaming = false;
          if (it.kind === 'tool' && it.status === 'running') it.status = e.interrupted ? 'error' : 'done';
          if (it.kind === 'permission' && it.status === 'pending') it.status = 'denied';
        }
        this.pending.clear();
        const started = s.turnStarted;
        if (e.usage) {
          s.tokens = e.usage.total;
          if (e.usage.contextWindow) s.context = { used: e.usage.input, max: e.usage.contextWindow, percentage: Math.round((e.usage.input / e.usage.contextWindow) * 100) };
        }
        if (e.costUsd) s.costUsd += e.costUsd;
        if (e.error && !(this.stopping && e.interrupted)) s.items.push({ kind: 'result', id: uid(), text: e.error, isError: true, ts });
        else if (e.interrupted || this.stopping) s.items.push({ kind: 'system', id: uid(), text: 'Stopped', ts });
        else {
          const last = [...s.items].reverse().find((x) => x.kind === 'assistant');
          if (last && last.kind === 'assistant' && started) last.durationMs = Date.now() - started;
        }
        this.stopping = false;
        s.status = 'idle';
        s.activity = undefined;
        this.changed();
        // what was queued goes next; otherwise the turn is over (verify runs then)
        const next = this.queued.find((q) => !q.held);
        if (next) {
          this.queued = this.queued.filter((q) => q !== next);
          this.push(next.text, next.images, 'later', next.files);
        } else this.onTurnEnd?.();
        return;
      }
    }
    this.changed();
  }

  // ---------------------------------------------------------------- sending

  /** base64 images → files the agent can open */
  private imageFiles(images: Img[]): string[] {
    if (!images.length) return [];
    const dir = path.join(os.tmpdir(), 'steerhouse-images');
    fs.mkdirSync(dir, { recursive: true });
    return images.map((img) => {
      const ext = (/image\/(\w+)/.exec(img.mime)?.[1] ?? 'png').replace('jpeg', 'jpg');
      const file = path.join(dir, `${Date.now()}-${uid()}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data.replace(/^data:[^;]+;base64,/, ''), 'base64'));
      return file;
    });
  }

  send(text: string, images: Img[], priority: Priority, files: string[] = []) {
    if (!text.trim() && !images.length && !files.length) return;
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    if (working && (priority === 'later' || (priority === 'next' && !this.opts.runtime.caps.steer))) {
      this.queued.push({ id: uid(), text, images, priority: 'later', files });
      return this.changed();
    }
    this.push(text, images, working ? 'next' : 'later', files);
  }

  private push(text: string, images: Img[], priority: Priority, files: string[] = [], forAgent?: string, auto?: boolean) {
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    this.state.items.push({ kind: 'user', id: uid(), text, images: images.map((i) => i.data), files: files.length ? files : undefined, priority, ts: new Date().toISOString(), auto: auto || undefined });
    if (this.state.title === 'New chat' && text.trim()) this.state.title = clip(text.trim().split('\n')[0], 60);
    const body = [forAgent ?? text, ...this.notes.splice(0)].filter((t) => t.trim()).join('\n\n');
    const paths = this.imageFiles(images);
    const s = this.session!;
    if (working && s.steer) s.steer(body, paths).catch((e) => this.apply({ type: 'notice', text: `Could not steer: ${e?.message ?? e}` }));
    else {
      this.state.status = 'working';
      this.state.activity = 'Thinking…';
      s.send(body, paths, files).catch((e) => this.fail(String(e?.message ?? e)));
    }
    this.changed();
  }

  sendAuto(shown: string, forAgent: string) {
    if (this.state.status === 'working' || this.state.status === 'waiting') return;
    this.push(shown, [], 'later', [], forAgent, true);
  }

  editQueued(id: string, text: string) {
    const m = this.queued.find((x) => x.id === id);
    if (!m || !text.trim()) return;
    m.text = text;
    this.changed();
  }

  holdQueued(id: string, hold: boolean) {
    const m = this.queued.find((x) => x.id === id);
    if (m) m.held = hold;
  }

  promote(id: string, priority: Priority = 'now') {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (priority === 'later') return;
    const [m] = this.queued.splice(i, 1);
    this.push(m.text, m.images, 'next', m.files);
  }

  cancelQueued(id: string) {
    this.queued = this.queued.filter((m) => m.id !== id);
    this.changed();
  }

  handOverQueue() {}

  retry() {
    const last = [...this.state.items].reverse().find((i) => i.kind === 'user');
    if (!last || last.kind !== 'user') return;
    this.send(last.text, last.images.map((data) => ({ data, mime: /^data:([^;]+);/.exec(data)?.[1] ?? 'image/png' })), 'later');
  }

  loadEarlier() {}

  addNote(text: string) {
    this.notes.push(`<steerhouse-note>\n${text}\n</steerhouse-note>`);
  }

  attachContext(text: string, label: string) {
    this.state.items.push({ kind: 'system', id: uid(), text: label, ts: new Date().toISOString() });
    this.addNote(text);
    this.changed();
  }

  runShell(command: string) {
    const id = uid();
    const item: Extract<ChatItem, { kind: 'shell' }> = { kind: 'shell', id, command, output: '', status: 'running' };
    this.state.items.push(item);
    this.changed();
    const run = new ShellRun(
      command,
      { cwd: this.opts.cwd, env: { ...process.env, ...(this.opts.env ?? {}) } },
      () => {
        item.output = run.output;
        this.changed();
      },
      (r) => {
        this.shells.delete(id);
        item.status = r.error || (r.exitCode ?? 0) !== 0 ? 'error' : 'done';
        item.exitCode = r.exitCode;
        item.error = r.error;
        item.output = run.output;
        this.addNote(`The user ran \`${command}\` in their shell (exit ${r.exitCode ?? '?'}):\n${clip(run.output, 4000)}`);
        this.changed();
      },
    );
    this.shells.set(id, run);
  }

  stopShell(id: string) {
    this.shells.get(id)?.stop();
  }

  liveSummary() {
    return `Status: ${this.state.status}`;
  }

  askAside(question: string) {
    if (!question.trim()) return;
    this.state.items.push({ kind: 'aside', id: uid(), question, answer: '', error: `Side questions are not available for ${this.opts.runtime.label} yet.` });
    this.changed();
  }

  dismissAside(id: string) {
    this.state.items = this.state.items.filter((i) => !(i.kind === 'aside' && i.id === id));
    this.changed();
  }

  async interrupt() {
    if (this.state.status === 'working' || this.state.status === 'waiting') this.stopping = true;
    for (const id of this.pending) this.respond(id, 'deny', 'Interrupted by the user');
    await this.session?.interrupt();
  }

  respond(id: string, decision: 'allow' | 'always' | 'deny', message?: string, answers?: Record<string, string>) {
    if (!this.pending.delete(id)) return;
    this.session?.respond(id, decision === 'always' ? 'allowAlways' : decision, { reason: message, answers });
    const it = this.state.items.find((x) => x.id === id);
    if (it?.kind === 'permission') {
      it.status = decision === 'deny' ? 'denied' : 'allowed';
      if (message && decision === 'deny') it.reason = message;
    }
    if (it?.kind === 'question') {
      it.status = 'answered';
      it.answers = answers;
    }
    if (!this.pending.size && this.state.status === 'waiting') {
      this.state.status = 'working';
      this.state.activity = 'Thinking…';
    }
    this.changed();
  }

  async setModel(model: string) {
    await this.session?.setModel?.(model);
    this.state.model = model;
    this.changed();
  }

  close() {
    for (const run of this.shells.values()) run.stop();
    this.session?.close();
    this.state.status = 'closed';
  }

  // ---------------------------------------------------------------- Claude-only: not offered (caps), harmless if called

  async setEffort(_e: Effort) {}
  async setFastMode(_on: boolean) {}
  async setUltracode(_on: boolean) {}
  async setPermissionMode(_m: ChatState['permissionMode']) {}
  async contextDetail() {}
  async refreshMcp() {}
  async toggleMcp(_name: string, _enabled: boolean) {}
  async addMcp(_name: string, _config: Record<string, unknown>) {}
  async reconnectMcp(_name: string) {}
  refreshLimits() {}
  async rewindFilesTo(_id: string) {
    return { ok: false, error: `${this.opts.runtime.label} chats cannot restore files yet` };
  }
  allowRule(_id: string, _rule: string) {
    return '';
  }
  taskFile() {
    return undefined;
  }
  taskOutput(_id: string) {
    return { text: '', size: 0, missing: true };
  }
  async stopTask(_id: string) {}
}

export const isRuntimeChat = (c: unknown): boolean => c instanceof RuntimeChat;
/** The chat as a RuntimeChat, when it is one (the panel holds both kinds as ChatSession). */
export const asRuntimeChat = (c: unknown): RuntimeChat | undefined => (c instanceof RuntimeChat ? c : undefined);
