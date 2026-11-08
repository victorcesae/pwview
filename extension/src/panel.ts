// The dashboard webview (React + shadcn, built into dist/webview).
import * as vscode from 'vscode';
import { loadComments } from './comments';
import { Engine, Session } from './engine';
import { buildGraph } from './graph';
import { loadLinks } from './links';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'openSession'; id: string; agentId?: string }
  | { type: 'overview' }
  | { type: 'openChange'; sessionId: string; changeId: string }
  | { type: 'openFile'; path: string }
  | { type: 'resume'; id: string }
  | { type: 'message'; id: string; text: string; mode?: 'steer' | 'queue' | 'now'; images?: { data: string; mime: string }[] }
  | { type: 'cancelComment'; commentId: string }
  | { type: 'promoteComment'; commentId: string }
  | { type: 'linkSession'; id: string }
  | { type: 'newSession' }
  | { type: 'installHooks' }
  | { type: 'savePrompt'; text: string };

export class Dashboard {
  private panel?: vscode.WebviewPanel;
  private sessionId?: string;
  private agentId?: string;

  constructor(
    private ctx: vscode.ExtensionContext,
    private sessions: () => Session[],
    private hooksOk: () => boolean,
    private attached: () => Set<string>,
    private onMessage: (m: FromWebview) => void,
  ) {}

  show(sessionId?: string, agentId?: string) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    if (!this.panel) {
      const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
      this.panel = vscode.window.createWebviewPanel('agentlens.dashboard', 'AgentLens', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [root],
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
      this.panel.webview.html = this.html(this.panel.webview, root);
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => {
        if (m.type === 'ready') this.post();
        else if (m.type === 'openSession') this.show(m.id, m.agentId);
        else if (m.type === 'overview') this.show();
        else this.onMessage(m);
      });
      this.panel.onDidDispose(() => (this.panel = undefined));
    }
    this.panel.reveal();
    this.post();
  }

  update() {
    if (this.panel) this.post();
  }

  toast(text: string) {
    this.panel?.webview.postMessage({ type: 'toast', text });
  }

  private post() {
    if (!this.panel) return;
    const sessions = this.sessions();
    const s = this.sessionId ? sessions.find((x) => x.info.id === this.sessionId) : undefined;
    this.panel.title = s ? `AgentLens · ${s.info.title.slice(0, 40)}` : 'AgentLens';
    if (!s) {
      this.panel.webview.postMessage({
        type: 'data',
        data: { view: 'overview', overview: { sessions: sessions.map((x) => x.info), hot: Engine.hotFiles(sessions), hooks: this.hooksOk(), graph: buildGraph(sessions, loadLinks()) } },
      });
      return;
    }
    const events = [...s.t.events, ...s.agents.flatMap((a) => a.t.events)].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-2500);
    const titles = Object.fromEntries(sessions.map((x) => [x.info.id, x.info.title]));
    this.panel.webview.postMessage({
      type: 'data',
      data: {
        view: 'session',
        focusAgent: this.agentId,
        session: {
          info: s.info,
          events,
          changes: Engine.allChanges(s),
          comments: loadComments().filter((c) => c.sessionId === s.info.id),
          terminal: this.attached().has(s.info.id),
          linkedTitles: Object.fromEntries(s.info.linked.map((id) => [id, titles[id] ?? id])),
        },
      },
    });
  }

  private html(webview: vscode.Webview, root: vscode.Uri) {
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
}
