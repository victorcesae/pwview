// Gray suggestions in the code editor, accepted with Tab. Off until the user turns it on and picks a
// model provider, because it sends the code around the cursor to that provider as they type.
import * as path from 'path';
import * as vscode from 'vscode';
import { accountEnv, accountIdentity, listAccounts } from './accounts';
import { PRESETS, secretKey, type Provider } from './providers';
import { SubscriptionCompleter } from './subscriptionCompletion';
import { agentExecutable } from './util';

const PREFIX_CHARS = 6000;
const SUFFIX_CHARS = 2000;
const MAX_TOKENS = 256;
const MAX_LINES = 8;
const TIMEOUT_MS = 15_000;
const TIMED_OUT = 'timeout';
const timedOut = (a: AbortController) => a.signal.reason === TIMED_OUT;

export interface CompletionReply {
  text: string;
  cut: boolean;
}

/** Where suggestions come from: a model provider, or a Claude account's own subscription. */
export interface SubscriptionSource {
  id: string;
  name: string;
  account: string;
}
export type CompletionSource = Provider | SubscriptionSource;
const isSubscription = (s: CompletionSource): s is SubscriptionSource => 'account' in s;

/** Each suggestion from a subscription spends the plan's limits: wait for a real pause in typing. */
export const SUBSCRIPTION_MIN_DELAY_MS = 250;

export interface CompletionSettings {
  enabled: boolean;
  /** the provider's id; nothing is sent until one was chosen */
  provider: string;
  /** a faster model than the provider's chat model, if wanted */
  model: string;
  delayMs: number;
}

/** Files that often hold secrets: their content is never sent. */
export function isSensitive(file: string): boolean {
  const p = file.replace(/\\/g, '/').toLowerCase();
  const name = p.split('/').pop() ?? '';
  if (/(^|\/)\.(ssh|aws|gnupg|azure|kube|docker)\//.test(p)) return true;
  if (/^\.env($|\.)/.test(name) && !/\.(example|sample|template|dist)$/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|tfvars|tfstate)$/.test(name)) return true;
  return /^(id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|credentials(\..*)?|secrets?(\..*)?)$/.test(name);
}

/** Only where a suggestion can flow: at the end of the line, or before closing characters. */
export const worthSuggesting = (restOfLine: string) => /^[\s)\]}'"`;,:>]*$/.test(restOfLine);

export const SYSTEM = `You are a code completion engine inside an editor, like Copilot. The user message is a file with a <CURSOR> marker. Reply with ONLY the raw characters to insert at <CURSOR>, exactly as they would appear in the file: never a label, a name, a quote, backticks, Markdown, an explanation or anything already before or after the cursor. Usually the rest of the current line; at most a few lines of the current block. If nothing useful fits, reply with nothing.

Example. File:
function area(r: number) {
  return <CURSOR>
}
Reply:
Math.PI * r * r;`;

export function userPrompt(language: string, fileName: string, prefix: string, suffix: string, context = '') {
  return `${context}Language: ${language}\nFile: ${fileName}\n\n${prefix.slice(-PREFIX_CHARS)}<CURSOR>${suffix.slice(0, SUFFIX_CHARS)}`;
}

/** After `return ` or `= `, a reply starting with a stray `name: ` label (models do that) loses the label. */
export function withoutLabel(prefix: string, text: string): string {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (!/(\breturn|=)\s*$/.test(line) || /[{,]\s*$/.test(line)) return text;
  return text.replace(/^\s*[A-Za-z_$][\w$]*:\s+(?=\S)/, '');
}

/**
 * A suggestion that would break the line being typed: after `return `, `= `, `(` or a binary
 * operator, a reply that opens a new statement (`const x…`, `return …`) is not a continuation.
 */
export function breaksLine(prefix: string, text: string): boolean {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (!/(\breturn|\byield|\bawait|[=(,+\-*/&|?:!<>]|=>)\s*$/.test(line)) return false;
  return /^\s*(const|let|var|return|function|class|import|export|if|for|while|def|async def)\b/.test(text) || /^\s*\n/.test(text);
}

const CONTEXT_CHARS = 3000;
const SNIPPET_CHARS = 1200;
/** Words of the code near the cursor, to find the parts of other files that matter here. */
const words = (s: string) => new Set(s.match(/[A-Za-z_$][\w$]{2,}/g) ?? []);

/** The window of another file that shares the most names with the code at the cursor (like Copilot's neighboring tabs). */
export function bestSnippet(text: string, near: Set<string>, size = SNIPPET_CHARS): { text: string; score: number } {
  const lines = text.split('\n');
  let best = { text: '', score: 0 };
  const step = 10;
  for (let i = 0; i < lines.length; i += step) {
    let chunk = '';
    for (let j = i; j < lines.length && chunk.length < size; j++) chunk += lines[j] + '\n';
    let score = 0;
    for (const w of words(chunk)) if (near.has(w)) score++;
    if (score > best.score) best = { text: chunk, score };
  }
  return best;
}

/** Context from other open files and the user's recent edits, put before the file in the prompt. */
export function contextBlock(near: string, others: { name: string; text: string }[], edits: string[]): string {
  const w = words(near);
  const picks = others
    .map((o) => ({ name: o.name, ...bestSnippet(o.text, w) }))
    .filter((o) => o.score >= 2)
    .sort((a, b) => b.score - a.score);
  let out = '';
  for (const p of picks) {
    const add = `--- ${p.name} (excerpt) ---\n${p.text}\n`;
    if (out.length + add.length > CONTEXT_CHARS) break;
    out += add;
  }
  const recent = edits.slice(-5).join('\n');
  if (recent) out += `--- recent edits by the user ---\n${recent}\n`;
  return out ? `Related code (for reference only, do not repeat it):\n${out}\n` : '';
}

/** Right after an opening brace or a colon at the end of a line, a whole block is welcome; else about a line. */
export const maxLinesAt = (prefix: string) => (/[{:(\[]\s*\n?\s*$/.test(prefix.slice(-80)) ? MAX_LINES : 3);

/** The model's reply as text to insert: no fences, nothing the file already has, not too long. */
export function cleanCompletion(reply: string, prefix: string, suffix: string, cut = false, maxLines = MAX_LINES): string | undefined {
  let text = reply.replace(/<\/?CURSOR>/g, '');
  // a fenced block anywhere (often after a sentence of prose): only its code
  const fence = /```[^\n]*\n([\s\S]*?)(?:\n?```|$)/.exec(text);
  if (fence) text = fence[1];
  // a whole one-line reply wrapped in backticks
  else if (/^\s*`[^`\n]+`\s*$/.test(text)) text = text.trim().slice(1, -1);
  // a leading sentence of prose ("Filling in the body:") before the code
  const first = text.split('\n')[0];
  if (text.includes('\n') && /^[A-Za-z][\w ,'’`-]{12,}[:.]\s*$/.test(first) && !/[;(){}=]/.test(first)) text = text.slice(first.length + 1).replace(/^\n+/, '');
  // a stray `Label: ` in front of code (not an object key: the line before the cursor doesn't open one)
  const lineBefore = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (!/[{,]\s*$/.test(lineBefore)) text = text.replace(/^\s*[A-Z][A-Za-z]{0,15}:\s+(?=[`<(\w])/, '').replace(/^`([^`\n]+)`/, '$1');
  let lines = text.split('\n');
  if (cut && lines.length > 1) lines = lines.slice(0, -1); // the reply stopped mid-line
  text = lines.slice(0, maxLines).join('\n');
  // repeated what is already typed on this line
  const typed = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (typed.trim() && text.startsWith(typed)) text = text.slice(typed.length);
  else if (typed.trim() && text.trimStart().startsWith(typed.trim())) text = text.trimStart().slice(typed.trim().length);
  // the line so far is only indentation: the reply's own indentation would double it
  if (!typed.trim()) text = text.replace(/^[ \t]+/, '');
  // the reply starts with the last token already typed (`=> =>`, `( (`): drop the repeat
  else {
    const last = /(\S+)\s*$/.exec(typed)?.[1];
    if (last && last.length >= 2 && text.trimStart().startsWith(last + ' ')) text = text.trimStart().slice(last.length);
  }
  // the line already ends with a space: no second one
  if (/[ \t]$/.test(typed)) text = text.replace(/^[ \t]+/, '');
  // ran into what comes after the cursor
  for (let k = Math.min(text.length, suffix.length); k > 0; k--) {
    if (text.endsWith(suffix.slice(0, k))) {
      text = text.slice(0, -k);
      break;
    }
  }
  return text.trim() ? text.trimEnd() : undefined;
}

/** One completion from an Anthropic-compatible endpoint (what every provider preset speaks). */
export async function requestCompletion(p: Provider, key: string | undefined, model: string, system: string, user: string, signal: AbortSignal, maxLines = MAX_LINES): Promise<CompletionReply> {
  const token = key ?? PRESETS.find((x) => x.id === p.preset)?.localToken ?? '';
  // streamed, so the request ends as soon as enough lines came (a short suggestion needs few tokens)
  const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': token, authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: model || p.model, max_tokens: maxLines < MAX_LINES ? 96 : MAX_TOKENS, temperature: 0, stream: true, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status}`);
  if (/event-stream/.test(res.headers.get('content-type') ?? '') && res.body) return readStream(res.body, maxLines);
  const body: any = await res.json();
  const text = (body.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
  return { text, cut: body.stop_reason === 'max_tokens' };
}

/** Reads a streamed reply, and stops as soon as it has more lines than will be shown. */
export async function readStream(body: ReadableStream<Uint8Array>, maxLines: number): Promise<CompletionReply> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let e: any;
        try {
          e = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text;
        if (e.type === 'message_delta' && e.delta?.stop_reason === 'max_tokens') cut = true;
        if (e.type === 'error') throw new Error(e.error?.message ?? 'stream error');
      }
      // enough whole lines: the rest would be cut anyway
      if (text.split('\n').length > maxLines) return { text, cut: true };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text, cut };
}

/** Typing one of these means a suggestion is likely wanted right now: no pause needed. */
export const askAtOnce = (prefix: string) => /(\n\s*|[.({\[=,:]\s?)$/.test(prefix.slice(-3));

/** A suggestion still fits after more typing when the new characters are its start: the rest of it,
 *  shown right away with no new request (what Cursor and Copilot do while you type through one). */
export function typedThrough(shownAt: string, text: string | undefined, prefix: string): string | undefined {
  if (!text || !prefix.startsWith(shownAt)) return undefined;
  const typed = prefix.slice(shownAt.length);
  if (!text.startsWith(typed)) return undefined;
  const rest = text.slice(typed.length);
  return rest.trim() ? rest : undefined;
}

/** Whether completions stay on this machine (the extension's machine: over SSH, the remote one). */
export const isLocal = (p: Provider) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(p.baseUrl);

interface Asked {
  /** provider, model, language and the text after the cursor: what has to stay the same to reuse it */
  where: string;
  prefix: string;
  done: boolean;
  reply: Promise<string | undefined>;
  abort: AbortController;
  /** the answer, once it came */
  text?: string;
}

/** Suggestions already received, by what came before the cursor: backspace and retype shows them at once. */
class SuggestionCache {
  private m = new Map<string, string>();
  get(k: string) {
    const v = this.m.get(k);
    if (v !== undefined) (this.m.delete(k), this.m.set(k, v));
    return v;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
    if (this.m.size > 100) this.m.delete(this.m.keys().next().value!);
  }
}

export class CodeCompletion implements vscode.InlineCompletionItemProvider {
  private cache = new SuggestionCache();
  /** extra context (other files, recent edits) for a document; set by the extension */
  context?: (doc: vscode.TextDocument, near: string) => string;
  /** languages where it stays quiet, and until when it is snoozed */
  skip?: (doc: vscode.TextDocument) => boolean;
  /** last answer time, for the status bar */
  onLatency?: (ms: number) => void;
  /** the latest request: kept when a key is typed while it runs, since the answer may still fit */
  private asked?: Asked;
  /** whoever wants Claude Code started before the first suggestion */
  onTyping?: (source: CompletionSource, model: string) => void;
  /** the latest failure, for the status bar; cleared by the next success */
  onStatus?: (error?: string) => void;

  constructor(
    private settings: () => CompletionSettings,
    private providers: () => CompletionSource[],
    private secret: (id: string) => Thenable<string | undefined>,
    private subscription?: (account: string, model: string, user: string, signal: AbortSignal, maxLines: number) => Promise<CompletionReply>,
  ) {}

  async provideInlineCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = this.settings();
    if (!s.enabled || !s.provider || isSensitive(doc.uri.fsPath) || this.skip?.(doc)) return;
    if (context.selectedCompletionInfo) return; // the suggestions list is open: it goes first
    if (!worthSuggesting(doc.lineAt(pos.line).text.slice(pos.character))) return;
    const provider = this.providers().find((p) => p.id === s.provider);
    if (!provider) return;
    const offset = doc.offsetAt(pos);
    const all = doc.getText();
    const prefix = all.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = all.slice(offset, offset + SUFFIX_CHARS);
    if (!prefix.trim()) return;
    const where = `${s.provider}\0${s.model}\0${doc.languageId}\0${suffix}`;
    const cacheKey = `${where}\0${prefix.slice(-400)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return [this.item(cached, pos)];
    let asked = this.asked?.where === where && prefix.startsWith(this.asked.prefix) ? this.asked : undefined;
    // typed through the suggestion on screen: the rest of it at once
    let text = asked && typedThrough(asked.prefix, asked.text, prefix);
    if (!text && asked && !asked.done) {
      // asked a moment ago and still on its way: its answer may still fit what was typed since
      text = typedThrough(asked.prefix, await asked.reply, prefix);
      if (token.isCancellationRequested) return;
    }
    if (!text) {
      if (asked?.done && asked.prefix === prefix) return; // asked for exactly this already: nothing fits here
      // wait for a pause in typing: VS Code cancels this request on the next key, so nothing is sent
      this.onTyping?.(provider, s.model);
      // right after a suggestion was accepted, or after typing ( . { = , : or Enter: ask at once
      const quick = this.skipDelayOnce || askAtOnce(prefix);
      this.skipDelayOnce = false;
      const wait = Math.max(isSubscription(provider) ? (quick ? 60 : SUBSCRIPTION_MIN_DELAY_MS) : 0, quick ? Math.min(s.delayMs, 40) : s.delayMs);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (token.isCancellationRequested) return;
      this.asked?.abort.abort(); // somewhere else now: its answer is no use
      const abort = new AbortController();
      const user = userPrompt(doc.languageId, path.basename(doc.uri.fsPath), prefix, suffix, this.context?.(doc, prefix.slice(-1500) + suffix.slice(0, 300)) ?? '');
      const lines = maxLinesAt(prefix);
      const started = Date.now();
      const now: Asked = { where, prefix, done: false, abort, reply: Promise.resolve(undefined) };
      // not tied to this request's cancellation: the next key cancels it, and the answer may still fit
      now.reply = this.ask(provider, s.model, user, abort, lines).then((r) => {
        now.text = r && cleanCompletion(r.text, prefix, suffix, r.cut, lines);
        if (now.text) now.text = withoutLabel(prefix, now.text);
        if (now.text && breaksLine(prefix, now.text)) now.text = undefined;
        if (r) this.onLatency?.(Date.now() - started);
        if (now.text) this.cache.set(cacheKey, now.text);
        now.done = !!r; // stopped or failed: asked again next time
        return now.text;
      });
      this.asked = now;
      text = await now.reply;
    }
    if (!text || token.isCancellationRequested) return;
    return [this.item(text, pos)];
  }

  /** set when a suggestion was just accepted: the next one is asked for at once */
  skipDelayOnce = false;
  private item(text: string, pos: vscode.Position) {
    const it = new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos));
    // after Tab, the next suggestion is fetched right away (chained suggestions feel instant)
    it.command = { command: 'steerhouse.codeCompletion.accepted', title: '' };
    return it;
  }

  private async ask(provider: CompletionSource, model: string, user: string, abort: AbortController, maxLines = MAX_LINES): Promise<CompletionReply | undefined> {
    const timer = setTimeout(() => abort.abort(TIMED_OUT), TIMEOUT_MS);
    try {
      const reply = isSubscription(provider)
        ? await this.subscription!(provider.account, model, user, abort.signal, maxLines)
        : await requestCompletion(provider, provider.hasKey ? await this.secret(provider.id) : undefined, model, SYSTEM, user, abort.signal, maxLines);
      this.onStatus?.();
      return reply;
    } catch (e) {
      // stopped because the cursor moved on: not an error
      if (abort.signal.aborted && !timedOut(abort)) return undefined;
      this.onStatus?.(timedOut(abort) ? `${provider.name}: no answer in ${TIMEOUT_MS / 1000} s` : String((e as Error)?.message ?? e));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
export function registerCodeCompletion(ctx: vscode.ExtensionContext) {
  const section = () => vscode.workspace.getConfiguration('steerhouse.codeCompletion');
  const settings = (): CompletionSettings => ({ enabled: section().get('enabled', false), provider: section().get('provider', ''), model: section().get('model', ''), delayMs: section().get('delayMs', 250) });
  // the subscriptions first: they are already there, no key or server to set up
  const providers = (): CompletionSource[] => {
    const accounts = listAccounts();
    return [
      ...accounts.flatMap((a): CompletionSource[] => (!a.provider && accountIdentity(a) ? [{ id: `claude:${a.id}`, name: vscode.l10n.t('Claude subscription · {0}', a.name), account: a.id }] : [])),
      ...accounts.flatMap((a): CompletionSource[] => (a.provider ? [a.provider] : [])),
    ];
  };
  const completers = new Map<string, SubscriptionCompleter>();
  const completerFor = (id: string) => {
    let c = completers.get(id);
    if (!c) {
      const account = listAccounts().find((a) => a.id === id);
      if (!account) throw new Error(`no account ${id}`);
      c = new SubscriptionCompleter(agentExecutable(), accountEnv(account), ctx.globalStorageUri.fsPath);
      completers.set(id, c);
    }
    return c;
  };
  const stopCompleters = () => {
    for (const c of completers.values()) c.dispose();
    completers.clear();
  };
  const engine = new CodeCompletion(settings, providers, (id) => ctx.secrets.get(secretKey(id)), (account, model, user, signal, maxLines) => {
    require('fs').mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    return completerFor(account).complete(model, user, signal, maxLines);
  });

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  item.command = 'steerhouse.codeCompletion.toggle';
  const paint = (error?: string) => {
    const s = settings();
    const name = providers().find((p) => p.id === s.provider)?.name;
    item.text = error ? '$(warning) Tab' : s.enabled ? '$(sparkle) Tab' : '$(circle-slash) Tab';
    const snoozed = Date.now() < snoozedUntil;
    if (s.enabled && snoozed && !error) item.text = '$(debug-pause) Tab';
    item.tooltip =
      error ??
      (s.enabled
        ? (snoozed ? vscode.l10n.t('Code completion is snoozed until {0}.', new Date(snoozedUntil).toLocaleTimeString()) : vscode.l10n.t('Code completion is on ({0}).', name ?? '?')) +
          (latency !== undefined ? ' ' + vscode.l10n.t('Last suggestion in {0} ms.', String(latency)) : '') +
          ' ' + vscode.l10n.t('Click for options. Ctrl+→ accepts a word at a time.')
        : vscode.l10n.t('Code completion is off. Click to turn it on.'));
    item.show();
  };
  engine.onStatus = paint;
  // ---- context: other open files and what the user just changed
  const edits: string[] = [];
  engine.context = (doc, near) => {
    if (!section().get('useOpenFiles', true)) return '';
    const others = vscode.workspace.textDocuments
      .filter((d) => d !== doc && d.uri.scheme === 'file' && !isSensitive(d.uri.fsPath) && d.getText().length < 200_000)
      .slice(0, 20)
      .map((d) => ({ name: vscode.workspace.asRelativePath(d.uri), text: d.getText() }));
    return contextBlock(near, others, edits);
  };
  let snoozedUntil = 0;
  engine.skip = (doc) => Date.now() < snoozedUntil || section().get<string[]>('disabledLanguages', []).includes(doc.languageId);
  let latency: number | undefined;
  engine.onLatency = (ms) => {
    latency = ms;
    paint();
  };
  // Claude Code takes about half a second to start: have one ready before the first suggestion
  const prewarm = (source?: CompletionSource, model = settings().model) => {
    const s = settings();
    const src = source ?? (s.enabled ? providers().find((p) => p.id === s.provider) : undefined);
    if (!src || !isSubscription(src)) return;
    try {
      require('fs').mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
      completerFor(src.account).prewarm(model);
    } catch {}
  };
  engine.onTyping = prewarm;
  paint();

  const toggle = async () => {
    const save = (k: string, v: unknown) => section().update(k, v, vscode.ConfigurationTarget.Global);
    if (settings().enabled) {
      const lang = vscode.window.activeTextEditor?.document.languageId;
      const off = section().get<string[]>('disabledLanguages', []);
      const snoozed = Date.now() < snoozedUntil;
      const opts = [
        snoozed ? { label: vscode.l10n.t('$(debug-start) Resume now'), id: 'resume' } : { label: vscode.l10n.t('$(debug-pause) Snooze for 15 minutes'), id: 'snooze' },
        ...(lang ? [off.includes(lang) ? { label: vscode.l10n.t('$(check) Turn on for {0}', lang), id: 'lang-on' } : { label: vscode.l10n.t('$(circle-slash) Turn off for {0}', lang), id: 'lang-off' }] : []),
        { label: vscode.l10n.t('$(arrow-swap) Change provider…'), id: 'provider' },
        { label: vscode.l10n.t('$(close) Turn off'), id: 'off' },
      ];
      const pick = await vscode.window.showQuickPick(opts, { title: vscode.l10n.t('Code completion') });
      if (!pick) return;
      if (pick.id === 'snooze') snoozedUntil = Date.now() + 15 * 60_000;
      if (pick.id === 'resume') snoozedUntil = 0;
      if (pick.id === 'lang-off' && lang) await save('disabledLanguages', [...off, lang]);
      if (pick.id === 'lang-on' && lang) await save('disabledLanguages', off.filter((l) => l !== lang));
      if (pick.id === 'off') return save('enabled', false);
      if (pick.id !== 'provider') return paint();
    }
    const list = providers();
    if (!list.length) {
      const add = vscode.l10n.t('Add a Provider');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('Code completion needs a Claude login or a model provider (Ollama, OpenRouter…). Add one, then turn it on again.'), add)) === add) await vscode.commands.executeCommand('steerhouse.addProvider');
      return;
    }
    const picked = await vscode.window.showQuickPick(list.map((p) => ({ label: p.name, description: isSubscription(p) ? vscode.l10n.t('slower, counts toward your plan limits') : p.baseUrl, p })), { ignoreFocusOut: true, title: vscode.l10n.t('Code completion'), placeHolder: vscode.l10n.t('Which provider should suggest code?') });
    if (!picked) return;
    const on = vscode.l10n.t('Turn On');
    if (isSubscription(picked.p)) {
      const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Use your Claude subscription for suggestions?'), { modal: true, detail: vscode.l10n.t('When you pause typing, the code around your cursor goes to Claude, like in a chat. Each suggestion counts toward your plan limits and takes 1 to 3 seconds. A provider is faster. Files like .env and private keys are never sent.') }, on);
      if (ok !== on) return;
    } else if (!isLocal(picked.p)) {
      const ok = await vscode.window.showWarningMessage(vscode.l10n.t('Send your code to {0}?', picked.p.name), { modal: true, detail: vscode.l10n.t('As you type, the code around your cursor goes to {0}, and each suggestion may cost money. Files like .env and private keys are never sent.', picked.p.baseUrl) }, on);
      if (ok !== on) return;
    }
    await save('provider', picked.p.id);
    await save('enabled', true);
  };

  ctx.subscriptions.push(
    item,
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, engine),
    vscode.commands.registerCommand('steerhouse.codeCompletion.toggle', toggle),
    vscode.commands.registerCommand('steerhouse.codeCompletion.accepted', () => {
      engine.skipDelayOnce = true;
      setTimeout(() => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'), 0);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => e?.document.uri.scheme === 'file' && prewarm()),
    // the user's own small edits (not whole-file changes, not secrets): what they are doing right now
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file' || isSensitive(e.document.uri.fsPath)) return;
      for (const c of e.contentChanges) {
        if (c.text.length > 400 || c.rangeLength > 400 || (!c.text.trim() && !c.rangeLength)) continue;
        const line = e.document.lineAt(Math.min(c.range.start.line, e.document.lineCount - 1)).text.trim();
        if (!line) continue;
        const entry = `${vscode.workspace.asRelativePath(e.document.uri)}:${c.range.start.line + 1}: ${line.slice(0, 160)}`;
        if (edits[edits.length - 1]?.startsWith(entry.split(': ')[0] + ':')) edits[edits.length - 1] = entry;
        else edits.push(entry);
        if (edits.length > 20) edits.shift();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('steerhouse.codeCompletion')) return;
      stopCompleters(); // the model or the account may have changed, and when off nothing stays warm
      paint();
    }),
    { dispose: stopCompleters },
  );
}
