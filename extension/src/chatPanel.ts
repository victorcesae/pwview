// Hosts AgentLens chats: one webview panel per ChatSession.
import * as vscode from 'vscode';
import { ChatSession, historyFromTranscript, Priority, type ChatPrefs } from './chat';
import { hostIcon } from './hostIcon';
import { findPrUrls, PrTracker } from './prs';
import { openUrl } from './browser';
import { vendorOf } from './providers';
import type { Session } from './engine';
import { addLink, briefing, loadLinks, removeLink, sameConnection } from './links';
import { agentExecutable } from './util';
import { accountEnv, type Account } from './accounts';

export type FromChat =
  | { type: 'ready' }
  | { type: 'send'; text: string; images: { data: string; mime: string }[]; priority: Priority }
  | { type: 'promote'; id: string; priority?: Priority }
  | { type: 'cancelQueued'; id: string }
  | { type: 'editQueued'; id: string; text: string }
  | { type: 'interrupt' }
  | { type: 'loadEarlier'; all?: boolean }
  | { type: 'openUrl'; url: string }
  | { type: 'revealFolder'; path: string }
  | { type: 'deleteSession' }
  | { type: 'contextDetail' }
  | { type: 'toggleMcp'; name: string; enabled: boolean }
  | { type: 'reconnectMcp'; name: string }
  | { type: 'manageConnectors' }
  | { type: 'retry' }
  | { type: 'respond'; id: string; decision: 'allow' | 'always' | 'deny'; message?: string; answers?: Record<string, string> }
  | { type: 'setModel'; model: string }
  | { type: 'setEffort'; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  | { type: 'setFast'; on: boolean }
  | { type: 'setUltracode'; on: boolean }
  | { type: 'setMode'; mode: 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' }
  | { type: 'openFile'; path: string }
  | { type: 'openChange'; changeId: string }
  | { type: 'link' }
  | { type: 'unlink'; id: string }
  | { type: 'openSession'; id: string };

interface Open {
  chat: ChatSession;
  panel: vscode.WebviewPanel;
  /** what the webview already has: item id -> serialized item, and the item order */
  sent?: { items: Map<string, string>; order: string[] };
  /** vendor whose mark is the tab icon */
  vendor?: string;
  /** last settings saved for its session */
  saved?: string;
  /** PR links seen in this chat */
  prUrls?: Set<string>;
  /** AgentLens account the chat runs on */
  accountId?: string;
  /** status at the last update, to notice "finished" and "needs you" */
  lastStatus?: string;
}

/** PR links in an item's text (answers, tool output). */
const itemPrUrls = (it: any): string[] => findPrUrls(`${it.text ?? ''}
${it.result ?? ''}`);

export class Chats {
  /** live status of the PRs the chats' agents opened */
  private prs = new PrTracker(() => this.refresh());
  private open: Open[] = [];

  constructor(
    private ctx: vscode.ExtensionContext,
    private sessions: () => Session[],
    private openSession: (id: string) => void,
  ) {}

  /** Tells you when a chat you're not looking at finishes or waits for an approval or an answer. */
  private notify(o: Open) {
    const s = o.chat.state;
    const prev = o.lastStatus;
    o.lastStatus = s.status;
    if (prev === s.status || !vscode.workspace.getConfiguration('agentlens').get<boolean>('notifications', true)) return;
    const watching = o.panel.active && o.panel.visible && vscode.window.state.focused;
    if (watching) return;
    const title = s.title.slice(0, 60);
    const msg =
      prev === 'working' && s.status === 'idle'
        ? vscode.l10n.t('"{0}" finished.', title)
        : s.status === 'waiting'
          ? vscode.l10n.t('"{0}" needs you: an approval or an answer.', title)
          : s.status === 'error'
            ? vscode.l10n.t('"{0}" stopped with an error.', title)
            : undefined;
    if (!msg) return;
    const open = vscode.l10n.t('Open');
    (s.status === 'error' ? vscode.window.showErrorMessage : vscode.window.showInformationMessage)(msg, open).then((a) => a === open && o.panel.reveal());
  }

  /** Connects a new MCP server to the open chats in that folder. */
  async addMcp(cwd: string, name: string, config: Record<string, unknown>) {
    const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const here = this.open.filter((o) => key(o.chat.state.cwd) === key(cwd));
    await Promise.all(here.map((o) => o.chat.addMcp(name, config).catch(() => undefined)));
    return here.length;
  }

  /** Closes the chat showing this session, if any. */
  closeSession(sessionId: string) {
    this.find(sessionId)?.panel.dispose();
  }

  /** Open chats (folder, session, title): for tests. */
  describe() {
    return this.open.map((o) => ({ cwd: o.chat.state.cwd, sessionId: o.chat.state.sessionId, title: o.chat.state.title }));
  }

  /** Session ids currently driven by an AgentLens chat (a resumed session belongs to the chat). */
  activeIds() {
    return new Set(this.open.map((o) => o.chat.state.sessionId).filter((x): x is string => !!x));
  }

  find(sessionId: string) {
    return this.open.find((o) => o.chat.state.sessionId === sessionId);
  }

  private static PREFS = 'agentlens.chatPrefs';
  /** Settings per session id, so a resumed chat (or one reopened by Reload Window) keeps them. */
  prefsOf(sessionId?: string): ChatPrefs | undefined {
    return sessionId ? this.ctx.globalState.get<Record<string, ChatPrefs & { at: number }>>(Chats.PREFS, {})[sessionId] : undefined;
  }
  private savePrefs(o: Open) {
    const s = o.chat.state;
    if (!s.sessionId) return;
    const p: ChatPrefs = { model: s.model, effort: s.effort, permissionMode: s.permissionMode, fastMode: s.fastMode, ultracode: s.ultracode };
    const key = JSON.stringify(p);
    if (o.saved === key) return;
    o.saved = key;
    const all = { ...this.ctx.globalState.get<Record<string, ChatPrefs & { at: number }>>(Chats.PREFS, {}), [s.sessionId]: { ...p, at: Date.now() } };
    // keep the 300 most recent sessions
    const keep = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 300);
    this.ctx.globalState.update(Chats.PREFS, Object.fromEntries(keep));
  }

  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string; account?: Account; env?: Record<string, string>; panel?: vscode.WebviewPanel }) {
    if (opts.resume) {
      const existing = this.find(opts.resume);
      if (existing) {
        opts.panel?.dispose();
        return existing.panel.reveal();
      }
    }
    const exe = agentExecutable();
    if (!exe) {
      vscode.window.showErrorMessage('AgentLens: Claude Code was not found. Install it (or set agentlens.agentCommand) to use the chat.');
      return;
    }
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    // a tab VS Code brought back after Reload Window is reused in place
    const panel =
      opts.panel ??
      vscode.window.createWebviewPanel('agentlens.chat', opts.title ?? 'AgentLens chat', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [root],
      });
    if (opts.panel) panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.iconPath = { light: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon-light.svg'), dark: vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon-dark.svg') };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transcript = opts.resume ? this.sessions().find((s) => s.info.id === opts.resume)?.path : undefined;
    const history = transcript ? historyFromTranscript(transcript) : undefined;
    const chat = new ChatSession({ cwd: opts.cwd, resume: opts.resume, title: opts.title, executable: exe, history, account: opts.account && { name: opts.account.name, env: opts.env ?? accountEnv(opts.account), provider: opts.account.provider?.preset }, prefs: this.prefsOf(opts.resume), host: vscode.env.appName, hostIcon: hostIcon(vscode.env.appRoot, vscode.env.appName), model: opts.account?.provider?.model }, () => {
      // throttle streaming updates to ~25 fps
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        this.post(entry);
      }, 40);
    });
    const entry: Open = { chat, panel, accountId: opts.account?.id };
    this.open.push(entry);
    panel.webview.html = html(panel.webview, root);
    panel.webview.onDidReceiveMessage((m: FromChat) => this.onMessage(entry, m));
    panel.onDidDispose(() => {
      chat.close();
      this.open = this.open.filter((o) => o !== entry);
    });
    chat.start();
    if (opts.prompt) chat.send(opts.prompt, [], 'later');
  }

  /** Re-post linked-session info (titles/states change as sessions progress). */
  refresh() {
    for (const o of this.open) this.post(o);
  }

  linkInto(sessionId: string, other: Session) {
    const o = this.find(sessionId);
    if (!o) return false;
    addLink(sessionId, other.info.id);
    o.chat.attachContext(briefing(other), `Linked "${other.info.title}"`);
    return true;
  }

  private post(o: Open) {
    const s = o.chat.state;
    this.savePrefs(o);
    this.notify(o);
    o.panel.title = s.title.slice(0, 40);
    // tab icon: the model's vendor mark (Claude, GPT, Llama…)
    const vendor = s.model ? vendorOf(s.model) : s.account.gateway ? 'other' : 'anthropic';
    if (o.vendor !== vendor) {
      o.vendor = vendor;
      o.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'vendors', `${vendor}.svg`);
    }
    const all = this.sessions();
    const linked = s.sessionId ? (loadLinks()[s.sessionId] ?? []) : [];
    const linkedInfo = linked.map((id) => {
      const x = all.find((y) => y.info.id === id);
      return { id, title: x?.info.title ?? id.slice(0, 8), state: x?.info.state ?? 'idle', activity: x?.t.events.at(-1)?.text?.slice(0, 120) };
    });
    const { items, ...rest } = s;
    const prsOf = (list: typeof items) => {
      o.prUrls ??= new Set();
      const fresh = list.flatMap(itemPrUrls).filter((u) => !o.prUrls!.has(u));
      for (const u of fresh) o.prUrls.add(u);
      if (fresh.length) this.prs.track(fresh);
      return Object.fromEntries([...o.prUrls].map((u) => [u, this.prs.get(u) ?? { state: 'unknown', checked: 0 }]));
    };
    if (!o.sent) {
      // first paint: the whole conversation once
      o.sent = { items: new Map(items.map((it) => [it.id, JSON.stringify(it)])), order: items.map((it) => it.id) };
      o.panel.webview.postMessage({ type: 'data', data: { view: 'chat', chat: { ...s, prs: prsOf(items) }, linked: linkedInfo } });
      return;
    }
    // afterwards only items that are new or changed. Old finished items don't change, so only the
    // recent tail and anything still live is compared: cheap even for very long chats.
    const live = new Set(['running', 'pending', 'waiting']);
    const tail = Math.max(0, items.length - 60);
    const upserts = items.filter((it, i) => {
      const prev = o.sent!.items.get(it.id);
      if (prev !== undefined && i < tail && !(it as any).streaming && !live.has((it as any).status)) return false;
      const json = JSON.stringify(it);
      if (json === prev) return false;
      o.sent!.items.set(it.id, json);
      return true;
    });
    const order = items.map((it) => it.id);
    const orderChanged = order.length !== o.sent.order.length || order.some((id, i) => id !== o.sent!.order[i]);
    if (orderChanged) o.sent.order = order;
    o.panel.webview.postMessage({ type: 'chatPatch', chat: { ...rest, prs: prsOf(upserts) }, upserts, order: orderChanged ? order : undefined, linked: linkedInfo });
  }

  private async onMessage(o: Open, m: FromChat) {
    const c = o.chat;
    switch (m.type) {
      case 'ready':
        o.sent = undefined; // (re)load: send everything
        return this.post(o);
      case 'send':
        return c.send(m.text, m.images, m.priority);
      case 'promote':
        return c.promote(m.id, m.priority);
      case 'editQueued':
        return c.editQueued(m.id, m.text);
      case 'cancelQueued':
        return c.cancelQueued(m.id);
      case 'retry':
        return c.retry();
      case 'toggleMcp':
        return c.toggleMcp(m.name, m.enabled).catch((e) => vscode.window.showWarningMessage(`AgentLens: ${m.name}: ${e?.message ?? e}`));
      case 'reconnectMcp':
        return c.reconnectMcp(m.name).catch((e) => vscode.window.showWarningMessage(`AgentLens: ${m.name}: ${e?.message ?? e}`));
      case 'manageConnectors':
        return vscode.commands.executeCommand('agentlens.manageConnectors', c.state.cwd);
      case 'contextDetail':
        return c.contextDetail().catch(() => {});
      case 'loadEarlier':
        return c.loadEarlier(m.all);
      case 'interrupt':
        return c.interrupt();
      case 'respond':
        return c.respond(m.id, m.decision, m.message, m.answers);
      case 'setModel':
        return c.setModel(m.model);
      case 'setEffort':
        return c.setEffort(m.effort).catch((e) => vscode.window.showWarningMessage(`AgentLens: effort not changed: ${e?.message ?? e}`));
      case 'setFast':
        return c.setFastMode(m.on).catch((e) => vscode.window.showWarningMessage(`AgentLens: fast mode not available: ${e?.message ?? e}`));
      case 'setUltracode':
        return c.setUltracode(m.on).catch((e) => vscode.window.showWarningMessage(`AgentLens: ultracode not available: ${e?.message ?? e}`));
      case 'setMode':
        return c.setPermissionMode(m.mode);
      case 'deleteSession':
        return c.state.sessionId && vscode.commands.executeCommand('agentlens.deleteSession', c.state.sessionId);
      case 'revealFolder':
        return vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(m.path));
      case 'openUrl':
        return openUrl(m.url);
      case 'openFile':
        return vscode.window.showTextDocument(vscode.Uri.file(m.path));
      case 'openChange':
        return c.state.sessionId && vscode.commands.executeCommand('agentlens.openChange', c.state.sessionId, m.changeId);
      case 'openSession':
        return this.find(m.id) ? this.find(m.id)!.panel.reveal() : this.openSession(m.id);
      case 'unlink':
        if (c.state.sessionId) removeLink(c.state.sessionId, m.id);
        return this.post(o);
      case 'link': {
        // only sessions on the same account, with the same kind of model
        const me = { account: o.accountId ?? this.sessions().find((s) => s.info.id === c.state.sessionId)?.info.account, model: c.state.model };
        const others = this.sessions().filter((s) => s.info.id !== c.state.sessionId);
        const same = others.filter((s) => sameConnection(s.info, me));
        if (!same.length) {
          vscode.window.showInformationMessage(others.length ? vscode.l10n.t('No other session uses the same account and model provider ({0} on other accounts).', others.length) : vscode.l10n.t('No other session to link.'));
          return;
        }
        const pick = await vscode.window.showQuickPick(
          same.map((s) => ({ label: s.info.title, description: `${s.info.state} · ${s.info.project.split(/[\\/]/).pop()}`, s })),
          {
            placeHolder: vscode.l10n.t('Link which session? This agent will see what it is doing.'),
            title: same.length < others.length ? vscode.l10n.t('Same account only · {0} sessions on other accounts hidden', others.length - same.length) : undefined,
          },
        );
        if (!pick) return;
        if (c.state.sessionId) addLink(c.state.sessionId, pick.s.info.id);
        c.attachContext(briefing(pick.s), `Linked "${pick.s.info.title}"`);
        return this.post(o);
      }
    }
  }
}

function html(webview: vscode.Webview, root: vscode.Uri) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
  return `<!doctype html>
<html lang="${vscode.env.language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
}
