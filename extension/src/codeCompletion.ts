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
const MAX_LINES = 20;
const TIMEOUT_MS = 15_000;

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
export const SUBSCRIPTION_MIN_DELAY_MS = 700;

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

export const SYSTEM = 'You are a code completion engine. Reply with only the exact text to insert at <CURSOR>: no explanation, no Markdown, no code fences, and nothing that is already before or after the cursor. Keep it short: finish the current statement or block. If nothing useful fits, reply with nothing.';

export function userPrompt(language: string, fileName: string, prefix: string, suffix: string) {
  return `Language: ${language}\nFile: ${fileName}\n\n${prefix.slice(-PREFIX_CHARS)}<CURSOR>${suffix.slice(0, SUFFIX_CHARS)}`;
}

/** The model's reply as text to insert: no fences, nothing the file already has, not too long. */
export function cleanCompletion(reply: string, prefix: string, suffix: string, cut = false): string | undefined {
  let text = reply.replace(/<\/?CURSOR>/g, '');
  const fence = /^\s*```[^\n]*\n([\s\S]*?)(?:\n?```\s*)?$/.exec(text);
  if (fence) text = fence[1];
  let lines = text.split('\n');
  if (cut && lines.length > 1) lines = lines.slice(0, -1); // the reply stopped mid-line
  text = lines.slice(0, MAX_LINES).join('\n');
  // repeated what is already typed on this line
  const typed = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (typed.trim() && text.startsWith(typed)) text = text.slice(typed.length);
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
export async function requestCompletion(p: Provider, key: string | undefined, model: string, system: string, user: string, signal: AbortSignal): Promise<CompletionReply> {
  const token = key ?? PRESETS.find((x) => x.id === p.preset)?.localToken ?? '';
  const res = await fetch(`${p.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': token, authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: model || p.model, max_tokens: MAX_TOKENS, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`${p.name}: HTTP ${res.status}`);
  const body: any = await res.json();
  const text = (body.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
  return { text, cut: body.stop_reason === 'max_tokens' };
}

/** Whether completions stay on this machine (the extension's machine: over SSH, the remote one). */
export const isLocal = (p: Provider) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(p.baseUrl);

export class CodeCompletion implements vscode.InlineCompletionItemProvider {
  private last?: { key: string; text: string | undefined };
  /** the latest failure, for the status bar; cleared by the next success */
  onStatus?: (error?: string) => void;

  constructor(
    private settings: () => CompletionSettings,
    private providers: () => CompletionSource[],
    private secret: (id: string) => Thenable<string | undefined>,
    private subscription?: (account: string, model: string, user: string, signal: AbortSignal) => Promise<CompletionReply>,
  ) {}

  async provideInlineCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, context: vscode.InlineCompletionContext, token: vscode.CancellationToken): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = this.settings();
    if (!s.enabled || !s.provider || isSensitive(doc.uri.fsPath)) return;
    if (context.selectedCompletionInfo) return; // the suggestions list is open: it goes first
    if (!worthSuggesting(doc.lineAt(pos.line).text.slice(pos.character))) return;
    const provider = this.providers().find((p) => p.id === s.provider);
    if (!provider) return;
    const offset = doc.offsetAt(pos);
    const all = doc.getText();
    const prefix = all.slice(Math.max(0, offset - PREFIX_CHARS), offset);
    const suffix = all.slice(offset, offset + SUFFIX_CHARS);
    if (!prefix.trim()) return;
    const key = `${s.provider}\0${s.model}\0${doc.languageId}\0${prefix}\0${suffix}`;
    let text: string | undefined;
    if (this.last?.key === key) text = this.last.text;
    else {
      // wait for a pause in typing: VS Code cancels this request on the next key, so nothing is sent
      await new Promise((r) => setTimeout(r, Math.max(isSubscription(provider) ? SUBSCRIPTION_MIN_DELAY_MS : 0, s.delayMs)));
      if (token.isCancellationRequested) return;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        const user = userPrompt(doc.languageId, path.basename(doc.uri.fsPath), prefix, suffix);
        const reply = isSubscription(provider)
          ? await this.subscription!(provider.account, s.model, user, abort.signal)
          : await requestCompletion(provider, provider.hasKey ? await this.secret(provider.id) : undefined, s.model, SYSTEM, user, abort.signal);
        text = cleanCompletion(reply.text, prefix, suffix, reply.cut);
        this.last = { key, text };
        this.onStatus?.();
      } catch (e) {
        if (!token.isCancellationRequested) this.onStatus?.(abort.signal.aborted ? `${provider.name}: no answer in ${TIMEOUT_MS / 1000} s` : String((e as Error)?.message ?? e));
        return;
      } finally {
        clearTimeout(timer);
        sub.dispose();
      }
    }
    if (!text || token.isCancellationRequested) return;
    return [new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos))];
  }
}

export function registerCodeCompletion(ctx: vscode.ExtensionContext) {
  const section = () => vscode.workspace.getConfiguration('steerhouse.codeCompletion');
  const settings = (): CompletionSettings => ({ enabled: section().get('enabled', false), provider: section().get('provider', ''), model: section().get('model', ''), delayMs: section().get('delayMs', 350) });
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
  const engine = new CodeCompletion(settings, providers, (id) => ctx.secrets.get(secretKey(id)), (account, model, user, signal) => {
    require('fs').mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
    return completerFor(account).complete(model, user, signal);
  });

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  item.command = 'steerhouse.codeCompletion.toggle';
  const paint = (error?: string) => {
    const s = settings();
    const name = providers().find((p) => p.id === s.provider)?.name;
    item.text = error ? '$(warning) Tab' : s.enabled ? '$(sparkle) Tab' : '$(circle-slash) Tab';
    item.tooltip = error ?? (s.enabled ? vscode.l10n.t('Code completion is on ({0}). Click to turn it off.', name ?? '?') : vscode.l10n.t('Code completion is off. Click to turn it on.'));
    item.show();
  };
  engine.onStatus = paint;
  paint();

  const toggle = async () => {
    const save = (k: string, v: unknown) => section().update(k, v, vscode.ConfigurationTarget.Global);
    if (settings().enabled) return save('enabled', false);
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('steerhouse.codeCompletion')) return;
      stopCompleters(); // the model or the account may have changed, and when off nothing stays warm
      paint();
    }),
    { dispose: stopCompleters },
  );
}
