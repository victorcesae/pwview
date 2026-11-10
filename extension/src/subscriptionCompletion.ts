// Code suggestions from a Claude account's own login, through Claude Code: its token isn't taken out
// to call the API directly. Slower than a provider (1 to 3 s), and each one counts toward the plan's limits.
import { startup, type Query } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM, type CompletionReply } from './codeCompletion';

const MODEL = 'haiku';
const IDLE_MS = 2 * 60_000;
// Claude Code's own cap is kept well above this: when it hits its cap it retries the reply several
// times and then reports an "API Error", which is slow. The suggestion is cut here instead.
const MAX_CHARS = 500;
type Warm = Awaited<ReturnType<typeof startup>>;

/** One account: a process kept warm for the next suggestion, gone after a while without any. */
export class SubscriptionCompleter {
  private spare?: Promise<Warm>;
  private idle?: ReturnType<typeof setTimeout>;

  constructor(private executable: string | undefined, private env: Record<string, string | undefined>, private cwd: string) {}

  private warmUp(model: string) {
    return startup({
      options: {
        model: model || MODEL,
        pathToClaudeCodeExecutable: this.executable,
        systemPrompt: SYSTEM,
        tools: [], // it only writes text: it can't read or run anything
        settingSources: [], // no hooks or project settings for a suggestion
        persistSession: false, // not a chat: nothing in the session list
        maxTurns: 1,
        permissionMode: 'dontAsk',
        cwd: this.cwd,
        // no thinking (it delays the first character), and the text as it is written
        thinking: { type: 'disabled' },
        includePartialMessages: true,
        // no telemetry or update checks competing with the request
        env: { ...process.env, ...this.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048', MAX_THINKING_TOKENS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      },
    });
  }

  /** Starts Claude Code before the first suggestion is wanted (it takes about half a second). */
  prewarm(model: string) {
    if (this.spare) return;
    this.spare = this.warmUp(model);
    this.spare.catch(() => (this.spare = undefined));
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), IDLE_MS);
  }

  async complete(model: string, user: string, signal: AbortSignal): Promise<CompletionReply> {
    clearTimeout(this.idle);
    const warm = await (this.spare ?? this.warmUp(model));
    this.spare = undefined;
    if (signal.aborted) {
      warm.close();
      return { text: '', cut: false };
    }
    const q: Query = warm.query(user);
    const stop = () => q.close();
    signal.addEventListener('abort', stop, { once: true });
    let text = '';
    let cut = false;
    const kinds = new Map<number, string>();
    try {
      for await (const m of q) {
        // the suggestion is ready when its text block ends: no need to wait for Claude Code's report
        if (m.type === 'stream_event') {
          const e: any = m.event;
          if (e.type === 'content_block_start') kinds.set(e.index, e.content_block?.type);
          if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            text += e.delta.text;
            if (text.length >= MAX_CHARS) {
              cut = true;
              break;
            }
          }
          // the reply is over, even when it is empty: Claude Code's own report comes later
          if (e.type === 'message_delta' && e.delta?.stop_reason) {
            cut ||= e.delta.stop_reason === 'max_tokens';
            break;
          }
          if (e.type === 'content_block_stop' && kinds.get(e.index) === 'text' && text) break;
          continue;
        }
        // a reply Claude Code made up to report an error isn't a suggestion
        if (m.type === 'assistant' && !text && !(m as any).error && m.message.model !== '<synthetic>') {
          text += m.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
          cut = m.message.stop_reason === 'max_tokens';
        }
        if (m.type === 'result') {
          if (m.is_error && !text) throw new Error(m.subtype === 'success' ? m.result : m.subtype);
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', stop);
      q.close();
    }
    // ready for the next one, unless it doesn't come
    this.spare = this.warmUp(model);
    this.spare.catch(() => (this.spare = undefined));
    this.idle = setTimeout(() => this.dispose(), IDLE_MS);
    return { text, cut };
  }

  dispose() {
    clearTimeout(this.idle);
    this.spare?.then((w) => w.close()).catch(() => {});
    this.spare = undefined;
  }
}
