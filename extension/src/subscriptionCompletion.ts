// Code suggestions from a Claude account's own login, through Claude Code: its token isn't taken out
// to call the API directly. Slower than a provider (1 to 3 s), and each one counts toward the plan's limits.
import { startup, type Query } from '@anthropic-ai/claude-agent-sdk';
import { SYSTEM, type CompletionReply } from './codeCompletion';

const MODEL = 'haiku';
const IDLE_MS = 2 * 60_000;
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
        env: { ...process.env, ...this.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256' },
      },
    });
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
    try {
      for await (const m of q) {
        if (m.type === 'assistant') {
          text += m.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
          cut = m.message.stop_reason === 'max_tokens';
        }
        if (m.type === 'result') {
          if (m.is_error) throw new Error(m.subtype === 'success' ? m.result : m.subtype);
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
