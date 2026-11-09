// Watch the shared browser in a VS Code tab. Steerhouse runs where the browser runs, so this reads
// Chrome's DevTools port directly: nothing to forward, and it works in both pwview modes.
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import WebSocket from 'ws';

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** The tabs worth showing: real pages, not Chrome's own toolbars and pop-ups. */
export const visiblePages = (targets: CdpTarget[]) => targets.filter((t) => t.type === 'page' && !!t.webSocketDebuggerUrl && !/^(chrome|devtools|chrome-untrusted|chrome-extension):/.test(t.url));

/** Frames of one tab, as base64 JPEG. Asks for the next frame only after each one is handled. */
export class Screencast {
  private ws: WebSocket;
  private seq = 0;
  constructor(url: string, onFrame: (jpeg: string) => void, onClose: () => void) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ws.on('open', () => this.call('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1000, everyNthFrame: 1 }));
    this.ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.method !== 'Page.screencastFrame') return;
      onFrame(m.params.data);
      this.call('Page.screencastFrameAck', { sessionId: m.params.sessionId });
    });
    this.ws.on('close', onClose);
    this.ws.on('error', () => this.ws.terminate());
  }
  private call(method: string, params: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ id: ++this.seq, method, params }));
  }
  close() {
    this.ws.removeAllListeners('close');
    this.ws.on('error', () => {});
    this.ws.terminate();
  }
}

export class LiveBrowser {
  private panel: vscode.WebviewPanel;
  private cast?: Screencast;
  private shown?: string;
  private poll: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(name: string, private port: number, onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel('steerhouse.liveBrowser', vscode.l10n.t('Browser · {0}', name), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    this.panel.webview.html = page(this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((m: { type: string; id?: string }) => {
      if (m.type === 'ready') this.tick();
      if (m.type === 'tab' && m.id) this.tick(m.id);
    });
    this.panel.onDidDispose(() => {
      this.closed = true;
      clearInterval(this.poll);
      this.cast?.close();
      onDispose();
    });
    this.poll = setInterval(() => this.tick(), 1500);
  }

  reveal() {
    this.panel.reveal();
  }
  dispose() {
    this.panel.dispose();
  }

  private post(message: unknown) {
    if (!this.closed) this.panel.webview.postMessage(message);
  }

  /** Follows the tabs: keeps showing the chosen one, else the newest page. */
  private async tick(choose?: string) {
    let tabs: CdpTarget[] = [];
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      tabs = visiblePages((await res.json()) as CdpTarget[]);
    } catch {
      /* the browser is stopped: the page says so */
    }
    if (this.closed) return;
    const next = tabs.find((t) => t.id === choose) ?? tabs.find((t) => t.id === this.shown) ?? tabs[0];
    this.post({ type: 'tabs', tabs: tabs.map((t) => ({ id: t.id, title: t.title || t.url, url: t.url })), current: next?.id });
    if (next?.id === this.shown) return;
    this.cast?.close();
    this.cast = undefined;
    this.shown = next?.id;
    if (next?.webSocketDebuggerUrl)
      this.cast = new Screencast(next.webSocketDebuggerUrl, (data) => this.post({ type: 'frame', data }), () => {
        this.shown = undefined; // the tab closed: pick another on the next tick
      });
  }
}

function page(cspSource: string) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const stopped = vscode.l10n.t('The browser is not running. It starts when the agent first uses it.');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{margin:0;padding:0;height:100vh;display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}
header{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border)}
select{max-width:45%;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}
#url{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:.8}
main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
img{max-width:100%;max-height:100%;object-fit:contain}
[hidden]{display:none}
</style></head><body>
<header><select id="tabs" aria-label="Tabs"></select><span id="url"></span></header>
<main><img id="screen" alt="" hidden><p id="empty">${stopped.replace(/[<&]/g, '')}</p></main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const [tabs, url, screen, empty] = ['tabs', 'url', 'screen', 'empty'].map((id) => document.getElementById(id));
tabs.onchange = () => vscode.postMessage({ type: 'tab', id: tabs.value });
addEventListener('message', ({ data: m }) => {
  if (m.type === 'frame') {
    screen.src = 'data:image/jpeg;base64,' + m.data;
    screen.hidden = false;
    empty.hidden = true;
  }
  if (m.type === 'tabs') {
    tabs.replaceChildren(...m.tabs.map((t) => Object.assign(document.createElement('option'), { value: t.id, textContent: t.title, selected: t.id === m.current })));
    url.textContent = m.tabs.find((t) => t.id === m.current)?.url ?? '';
    if (!m.tabs.length) {
      screen.hidden = true;
      empty.hidden = false;
    }
  }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
