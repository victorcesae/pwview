// AgentLens chat: Claude Code driven through the Claude Agent SDK instead of a terminal.
// Uses the user's own Claude Code CLI (and therefore its login: subscription, API key,
// Bedrock/Vertex...). Messages carry a native priority: later = queue, next = steer
// (picked up between steps), now = send now.
import { query, type PermissionMode, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Priority = 'later' | 'next' | 'now';
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string };

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: string[]; priority?: Priority; ts: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; parent?: string; msg?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; status: 'running' | 'done' | 'error'; result?: string; file?: string; patch?: Hunk[]; parent?: string; elapsed?: number }
  | { kind: 'permission'; id: string; tool: string; summary: string; input: unknown; canAlways: boolean; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'plan'; id: string; plan: string; status: 'pending' | 'approved' | 'rejected' }
  | { kind: 'question'; id: string; questions: Question[]; status: 'pending' | 'answered'; answers?: Record<string, string> }
  | { kind: 'result'; id: string; text: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'system'; id: string; text: string };

export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };

export interface ChatState {
  key: string;
  sessionId?: string;
  cwd: string;
  title: string;
  model?: string;
  models: { value: string; displayName: string }[];
  permissionMode: PermissionMode;
  effort?: Effort;
  fastMode: boolean;
  ultracode: boolean;
  status: 'starting' | 'idle' | 'working' | 'waiting' | 'closed' | 'error';
  activity?: string;
  todos: Todo[];
  items: ChatItem[];
  queue: { id: string; text: string; images: number; priority: 'later' | 'next' }[];
  slashCommands: string[];
  /** connectors (MCP servers) available in this session */
  mcp: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; tools: number; error?: string }[];
  costUsd: number;
  /** history items not loaded yet (older than what is shown) */
  earlier: number;
  /** All tokens this chat used (input + output + cache), from each turn's usage. */
  tokens?: number;
  /** Context window usage after the last turn (for the ring next to the input). */
  context?: { used: number; max: number; percentage: number; detailed?: boolean; categories?: { id?: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[] };
  /** Which Claude account this session runs on (name from AgentLens, details from Claude Code). */
  account: { name: string; email?: string; organization?: string; plan?: string; provider?: string; gateway?: string };
  host?: string;
  error?: string;
}

type Img = { data: string; mime: string };

/** Single-consumer async queue feeding the SDK's streaming input. */
class Channel<T> {
  private q: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    const w = this.waiting.shift();
    if (w) w({ value: v, done: false });
    else this.q.push(v);
  }
  close() {
    this.closed = true;
    this.waiting.splice(0).forEach((w) => w({ value: undefined as never, done: true }));
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () =>
        this.q.length
          ? Promise.resolve({ value: this.q.shift()!, done: false })
          : this.closed
            ? Promise.resolve({ value: undefined as never, done: true })
            : new Promise((r) => this.waiting.push(r)),
    };
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What the agent is doing, in words ("Searching…", "Reading foo.ts…"). */
export function describe(name: string, input: any): string {
  switch (name) {
    case 'Grep':
      return `Searching for "${clip(str(input?.pattern), 40)}"…`;
    case 'Glob':
      return `Finding files ${clip(str(input?.pattern), 40)}…`;
    case 'Read':
      return `Reading ${base(str(input?.file_path))}…`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(str(input?.file_path))}…`;
    case 'Write':
      return `Writing ${base(str(input?.file_path))}…`;
    case 'Bash':
    case 'PowerShell':
      return `Running ${clip(str(input?.description) || str(input?.command), 60)}…`;
    case 'WebSearch':
      return `Searching the web for "${clip(str(input?.query), 40)}"…`;
    case 'WebFetch':
      return `Reading ${clip(str(input?.url), 50)}…`;
    case 'Agent':
    case 'Task':
      return `Sub-agent: ${clip(str(input?.description), 50)}…`;
    case 'TodoWrite':
      return 'Updating the plan…';
    default:
      return `${name}…`;
  }
}

function summary(name: string, input: any): string {
  const f = (k: string) => str(input?.[k]);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return f('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return f('file_path');
    case 'Grep':
      return `${f('pattern')}${f('path') ? `  in ${f('path')}` : ''}`;
    case 'Glob':
      return f('pattern');
    case 'Agent':
    case 'Task':
      return f('description');
    case 'WebFetch':
      return f('url');
    case 'WebSearch':
      return f('query');
    default:
      return clip(JSON.stringify(input ?? {}), 160);
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

const NOISE = ['<system-reminder>', '<local-command', '<command-', 'Caveat:', '[Request interrupted'];

/** Rebuild the conversation from a session transcript (JSONL) so resumed chats show their history. */
export function historyFromTranscript(file: string): { items: ChatItem[]; todos: Todo[]; title?: string } {
  const items: ChatItem[] = [];
  let todos: Todo[] = [];
  let title: string | undefined;
  let text = '';
  try {
    text = require('fs').readFileSync(file, 'utf8');
  } catch {
    return { items, todos };
  }
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'custom-title') title = rec.customTitle;
    if (rec.isSidechain || rec.isMeta) continue;
    // messages sent while the agent was working are stored as queued commands, not user records
    if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
      const p = rec.attachment.prompt;
      const blocks: any[] = typeof p === 'string' ? [{ type: 'text', text: p }] : p ?? [];
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      const images = blocks.filter((b) => b?.type === 'image' && b.source?.type === 'base64').map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
      if ((text && !NOISE.some((n) => text.startsWith(n))) || images.length)
        items.push({ kind: 'user', id: rec.uuid ?? uid(), text, images, priority: 'next', ts: rec.timestamp ?? rec.attachment.timestamp ?? '' });
      continue;
    }
    const content = rec.message?.content;
    if (rec.type === 'user') {
      const texts: string[] = [];
      const images: string[] = [];
      for (const c of typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []) {
        if (c.type === 'text' && !NOISE.some((n) => String(c.text).trimStart().startsWith(n))) texts.push(c.text);
        else if (c.type === 'image' && c.source?.type === 'base64') images.push(`data:${c.source.media_type};base64,${c.source.data}`);
        else if (c.type === 'tool_result') {
          const t = tools.get(c.tool_use_id);
          if (!t) continue;
          t.status = c.is_error ? 'error' : 'done';
          t.result = clip(resultText(c.content), 6000);
          const r = rec.toolUseResult;
          if (r && Array.isArray(r.structuredPatch)) t.patch = r.structuredPatch;
        }
      }
      if (texts.join('').trim() || images.length) items.push({ kind: 'user', id: rec.uuid ?? uid(), text: texts.join('\n').trim(), images, ts: rec.timestamp ?? '' });
    } else if (rec.type === 'assistant') {
      for (const c of content ?? []) {
        if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'assistant', id: uid(), text: c.text });
        else if (c.type === 'tool_use' && !tools.has(c.id)) {
          if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) todos = c.input.todos;
          const t: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: c.id, name: c.name, summary: summary(c.name, c.input), input: c.input, status: 'done', file: str(c.input?.file_path) || undefined };
          tools.set(c.id, t);
          items.push(t);
        }
      }
    }
  }
  return { items, todos, title };
}

const toCategories = (u: any) => (u.categories ?? []).filter((c: any) => c.tokens > 0).map((c: any) => ({ id: c.id, name: c.name, tokens: c.tokens, kind: c.kind }));

/** How many history items a resumed chat shows at first, and loads per "Load earlier". */
export const HISTORY_PAGE = 300;

export interface ChatOptions {
  cwd: string;
  executable?: string;
  resume?: string;
  model?: string;
  permissionMode?: PermissionMode;
  title?: string;
  history?: { items: ChatItem[]; todos: Todo[] };
  /** Account: its name and env (CLAUDE_CONFIG_DIR) */
  account?: { name: string; env: Record<string, string>; provider?: string };
  /** editor the chat runs in (Visual Studio Code, Cursor…) */
  host?: string;
}

export class ChatSession {
  readonly state: ChatState;
  private input = new Channel<SDKUserMessage>();
  private q?: Query;
  private queued: { id: string; text: string; images: Img[]; priority: 'later' | 'next' }[] = [];
  private pending = new Map<string, (r: PermissionResult) => void>();
  private streaming = new Map<string, string>(); // `${parent}:${msgId}:${index}` → item id
  private currentMsg = new Map<string, string>(); // parent → message id being streamed
  private abort = new AbortController();
  /** per streamed message: how many of its text blocks the final messages already matched */
  private claimed = new Map<string, number>();
  /** Completed turns (one per result message). */
  turns = 0;

  constructor(
    private opts: ChatOptions,
    private onChange: (s: ChatState) => void,
  ) {
    this.state = {
      key: uid(),
      sessionId: opts.resume,
      cwd: opts.cwd,
      title: opts.title ?? 'New chat',
      models: [],
      permissionMode: opts.permissionMode ?? 'default',
      fastMode: false,
      ultracode: false,
      status: 'starting',
      todos: opts.history?.todos ?? [],
      items: opts.history ? [...opts.history.items.slice(-HISTORY_PAGE), { kind: 'system', id: uid(), text: 'Resumed: earlier conversation above' }] : [],
      earlier: Math.max(0, (opts.history?.items.length ?? 0) - HISTORY_PAGE),
      queue: [],
      slashCommands: [],
      mcp: [],
      costUsd: 0,
      account: { name: opts.account?.name ?? 'Default', gateway: opts.account?.provider },
      host: opts.host,
    };
  }

  private changed() {
    this.state.queue = this.queued.map((m) => ({ id: m.id, text: m.text, images: m.images.length, priority: m.priority }));
    this.onChange(this.state);
  }

  start() {
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.opts.cwd,
        resume: this.opts.resume,
        model: this.opts.model,
        permissionMode: this.state.permissionMode,
        includePartialMessages: true,
        abortController: this.abort,
        pathToClaudeCodeExecutable: this.opts.executable,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: { ...process.env, ...(this.opts.account?.env ?? {}), CLAUDE_AGENT_SDK_CLIENT_APP: 'agentlens' },
        canUseTool: (tool, input, o) => this.ask(tool, input, o.suggestions, o.signal),
      },
    });
    this.loop().catch((e) => {
      this.state.status = 'error';
      this.state.error = String(e?.message ?? e);
      this.changed();
    });
    this.q
      .supportedModels()
      .then((ms) => {
        this.state.models = ms.map((m: any) => ({ value: m.value, displayName: m.displayName ?? m.value }));
        this.changed();
      })
      .catch(() => {});
    // ready now (init only arrives with the first message); resumed chats get their context at once
    this.state.status = 'idle';
    this.q.getContextUsage({ detail: 'summary' }).then((u: any) => {
      this.state.context = { used: u.totalTokens, max: u.maxTokens, percentage: u.percentage, categories: toCategories(u) };
      this.changed();
    }).catch(() => {});
    this.q
      .accountInfo()
      .then((a: any) => {
        this.state.account = { ...this.state.account, email: a.email, organization: a.organization, plan: a.subscriptionType, provider: a.apiProvider };
        this.changed();
      })
      .catch(() => {});
    this.changed();
  }

  // ------------------------------------------------------------------ sending

  /**
   * While the agent works, Steer (next) and Queue (later) messages wait here, where they can still
   * be edited, cancelled or switched. Steer is handed over when the agent starts its next step,
   * Queue when the turn ends. Send now (now) goes in immediately.
   */
  send(text: string, images: Img[], priority: Priority) {
    if (!text.trim() && !images.length) return;
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    if (working && priority !== 'now') {
      const id = uid();
      this.queued.push({ id, text, images, priority });
      if (priority === 'next') this.armSteer(id);
      this.changed();
      return;
    }
    this.push(text, images, working ? priority : 'later');
  }

  /** Edit a message that hasn't been handed over yet. */
  editQueued(id: string, text: string) {
    const m = this.queued.find((x) => x.id === id);
    if (!m || !text.trim()) return;
    m.text = text;
    this.changed();
  }

  /**
   * A steer waits only a short undo window (edit / cancel / switch), then goes in at once.
   * Measured against the real CLI: handing it over immediately is what makes the agent follow
   * it within the running turn; waiting for a step boundary often arrives too late.
   */
  steerGraceMs = 3000;
  private steerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private armSteer(id: string) {
    clearTimeout(this.steerTimers.get(id));
    this.steerTimers.set(
      id,
      setTimeout(() => {
        this.steerTimers.delete(id);
        const i = this.queued.findIndex((m) => m.id === id && m.priority === 'next');
        if (i < 0) return;
        const [m] = this.queued.splice(i, 1);
        this.push(m.text, m.images, 'next');
      }, this.steerGraceMs),
    );
  }
  private disarm(id: string) {
    clearTimeout(this.steerTimers.get(id));
    this.steerTimers.delete(id);
  }

  private flushSteers() {
    for (const m of this.queued) if (m.priority === 'next') this.disarm(m.id);
    const steers = this.queued.filter((m) => m.priority === 'next');
    if (!steers.length) return;
    this.queued = this.queued.filter((m) => m.priority !== 'next');
    for (const m of steers) this.push(m.text, m.images, 'next');
  }

  /** Load older history (one page, or everything with all=true, e.g. to search it). */
  loadEarlier(all = false) {
    const older = this.opts.history?.items ?? [];
    const n = this.state.earlier;
    if (!n) return;
    const take = all ? n : Math.min(HISTORY_PAGE, n);
    this.state.items.unshift(...older.slice(n - take, n));
    this.state.earlier = n - take;
    this.changed();
  }

  /** Re-send the last thing the user asked (text + images). */
  retry() {
    const last = [...this.state.items].reverse().find((i) => i.kind === 'user');
    if (!last || last.kind !== 'user') return;
    const images = last.images.map((data) => ({ data, mime: /^data:([^;]+);/.exec(data)?.[1] ?? 'image/png' }));
    this.send(last.text, images, 'later');
  }

  /** Send a waiting message now, or switch it between Steer and Queue. */
  promote(id: string, priority: Priority = 'now') {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (priority !== 'now') {
      this.queued[i].priority = priority;
      if (priority === 'next') this.armSteer(id);
      else this.disarm(id);
      this.changed();
      return;
    }
    this.disarm(id);
    const [m] = this.queued.splice(i, 1);
    this.push(m.text, m.images, 'now');
  }

  cancelQueued(id: string) {
    this.disarm(id);
    this.queued = this.queued.filter((m) => m.id !== id);
    this.changed();
  }

  private push(text: string, images: Img[], priority: Priority) {
    const content: any[] = images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mime, data: img.data.replace(/^data:[^;]+;base64,/, '') },
    }));
    if (text.trim()) content.push({ type: 'text', text });
    this.state.items.push({ kind: 'user', id: uid(), text, images: images.map((i) => i.data), priority, ts: new Date().toISOString() });
    if (this.state.title === 'New chat' && text.trim()) this.state.title = clip(text.trim().split('\n')[0], 60);
    this.state.status = 'working';
    this.state.activity = priority === 'now' ? 'Switching to your message…' : this.state.activity ?? 'Thinking…';
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority } as SDKUserMessage);
    this.changed();
  }

  /** Give the agent context (e.g. a linked session): shown as a system note, delivered between steps. */
  attachContext(text: string, label: string) {
    this.state.items.push({ kind: 'system', id: uid(), text: label });
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: working ? 'next' : 'later' } as SDKUserMessage);
    if (!working) {
      this.state.status = 'working';
      this.state.activity = 'Reading the linked session…';
    }
    this.changed();
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => {});
    for (const [id, resolve] of this.pending) {
      resolve({ behavior: 'deny', message: 'Interrupted by the user', interrupt: true });
      this.mark(id, 'denied');
    }
    this.pending.clear();
  }

  async setModel(model: string) {
    await this.q?.setModel(model);
    this.state.model = model;
    this.changed();
  }

  /** Exact per-category context breakdown (counts with the token API), for the context panel. */
  async contextDetail() {
    const u: any = await this.q?.getContextUsage({ detail: 'full' });
    if (!u) return;
    this.state.context = { used: u.totalTokens, max: u.maxTokens, percentage: u.percentage, detailed: true, categories: toCategories(u) };
    this.changed();
  }

  /** Connectors: refresh their status, turn one on or off, or reconnect a failed one. */
  async refreshMcp() {
    try {
      const list: any[] = (await this.q?.mcpServerStatus()) ?? [];
      this.state.mcp = list.map((s) => ({ name: s.name, status: s.status, tools: s.tools?.length ?? 0, error: s.error }));
      this.changed();
    } catch {
      /* older CLI */
    }
  }
  async toggleMcp(name: string, enabled: boolean) {
    await this.q?.toggleMcpServer(name, enabled);
    await this.refreshMcp();
  }
  async reconnectMcp(name: string) {
    await this.q?.reconnectMcpServer(name);
    await this.refreshMcp();
  }

  /** Effort, fast mode and ultracode, applied to the running session (flag settings layer). */
  async setEffort(effort: Effort) {
    // sent with ultracode so changing the level keeps ultracode as it is
    await this.q?.applyFlagSettings({ effortLevel: effort, ultracode: this.state.ultracode } as any);
    this.state.effort = effort;
    this.changed();
  }

  async setFastMode(on: boolean) {
    await this.q?.applyFlagSettings({ fastMode: on } as any);
    this.state.fastMode = on;
    this.changed();
  }

  async setUltracode(on: boolean) {
    await this.q?.applyFlagSettings({ ultracode: on } as any);
    this.state.ultracode = on;
    this.changed();
  }

  async setPermissionMode(mode: PermissionMode) {
    await this.q?.setPermissionMode(mode);
    this.state.permissionMode = mode;
    this.changed();
  }

  close() {
    this.input.close();
    this.abort.abort();
    this.state.status = 'closed';
  }

  // ------------------------------------------------------------------ permissions, plans, questions

  private ask(tool: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined, signal: AbortSignal): Promise<PermissionResult> {
    const id = uid();
    if (tool === 'ExitPlanMode') {
      this.state.items.push({ kind: 'plan', id, plan: str(input.plan) || JSON.stringify(input, null, 2), status: 'pending' });
    } else if (tool === 'AskUserQuestion') {
      this.state.items.push({ kind: 'question', id, questions: (input.questions as Question[]) ?? [], status: 'pending' });
    } else {
      this.state.items.push({ kind: 'permission', id, tool, summary: summary(tool, input), input, canAlways: !!suggestions?.length, status: 'pending' });
    }
    this.state.status = 'waiting';
    this.state.activity = tool === 'ExitPlanMode' ? 'Waiting for you to approve the plan' : tool === 'AskUserQuestion' ? 'Waiting for your answer' : `Waiting for permission: ${tool}`;
    this.changed();
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, (r) => {
        this.pending.delete(id);
        this.state.status = 'working';
        this.state.activity = 'Thinking…';
        resolve(r);
      });
      (this as any)[`ctx_${id}`] = { input, suggestions };
      signal.addEventListener('abort', () => {
        this.pending.delete(id);
        this.mark(id, 'denied');
      });
    });
  }

  private mark(id: string, status: 'allowed' | 'denied') {
    const it = this.state.items.find((x) => x.id === id);
    if (it?.kind === 'permission') it.status = status;
    if (it?.kind === 'plan') it.status = status === 'allowed' ? 'approved' : 'rejected';
    if (it?.kind === 'question') it.status = 'answered';
    this.changed();
  }

  respond(id: string, decision: 'allow' | 'always' | 'deny', message?: string, answers?: Record<string, string>) {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    const ctx = (this as any)[`ctx_${id}`] as { input: Record<string, unknown>; suggestions?: PermissionUpdate[] };
    delete (this as any)[`ctx_${id}`];
    const it = this.state.items.find((x) => x.id === id);
    if (it?.kind === 'question' && answers) {
      it.answers = answers;
      resolve({ behavior: 'allow', updatedInput: { ...ctx.input, answers } });
      this.mark(id, 'allowed');
      return;
    }
    if (decision === 'deny') {
      if (it?.kind === 'permission' && message) it.reason = message;
      resolve({ behavior: 'deny', message: message || 'The user denied this.' });
      this.mark(id, 'denied');
      return;
    }
    resolve({ behavior: 'allow', updatedInput: ctx.input, updatedPermissions: decision === 'always' ? ctx.suggestions : undefined });
    this.mark(id, 'allowed');
  }

  // ------------------------------------------------------------------ SDK stream → UI state

  private async loop() {
    for await (const m of this.q!) this.handle(m);
    this.state.status = 'closed';
    this.changed();
  }

  private tool(id: string) {
    const it = this.state.items.find((x) => x.kind === 'tool' && x.id === id);
    return it?.kind === 'tool' ? it : undefined;
  }

  private handle(m: SDKMessage) {
    const parent = ('parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : null) ?? undefined;
    switch (m.type) {
      case 'system': {
        if (m.subtype === 'init') {
          this.state.sessionId = m.session_id;
          if (this.state.status === 'starting') this.state.status = 'idle';
          this.refreshMcp();
          this.state.model = m.model;
          this.state.permissionMode = m.permissionMode;
          this.state.slashCommands = m.slash_commands ?? [];
          const init: any = m;
          if (init.effort) this.state.effort = init.effort;
          if (init.fast_mode_state) this.state.fastMode = init.fast_mode_state === 'on';
        } else if (m.subtype === 'status') {
          if (m.status === 'compacting') this.state.activity = 'Compacting the conversation…';
          if (m.permissionMode) this.state.permissionMode = m.permissionMode;
        }
        break;
      }
      case 'stream_event': {
        const e: any = m.event;
        const key = parent ?? '';
        if (e.type === 'message_start') {
          this.currentMsg.set(key, e.message?.id ?? uid());
          if (!parent) this.state.activity = 'Thinking…';
        } else if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
          const id = uid();
          this.streaming.set(`${key}:${this.currentMsg.get(key)}:${e.index}`, id);
          this.state.items.push({ kind: 'assistant', id, text: '', streaming: true, parent, msg: this.currentMsg.get(key) });
          if (!parent) this.state.activity = 'Writing…';
        } else if (e.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta') {
            const id = this.streaming.get(`${key}:${this.currentMsg.get(key)}:${e.index}`);
            const it = this.state.items.find((x) => x.id === id);
            if (it?.kind === 'assistant') it.text += e.delta.text;
          } else if (e.delta?.type === 'thinking_delta' && !parent) this.state.activity = 'Thinking…';
        }
        break;
      }
      case 'assistant': {
        const key = parent ?? '';
        const msgId = (m.message as any).id;
        // The CLI can send one reply as several assistant messages (one per block) whose block
        // indexes differ from the stream's, so match streamed text by message id and order.
        const streamed = this.state.items.filter((x): x is Extract<ChatItem, { kind: 'assistant' }> => x.kind === 'assistant' && x.msg === msgId && x.parent === parent);
        const claimed = this.claimed.get(msgId) ?? 0;
        let next = claimed;
        (m.message.content as any[]).forEach((c, index) => {
          if (c.type === 'text') {
            const byIndex = this.streaming.get(`${key}:${msgId}:${index}`);
            const it = (byIndex && this.state.items.find((x) => x.id === byIndex && x.kind === 'assistant' && x.streaming)) || streamed[next];
            if (it && it.kind === 'assistant') {
              it.text = c.text;
              it.streaming = false;
              if (it === streamed[next]) next++;
            } else if (c.text.trim()) {
              const last = [...this.state.items].reverse().find((x) => x.kind === 'assistant' && x.parent === parent);
              if (!(last && last.kind === 'assistant' && last.text.trim() === c.text.trim()))
                this.state.items.push({ kind: 'assistant', id: uid(), text: c.text, parent, msg: msgId });
            }
          } else if (c.type === 'tool_use') {
            if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) this.state.todos = c.input.todos;
            if (!this.tool(c.id))
              this.state.items.push({ kind: 'tool', id: c.id, name: c.name, summary: summary(c.name, c.input), input: c.input, status: 'running', parent, file: str(c.input?.file_path) || undefined });
            if (!parent || c.name === 'Agent') this.state.activity = describe(c.name, c.input);
          }
        });
        this.claimed.set(msgId, next);
        break;
      }
      case 'user': {
        const content = (m.message as any).content;
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (c?.type !== 'tool_result') continue;
          const t = this.tool(c.tool_use_id);
          if (!t) continue;
          t.status = c.is_error ? 'error' : 'done';
          t.result = clip(resultText(c.content), 6000);
          const r: any = (m as any).tool_use_result;
          if (r && Array.isArray(r.structuredPatch)) t.patch = r.structuredPatch;
          if (r?.filePath) t.file = r.filePath;
        }
        if (this.state.status === 'working') this.state.activity = 'Thinking…';
        break;
      }
      case 'tool_progress': {
        const t = this.tool(m.tool_use_id);
        if (t) t.elapsed = m.elapsed_time_seconds;
        break;
      }
      case 'result': {
        this.turns++;
        const r: any = m;
        this.state.costUsd += r.total_cost_usd ?? 0;
        const u = r.usage ?? {};
        this.state.tokens = (this.state.tokens ?? 0) + (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (r.subtype !== 'success' || r.is_error)
          this.state.items.push({ kind: 'result', id: uid(), text: str(r.result) || r.subtype, isError: true, durationMs: r.duration_ms });
        for (const it of this.state.items) if (it.kind === 'assistant') it.streaming = false;
        for (const it of this.state.items) if (it.kind === 'tool' && it.status === 'running' && !it.parent) it.status = 'done';
        this.state.status = 'idle';
        this.state.activity = undefined;
        this.q
          ?.getContextUsage({ detail: 'summary' })
          .then((u: any) => {
            this.state.context = {
              used: u.totalTokens,
              max: u.maxTokens,
              percentage: u.percentage,
              categories: toCategories(u),
            };
            this.changed();
          })
          .catch(() => {});
        // the turn ended: steers that never found a next step go first, then the next queued message
        const steers = this.queued.filter((q) => q.priority === 'next');
        const handover = steers.length ? steers : this.queued.slice(0, 1);
        this.queued = this.queued.filter((q) => !handover.includes(q));
        for (const q of handover) this.push(q.text, q.images, 'later');
        break;
      }
    }
    this.changed();
  }
}
