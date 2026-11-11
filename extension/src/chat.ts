// Steerhouse chat: Claude Code driven through the Claude Agent SDK instead of a terminal.
// Uses the user's own Claude Code CLI (and therefore its login: subscription, API key,
// Bedrock/Vertex...). Messages carry a native priority: later = queue, next = steer
// (picked up between steps), now = send now.
import { BgTaskTracker, guessStatus, parseStarted, readTail, sdkStatus, sessionTasksDir, textsOf, type BgTask } from './bgtasks';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { findRelay, RelayProcess, startRelay } from './relayClient';
import { ShellRun, shellContext, withoutShellContext } from './shell';
import { query, type PermissionMode, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Priority = 'later' | 'next' | 'now';
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string };

export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: string[]; priority?: Priority; ts: string; /** transcript entry just before this message: fork here to run it again */ forkAt?: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; parent?: string; msg?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; status: 'running' | 'done' | 'error'; result?: string; images?: string[]; file?: string; patch?: Hunk[]; parent?: string; elapsed?: number }
  | { kind: 'shell'; id: string; command: string; output: string; status: 'running' | 'done' | 'error'; exitCode?: number | null; error?: string }
  | { kind: 'permission'; id: string; tool: string; summary: string; input: unknown; canAlways: boolean; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'plan'; id: string; plan: string; status: 'pending' | 'approved' | 'rejected' }
  | { kind: 'question'; id: string; questions: Question[]; status: 'pending' | 'answered'; answers?: Record<string, string> }
  | { kind: 'result'; id: string; text: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'system'; id: string; text: string }
  /** a subagent's final report, or a background task ending (Claude Code injects these as user turns) */
  /** auto mode's classifier refused a tool call: it never asks, so this is where the user can allow it */
  | { kind: 'blocked'; id: string; tool: string; command: string; reason: string; rule?: string; status?: 'allowed' }
  | { kind: 'agentReport'; id: string; from: string; title?: string; text?: string; status?: string; ts?: string };

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
  /** Claude Code's guess at what you will ask next (after a turn) */
  suggestion?: string;
  /** prompts you put aside (shared by all chats) */
  stash?: string[];
  /** commands the agent left running in the background (dev servers, watchers…) */
  tasks: BgTask[];
  /** All tokens this chat used (input + output + cache), from each turn's usage. */
  tokens?: number;
  /** Context window usage after the last turn (for the ring next to the input). */
  context?: { used: number; max: number; percentage: number; detailed?: boolean; categories?: { id?: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[] };
  /** Which Claude account this session runs on (name from Steerhouse, details from Claude Code). */
  account: { name: string; email?: string; organization?: string; plan?: string; provider?: string; gateway?: string };
  host?: string;
  /** the editor's own icon (data: URI) */
  hostIcon?: string;
  /** Subscription limits (Claude plan windows, or a provider key's credit), for the ring by the input. */
  limits?: Limits;
  error?: string;
}

export interface LimitWindow {
  id: string;
  label: string;
  /** 0-100 */
  pct: number;
  resetsAt?: string;
}
export interface Limits {
  /** false: no plan limits apply (API key, Bedrock, Vertex, a gateway without a usage API) */
  available: boolean;
  plan?: string;
  windows: LimitWindow[];
  /** pay-as-you-go credit on top of the plan, or a provider key's spend */
  extra?: { used: number; limit?: number; currency?: string; label: string };
  source: 'claude' | 'openrouter' | 'none';
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: 'Current session (5h)',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_oauth_apps: 'Weekly · apps',
};

/** Turns the SDK's /usage answer into display windows. */
export function limitsFromUsage(u: any): Limits {
  const rl = u?.rate_limits;
  if (!u?.rate_limits_available || !rl) return { available: false, plan: u?.subscription_type ?? undefined, windows: [], source: 'none' };
  const windows: LimitWindow[] = [];
  for (const id of Object.keys(WINDOW_LABEL)) {
    const w = rl[id];
    if (w && typeof w.utilization === 'number') windows.push({ id, label: WINDOW_LABEL[id], pct: w.utilization, resetsAt: w.resets_at ?? undefined });
  }
  for (const m of rl.model_scoped ?? []) if (typeof m.utilization === 'number') windows.push({ id: 'model:' + m.display_name, label: 'Weekly · ' + m.display_name, pct: m.utilization, resetsAt: m.resets_at ?? undefined });
  const x = rl.extra_usage;
  const extra = x?.is_enabled && typeof x.used_credits === 'number' ? { used: x.used_credits, limit: x.monthly_limit ?? undefined, currency: x.currency ?? undefined, label: 'Extra usage this month' } : undefined;
  return { available: true, plan: u.subscription_type ?? undefined, windows, extra, source: 'claude' };
}

/** OpenRouter keys report their own spend and limit (documented GET /api/v1/key). */
export async function openRouterLimits(env: Record<string, string | undefined>): Promise<Limits | undefined> {
  const base = env.ANTHROPIC_BASE_URL ?? '';
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!/openrouter\.ai/i.test(base) || !key) return undefined;
  const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return undefined;
  const d: any = ((await r.json()) as any)?.data ?? {};
  const limit = typeof d.limit === 'number' ? d.limit : undefined;
  return {
    available: true,
    windows: limit ? [{ id: 'credit', label: 'Key credit', pct: Math.min(100, ((d.usage ?? 0) / limit) * 100), resetsAt: undefined }] : [],
    extra: { used: d.usage ?? 0, limit, currency: 'USD', label: 'OpenRouter spend' },
    source: 'openrouter',
  };
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

/** Pictures a tool returned (reading a .png, a screenshot) are shown; past these limits, a note instead. */
const MAX_TOOL_IMAGES = 4;
const MAX_TOOL_IMAGE_CHARS = 6 * 1024 * 1024;
export function resultImages(content: unknown): { images: string[]; skipped: number } {
  const all = Array.isArray(content) ? content.filter((c: any) => c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') : [];
  const fit = all.filter((c: any) => c.source.data.length <= MAX_TOOL_IMAGE_CHARS).slice(0, MAX_TOOL_IMAGES);
  return { images: fit.map((c: any) => `data:${c.source.media_type ?? 'image/png'};base64,${c.source.data}`), skipped: all.length - fit.length };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const { skipped } = resultImages(content);
  const text = content.map((c: any) => (c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
  return skipped ? [text, `[${skipped} image(s) too large to show]`].filter(Boolean).join('\n') : text;
}

/** Claude Code delivers a subagent's hand-back and task endings as user turns: recognise them so they
 *  are not shown as something the user typed. */
export function agentNotice(text: string, ts?: string, items: ChatItem[] = []): Extract<ChatItem, { kind: 'agentReport' }>[] {
  // the Agent call that launched it says "agentId: <id>"; its description names it
  const named = (id: string) => {
    const t = items.find((x) => x.kind === 'tool' && (x.name === 'Agent' || x.name === 'Task') && x.result?.includes(`agentId: ${id}`));
    return t?.kind === 'tool' ? str((t.input as any)?.description) || undefined : undefined;
  };
  const out: Extract<ChatItem, { kind: 'agentReport' }>[] = [];
  for (const m of text.matchAll(/<agent-message from="([^"]*)"[^>]*>([\s\S]*?)(?:<\/agent-message>|$)/g)) {
    let body = m[2];
    const f = body.indexOf('The report follows:');
    if (f >= 0) body = body.slice(f + 'The report follows:'.length).replace(/^\r?\n/, '').replace(/^  /gm, '');
    out.push({ kind: 'agentReport', id: uid(), from: m[1], title: named(m[1]), text: body.trim(), ts });
  }
  for (const b of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []) {
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(b)?.[1]?.trim();
    out.push({ kind: 'agentReport', id: uid(), from: tag('task-id') ?? '', title: tag('summary'), status: tag('status'), ts });
  }
  return out;
}
const isNotice = (t: string) => /^\s*(Another Claude session sent a message:\s*)?<(agent-message|task-notification)\b/.test(t);

/** The permission rule that allows commands like this one: the program and its subcommand. */
export function ruleFor(tool: string, input: any): string | undefined {
  if (tool !== 'Bash' && tool !== 'PowerShell') return tool.startsWith('mcp__') || ['WebFetch', 'WebSearch', 'Write', 'Edit'].includes(tool) ? tool : undefined;
  const cmd = String(input?.command ?? '');
  // the step that matters, after any "cd somewhere &&"
  const step = cmd.split(/&&|;|\|\||\n/).map((x) => x.trim()).find((x) => x && !/^cd\s/.test(x));
  const words = step?.split(/\s+/).filter((w) => /^[\w.@/-]+$/.test(w) && !w.startsWith('-')) ?? [];
  if (!words.length) return undefined;
  // "gh pr merge", "git push", "npm publish": the program and its (sub)commands, not the arguments
  const n = ['gh', 'glab', 'az', 'gcloud', 'aws', 'kubectl', 'docker'].includes(words[0]) ? 3 : ['git', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'pip', 'uv'].includes(words[0]) ? 2 : 1;
  return `${tool}(${words.slice(0, n).join(' ')}:*)`;
}

/** Auto mode's classifier refusing a tool call reads like this in its result. */
export function autoModeBlock(t: Extract<ChatItem, { kind: 'tool' }>, result: string): Extract<ChatItem, { kind: 'blocked' }> | undefined {
  const m = /denied by the Claude Code auto mode classifier\.?\s*(?:Reason:\s*\[?([^\].\n]+)\]?)?/i.exec(result);
  if (!m) return undefined;
  return { kind: 'blocked', id: `blocked-${t.id}`, tool: t.name, command: t.name === 'Bash' || t.name === 'PowerShell' ? String((t.input as any)?.command ?? '') : t.summary, reason: (m[1] ?? '').trim(), rule: ruleFor(t.name, t.input) };
}

const NOISE = ['<system-reminder>', '<local-command', '<command-', 'Caveat:', '[Request interrupted'];

/** Rebuild the conversation from a session transcript (JSONL) so resumed chats show their history. */
export function historyFromTranscript(file: string): { items: ChatItem[]; todos: Todo[]; title?: string; model?: string; tasks?: BgTask[] } {
  const bg = new BgTaskTracker();
  const items: ChatItem[] = [];
  let todos: Todo[] = [];
  let title: string | undefined;
  let model: string | undefined;
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
      // the model of the last answer (Claude Code only reports it again after the next message)
      if (rec?.type === 'assistant' && typeof rec.message?.model === 'string' && !rec.message.model.startsWith('<')) model = rec.message.model;
    } catch {
      continue;
    }
    if (rec.type === 'custom-title') title = rec.customTitle;
    if (!rec.isSidechain && rec.type === 'user' && (rec.origin?.kind === 'peer' || rec.origin?.kind === 'task-notification')) {
      const t = textsOf(rec.message?.content);
      bg.text(t, rec.timestamp);
      items.push(...agentNotice(t, rec.timestamp, items));
      continue;
    }
    if (rec.isSidechain || rec.isMeta) continue;
    // messages sent while the agent was working are stored as queued commands, not user records
    if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
      const p = rec.attachment.prompt;
      const blocks: any[] = typeof p === 'string' ? [{ type: 'text', text: p }] : p ?? [];
      const text = withoutShellContext(blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')).trim();
      const images = blocks.filter((b) => b?.type === 'image' && b.source?.type === 'base64').map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
      if (rec.attachment.commandMode === 'task-notification' || isNotice(text)) {
        items.push(...agentNotice(text, rec.timestamp ?? rec.attachment.timestamp, items));
        continue;
      }
      if ((text && !NOISE.some((n) => text.startsWith(n))) || images.length)
        items.push({ kind: 'user', id: rec.uuid ?? uid(), text, images, priority: 'next', ts: rec.timestamp ?? rec.attachment.timestamp ?? '' });
      continue;
    }
    const content = rec.message?.content;
    if (rec.type === 'user' || rec.type === 'attachment' || rec.type === 'queue-operation') bg.text(textsOf(content ?? rec.attachment ?? rec.content), rec.timestamp);
    if (rec.type === 'user') {
      const texts: string[] = [];
      const images: string[] = [];
      for (const c of typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []) {
        if (c.type === 'text' && isNotice(String(c.text))) items.push(...agentNotice(String(c.text), rec.timestamp, items));
        else if (c.type === 'text' && !NOISE.some((n) => String(c.text).trimStart().startsWith(n))) texts.push(withoutShellContext(c.text));
        else if (c.type === 'image' && c.source?.type === 'base64') images.push(`data:${c.source.media_type};base64,${c.source.data}`);
        else if (c.type === 'tool_result') {
          bg.toolResult(c.tool_use_id, textsOf(c.content), rec.timestamp);
          const t = tools.get(c.tool_use_id);
          if (!t) continue;
          t.status = c.is_error ? 'error' : 'done';
          t.result = clip(resultText(c.content), 6000);
          const block = autoModeBlock(t, t.result);
          if (block) items.push(block);
          const pics = resultImages(c.content).images;
          if (pics.length) t.images = pics;
          const r = rec.toolUseResult;
          if (r && Array.isArray(r.structuredPatch)) t.patch = r.structuredPatch;
        }
      }
      if (texts.join('').trim() || images.length) items.push({ kind: 'user', id: rec.uuid ?? uid(), text: texts.join('\n').trim(), images, ts: rec.timestamp ?? '', forkAt: rec.parentUuid ?? undefined });
    } else if (rec.type === 'assistant') {
      for (const c of content ?? []) {
        if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'assistant', id: uid(), text: c.text });
        else if (c.type === 'tool_use' && !tools.has(c.id)) {
          bg.toolUse(c.id, c.name, c.input, rec.timestamp);
          if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) todos = c.input.todos;
          const t: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: c.id, name: c.name, summary: summary(c.name, c.input), input: c.input, status: 'done', file: str(c.input?.file_path) || undefined };
          tools.set(c.id, t);
          items.push(t);
        }
      }
    }
  }
  return { items, todos, title, model, tasks: bg.tasks };
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
  history?: { items: ChatItem[]; todos: Todo[]; model?: string; tasks?: BgTask[] };
  /** Account: its name and env (CLAUDE_CONFIG_DIR) */
  account?: { name: string; env: Record<string, string>; provider?: string };
  /** editor the chat runs in (Visual Studio Code, Cursor…) */
  host?: string;
  hostIcon?: string;
  /** settings saved from the last time this session was open (applied at start) */
  prefs?: ChatPrefs;
  /** run a copy of the resumed session cut at this transcript entry (edit an earlier prompt) */
  fork?: { at: string };
  /** path of dist/relay.js: Claude Code then keeps running when VS Code reloads or closes */
  relayScript?: string;
}

/** What a chat remembers per session: restored when it is resumed or the window reloads. */
export interface ChatPrefs {
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  fastMode?: boolean;
  ultracode?: boolean;
}

export class ChatSession {
  readonly state: ChatState;
  /** how this chat was started (to start a fork of it) */
  get options(): ChatOptions {
    return this.opts;
  }
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
      permissionMode: opts.prefs?.permissionMode ?? opts.permissionMode ?? 'default',
      model: opts.prefs?.model ?? opts.history?.model ?? opts.model,
      effort: opts.prefs?.effort,
      fastMode: !!opts.prefs?.fastMode,
      ultracode: !!opts.prefs?.ultracode,
      status: 'starting',
      todos: opts.history?.todos ?? [],
      items: opts.history ? [...opts.history.items.slice(-HISTORY_PAGE), { kind: 'system', id: uid(), text: 'Resumed: earlier conversation above' }] : [],
      earlier: Math.max(0, (opts.history?.items.length ?? 0) - HISTORY_PAGE),
      // from an earlier run of this session: still running only if its output is still being written
      tasks: (opts.history?.tasks ?? []).map((t) => ({ ...t, status: guessStatus(t, false) })),
      queue: [],
      slashCommands: [],
      mcp: [],
      costUsd: 0,
      account: { name: opts.account?.name ?? 'Default', gateway: opts.account?.provider },
      host: opts.host,
      hostIcon: opts.hostIcon,
    };
  }

  private changed() {
    this.state.queue = this.queued.map((m) => ({ id: m.id, text: m.text, images: m.images.length, priority: m.priority }));
    this.onChange(this.state);
  }

  /** Reconnects to the process still running this session, or starts one that outlives VS Code. */
  private relayedSpawn() {
    const script = this.opts.relayScript;
    if (!script) return undefined;
    const running = this.opts.resume && !this.opts.fork ? findRelay(this.opts.resume) : undefined;
    return (o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined> }) => {
      const proc = new RelayProcess(running ?? startRelay(script, { ...o, sessionId: this.opts.resume }));
      proc.hello.then(({ busy }) => {
        if (running) this.q?.reinitialize().catch(() => {}); // hands back the permission requests still waiting
        if (busy && this.state.status === 'idle') {
          this.state.status = 'working';
          this.state.activity = 'Thinking…';
          this.changed();
        }
      });
      return proc as any;
    };
  }

  start() {
    const spawnClaudeCodeProcess = this.relayedSpawn();
    this.q = query({
      prompt: this.input,
      options: {
        ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
        cwd: this.opts.cwd,
        resume: this.opts.resume,
        model: this.opts.prefs?.model ?? this.opts.model,
        permissionMode: this.state.permissionMode,
        includePartialMessages: true,
        abortController: this.abort,
        pathToClaudeCodeExecutable: this.opts.executable,
        settingSources: ['user', 'project', 'local'],
        promptSuggestions: true,
        // backups of files before the agent edits them, so "edit and run again" can undo them
        enableFileCheckpointing: true,
        ...(this.opts.fork ? { resumeSessionAt: this.opts.fork.at, forkSession: true } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: { ...process.env, ...(this.opts.account?.env ?? {}), CLAUDE_AGENT_SDK_CLIENT_APP: 'steerhouse' },
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
    // the settings this session had last time
    const p = this.opts.prefs;
    if (p && (p.effort || p.fastMode || p.ultracode))
      this.q.applyFlagSettings({ ...(p.effort ? { effortLevel: p.effort } : {}), ...(p.fastMode ? { fastMode: true } : {}), ...(p.ultracode ? { ultracode: true } : {}) } as any).catch(() => {});
    // ready now (init only arrives with the first message); resumed chats get their context at once
    this.state.status = 'idle';
    this.q.getContextUsage({ detail: 'summary' }).then((u: any) => {
      this.state.context = { used: u.totalTokens, max: u.maxTokens, percentage: u.percentage, categories: toCategories(u) };
      this.changed();
    }).catch(() => {});
    this.refreshLimits(true);
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

  /** background commands seen in this run (merged into state.tasks) */
  private bg = new BgTaskTracker();

  private syncTasks() {
    // the SDK's task_started often comes first (no output file yet); the tool result then adds the
    // output file and the exact command
    for (const t of this.bg.tasks) {
      const known = this.state.tasks.find((x) => x.id === t.id);
      if (!known) this.state.tasks.push({ ...t });
      else {
        known.outputFile ??= t.outputFile;
        if (t.command) known.command = t.command;
        known.description ??= t.description;
        known.toolUseId ??= t.toolUseId;
      }
    }
  }

  /** task_started / task_updated / task_notification: exact status for shell tasks of this run. */
  private onTaskEvent(m: any) {
    let t = this.state.tasks.find((x) => x.id === m.task_id);
    if (m.subtype === 'task_started') {
      if (m.task_type && m.task_type !== 'local_bash') return; // sub-agents are shown elsewhere
      if (!t) {
        const call = m.tool_use_id ? this.tool(m.tool_use_id) : undefined;
        this.state.tasks.push((t = { id: m.task_id, toolUseId: m.tool_use_id, command: String((call?.input as any)?.command ?? m.description ?? ''), description: m.description, status: 'running', started: new Date().toISOString() }));
      }
    }
    if (!t) return;
    const st = m.subtype === 'task_updated' ? sdkStatus(m.patch?.status) : m.subtype === 'task_notification' ? sdkStatus(m.status) : undefined;
    if (st) {
      t.status = st;
      if (st !== 'running') t.ended = new Date().toISOString();
    }
    if (m.output_file) t.outputFile = m.output_file;
    this.changed();
  }

  /** A command's output file: the one Claude Code named, or where it writes while the command runs. */
  taskFile(t: BgTask): string | undefined {
    if (t.outputFile) return t.outputFile;
    // its own session's folder first: in a resumed chat, other commands may be from an earlier session
    const own = this.state.sessionId ? path.join(sessionTasksDir(this.opts.cwd, this.state.sessionId), `${t.id}.output`) : undefined;
    if (own && fs.existsSync(own)) return own;
    const named = this.state.tasks.flatMap((x) => (x.outputFile ? [path.join(path.dirname(x.outputFile), `${t.id}.output`)] : [])).find((f) => fs.existsSync(f));
    return named ?? own;
  }

  /** A command's output: live from its file; once that is gone, what the command returned to the agent. */
  taskOutput(id: string): { text: string; size: number; missing?: boolean; file?: string } {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { text: '', size: 0, missing: true };
    const file = this.taskFile(t);
    const r = readTail(file);
    if (!r.missing) return { ...r, file };
    const result = t.toolUseId ? this.tool(t.toolUseId)?.result : undefined;
    // only a real result: "running in the background" is not the command's output
    return result && !parseStarted(result) ? { text: result, size: Buffer.byteLength(result) } : { ...r, file: t.status === 'running' ? file : undefined };
  }

  /** Stops a background command the agent started in this chat. */
  async stopTask(id: string) {
    await this.q?.stopTask(id);
  }

  private limitsAt = 0;
  /** Plan usage (5-hour / weekly windows), at most once a minute unless forced. */
  refreshLimits(force = false) {
    if (!this.q || (!force && Date.now() - this.limitsAt < 60_000)) return;
    this.limitsAt = Date.now();
    const env = { ...process.env, ...(this.opts.account?.env ?? {}) };
    openRouterLimits(env)
      .then(async (or) => or ?? limitsFromUsage(await (this.q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })))
      .then((l) => {
        this.state.limits = l;
        this.changed();
      })
      .catch(() => {});
  }

  /** Restores files the agent changed after this message (needs file checkpointing, on for Steerhouse chats). */
  async rewindFilesTo(userUuid: string): Promise<{ ok: boolean; error?: string; files?: number }> {
    try {
      const r: any = await this.q?.rewindFiles(userUuid);
      if (!r) return { ok: false, error: 'chat not running' };
      return r.canRewind === false ? { ok: false, error: r.error ?? 'cannot rewind' } : { ok: true, files: r.filesChanged?.length ?? r.changedFiles?.length };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
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
    // commands the user ran since their last message: the agent reads them now, the bubble stays as written
    const forAgent = [text, ...this.shellNotes.splice(0)].filter((t) => t.trim()).join('\n\n');
    if (forAgent) content.push({ type: 'text', text: forAgent });
    // the message's own uuid (so files can be rewound to it) and the entry before it (to fork there)
    const uuid = randomUUID();
    this.state.items.push({ kind: 'user', id: uuid, text, images: images.map((i) => i.data), priority, ts: new Date().toISOString(), forkAt: this.lastUuid });
    this.state.suggestion = undefined;
    if (this.state.title === 'New chat' && text.trim()) this.state.title = clip(text.trim().split('\n')[0], 60);
    this.state.status = 'working';
    this.state.activity = priority === 'now' ? 'Switching to your message…' : this.state.activity ?? 'Thinking…';
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority, uuid } as SDKUserMessage);
    this.changed();
  }

  private shells = new Map<string, ShellRun>();
  private shellNotes: string[] = [];

  /** Context for the agent that goes with the user's next message, not shown in their bubble. */
  addNote(text: string) {
    this.shellNotes.push(`<steerhouse-note>\n${text}\n</steerhouse-note>`);
  }

  /** Runs what the user typed after ! in their own shell. It costs nothing: the agent reads the result with the next message. */
  runShell(command: string) {
    const id = uid();
    const item: Extract<ChatItem, { kind: 'shell' }> = { kind: 'shell', id, command, output: '', status: 'running' };
    this.state.items.push(item);
    this.changed();
    const run = new ShellRun(
      command,
      { cwd: this.opts.cwd, env: { ...process.env, ...(this.opts.account?.env ?? {}) } },
      () => {
        item.output = run.output;
        this.changed();
      },
      ({ exitCode, error }) => {
        this.shells.delete(id);
        item.output = run.output;
        item.exitCode = exitCode;
        item.error = error;
        item.status = exitCode === 0 ? 'done' : 'error';
        this.shellNotes.push(shellContext(command, error ?? run.output, exitCode));
        this.changed();
      },
    );
    this.shells.set(id, run);
  }

  stopShell(id: string) {
    this.shells.get(id)?.stop();
  }

  /** Before VS Code goes away: messages waiting here go to Claude Code's own queue, so they aren't lost. */
  handOverQueue() {
    for (const m of this.queued.splice(0)) {
      this.disarm(m.id);
      this.push(m.text, m.images, m.priority);
    }
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
  /** servers added to this session while it runs (the SDK replaces this whole set each time) */
  private dynamicMcp: Record<string, any> = {};
  /** Connects a new MCP server to this running session (it is also saved for future sessions). */
  async addMcp(name: string, config: Record<string, unknown>) {
    this.dynamicMcp[name] = config;
    const r: any = await this.q?.setMcpServers(this.dynamicMcp);
    await this.refreshMcp();
    return r;
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
    for (const run of this.shells.values()) run.stop();
    this.input.close();
    this.abort.abort();
    this.state.status = 'closed';
  }

  // ------------------------------------------------------------------ permissions, plans, questions

  /** Saves an allow rule for this project, just for this user (.claude/settings.local.json). Claude Code
   *  reads its settings again when they change, and auto mode applies allow rules before its classifier. */
  allowRule(id: string, rule: string) {
    const file = path.join(this.state.cwd, '.claude', 'settings.local.json');
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw new Error(`${file} is not valid JSON: fix it first`);
    }
    cfg.permissions ??= {};
    cfg.permissions.allow = [...new Set([...(cfg.permissions.allow ?? []), rule])];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const created = !fs.existsSync(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    // personal, like Claude Code's own: kept out of git without touching the committed .gitignore
    const exclude = path.join(this.state.cwd, '.git', 'info', 'exclude');
    if (created && fs.existsSync(path.dirname(exclude))) {
      const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!/settings\.local\.json/.test(cur)) fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.claude/settings.local.json\n`);
    }
    const it = this.state.items.find((x) => x.id === id);
    if (it?.kind === 'blocked') it.status = 'allowed';
    this.changed();
    return file;
  }

  /** a card standing for earlier identical requests: their ids */
  private copies = new Map<string, string[]>();

  private ask(tool: string, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined, signal: AbortSignal): Promise<PermissionResult> {
    const id = uid();
    // asked again (after a reconnect Claude Code hands back what is still waiting, or two agents ask the
    // same): one card, and its answer goes to every copy
    const same = JSON.stringify(input);
    const copies: string[] = [];
    this.state.items = this.state.items.filter((x) => {
      if (!(x.kind === 'permission' || x.kind === 'plan' || x.kind === 'question') || x.status !== 'pending') return true;
      const ctx = (this as any)[`ctx_${x.id}`] as { input: unknown } | undefined;
      const repeat = !!ctx && JSON.stringify(ctx.input) === same && (x.kind !== 'permission' || x.tool === tool);
      if (repeat) copies.push(x.id, ...(this.copies.get(x.id) ?? []));
      return !repeat;
    });
    if (copies.length) this.copies.set(id, copies);
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
    for (const copy of this.copies.get(id) ?? []) this.respondOne(copy, decision, message, answers);
    this.copies.delete(id);
    this.respondOne(id, decision, message, answers);
  }

  private respondOne(id: string, decision: 'allow' | 'always' | 'deny', message?: string, answers?: Record<string, string>) {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    const ctx = (this as any)[`ctx_${id}`] as { input: Record<string, unknown>; suggestions?: PermissionUpdate[] };
    delete (this as any)[`ctx_${id}`];
    const it = this.state.items.find((x) => x.id === id);
    if (answers && (it?.kind === 'question' || !it)) {
      if (it?.kind === 'question') it.answers = answers;
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

  /** uuid of the last transcript entry (answer or tool result) of the main conversation */
  private lastUuid?: string;

  private handle(m: SDKMessage) {
    const parent = ('parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : null) ?? undefined;
    if ((m.type === 'assistant' || m.type === 'user') && !parent && (m as any).uuid) this.lastUuid = (m as any).uuid;
    if ((m as any).type === 'prompt_suggestion') {
      this.state.suggestion = (m as any).suggestion || undefined;
      this.changed();
      return;
    }
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
        } else if ((m.subtype as string) === 'task_started' || (m.subtype as string) === 'task_updated' || (m.subtype as string) === 'task_notification') {
          this.onTaskEvent(m as any);
        } else if (m.subtype === 'status') {
          if (m.status === 'compacting') this.state.activity = 'Compacting the conversation…';
          if (m.permissionMode) this.state.permissionMode = m.permissionMode;
        }
        break;
      }
      case 'rate_limit_event' as any: {
        const info: any = (m as any).rate_limit_info ?? {};
        const w = this.state.limits?.windows.find((x) => x.id === info.rateLimitType);
        if (w && typeof info.utilization === 'number') {
          w.pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
          if (info.resetsAt) w.resetsAt = new Date(info.resetsAt * 1000).toISOString();
        } else this.refreshLimits(true);
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
            this.bg.toolUse(c.id, c.name, c.input, new Date().toISOString(), parent);
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
        const said = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '';
        if (!(m as any).parent_tool_use_id && isNotice(said)) {
          this.state.items.push(...agentNotice(said, new Date().toISOString(), this.state.items));
          this.bg.text(said, new Date().toISOString());
          this.syncTasks();
        }
        if (!Array.isArray(content)) break;
        for (const c of content) {
          if (c?.type !== 'tool_result') continue;
          this.bg.toolResult(c.tool_use_id, textsOf(c.content), new Date().toISOString());
          this.syncTasks();
          const t = this.tool(c.tool_use_id);
          if (!t) continue;
          t.status = c.is_error ? 'error' : 'done';
          t.result = clip(resultText(c.content), 6000);
          const block = !t.parent ? autoModeBlock(t, t.result) : undefined;
          if (block && !this.state.items.some((x) => x.id === block.id)) this.state.items.push(block);
          const pics = resultImages(c.content).images;
          if (pics.length) t.images = pics;
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
        this.refreshLimits();
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
