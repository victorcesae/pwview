// Hosts AgentLens chats: one webview panel per ChatSession.
import * as vscode from 'vscode';
import { ChatSession, historyFromTranscript, Priority } from './chat';
import { hostIcon } from './hostIcon';
import { openUrl } from './browser';
import { vendorOf } from './providers';
import type { Session } from './engine';
import { addLink, briefing, loadLinks, removeLink } from './links';
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
}

export class Chats {
  private open: Open[] = [];

  constructor(
    private ctx: vscode.ExtensionContext,
    private sessions: () => Session[],
    private openSession: (id: string) => void,
  ) {}

  /** Session ids currently driven by an AgentLens chat (a resumed session belongs to the chat). */
  activeIds() {
    return new Set(this.open.map((o) => o.chat.state.sessionId).filter((x): x is string => !!x));
  }

  find(sessionId: string) {
    return this.open.find((o) => o.chat.state.sessionId === sessionId);
  }

  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string; account?: Account; env?: Record<string, string> }) {
    if (opts.resume) {
      const existing = this.find(opts.resume);
      if (existing) return existing.panel.reveal();
    }
    const exe = agentExecutable();
    if (!exe) {
      vscode.window.showErrorMessage('AgentLens: Claude Code was not found. Install it (or set agentlens.agentCommand) to use the chat.');
      return;
    }
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('agentlens.chat', opts.title ?? 'AgentLens chat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const transcript = opts.resume ? this.sessions().find((s) => s.info.id === opts.resume)?.path : undefined;
    const history = transcript ? historyFromTranscript(transcript) : undefined;
    const chat = new ChatSession({ cwd: opts.cwd, resume: opts.resume, title: opts.title, executable: exe, history, account: opts.account && { name: opts.account.name, env: opts.env ?? accountEnv(opts.account), provider: opts.account.provider?.preset }, host: vscode.env.appName, hostIcon: hostIcon(vscode.env.appRoot, vscode.env.appName), model: opts.account?.provider?.model }, () => {
      // throttle streaming updates to ~25 fps
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        this.post(entry);
      }, 40);
    });
    const entry: Open = { chat, panel };
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
    if (!o.sent) {
      // first paint: the whole conversation once
      o.sent = { items: new Map(items.map((it) => [it.id, JSON.stringify(it)])), order: items.map((it) => it.id) };
      o.panel.webview.postMessage({ type: 'data', data: { view: 'chat', chat: s, linked: linkedInfo } });
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
    o.panel.webview.postMessage({ type: 'chatPatch', chat: rest, upserts, order: orderChanged ? order : undefined, linked: linkedInfo });
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
        const others = this.sessions().filter((s) => s.info.id !== c.state.sessionId);
        const pick = await vscode.window.showQuickPick(
          others.map((s) => ({ label: s.info.title, description: `${s.info.state} · ${s.info.project.split(/[\\/]/).pop()}`, s })),
          { placeHolder: 'Link which session? This agent will see what it is doing.' },
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
