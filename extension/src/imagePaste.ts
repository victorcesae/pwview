// Paste an image from YOUR clipboard into an agent running on a remote (SSH) host.
// Claude Code reads the clipboard of the machine it runs on, so over SSH a local screenshot
// never reaches it. Webviews run locally (they can see your clipboard); the extension runs
// on the host. So: paste into a small webview → save the file on the host → type its path
// into the terminal, which Claude Code turns into an image attachment.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function imageDir() {
  return path.join(os.tmpdir(), 'steerhouse-images');
}

export function saveImage(dataUrl: string, mime: string): string {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('not an image');
  fs.mkdirSync(imageDir(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const file = path.join(imageDir(), `paste-${stamp}-${Math.random().toString(36).slice(2, 6)}.${EXT[mime] ?? 'png'}`);
  fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
  return file;
}

const quote = (p: string) => (/\s/.test(p) ? `"${p}"` : p);

export function registerImagePaste(ctx: vscode.ExtensionContext) {
  let panel: vscode.WebviewPanel | undefined;
  let target: vscode.Terminal | undefined;

  const deliver = async (files: string[]) => {
    const text = files.map(quote).join(' ') + ' ';
    const term = target && vscode.window.terminals.includes(target) ? target : vscode.window.activeTerminal;
    await vscode.env.clipboard.writeText(text.trim());
    if (term) {
      term.show(false);
      term.sendText(text, false); // typed, not submitted: keep writing your prompt
      vscode.window.setStatusBarMessage(`$(file-media) Image attached to "${term.name}"`, 4000);
    } else {
      vscode.window.showInformationMessage(`Image saved on the host. Path copied: ${text.trim()}`);
    }
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('steerhouse.pasteImage', () => {
      target = vscode.window.activeTerminal;
      if (panel) {
        panel.reveal(vscode.ViewColumn.Beside, false);
        return;
      }
      panel = vscode.window.createWebviewPanel('steerhouse.pasteImage', 'Paste image for the agent', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true });
      panel.webview.html = html(panel.webview.cspSource);
      panel.webview.onDidReceiveMessage(async (m: { type: string; images?: { data: string; mime: string }[] }) => {
        if (m.type === 'cancel') return panel?.dispose();
        if (m.type !== 'images' || !m.images?.length) return;
        try {
          const files = m.images.map((i) => saveImage(i.data, i.mime));
          panel?.dispose();
          await deliver(files);
        } catch (e) {
          vscode.window.showErrorMessage(`Steerhouse: could not save the image: ${e}`);
        }
      });
      panel.onDidDispose(() => (panel = undefined));
    }),
  );
}

function html(csp: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${csp}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; display: grid; place-items: center; font: 13px var(--vscode-font-family);
         color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .box { width: min(520px, 90vw); padding: 36px 28px; text-align: center; border-radius: 14px;
         border: 1.5px dashed var(--vscode-panel-border); background: var(--vscode-sideBar-background); outline: none; }
  .box.over, .box:focus { border-color: var(--vscode-focusBorder); }
  h1 { font-size: 15px; margin: 10px 0 6px; font-weight: 600; }
  p { margin: 4px 0; color: var(--vscode-descriptionForeground); }
  kbd { font: 12px var(--vscode-editor-font-family); padding: 1px 6px; border-radius: 4px;
        border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
  svg { opacity: .8 }
  .err { color: var(--vscode-errorForeground); margin-top: 10px; min-height: 1em; }
</style></head>
<body>
  <div class="box" id="box" tabindex="0">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>
    <h1>Press <kbd>Ctrl</kbd> + <kbd>V</kbd> to send the image to the agent</h1>
    <p>or drop image files here · <kbd>Esc</kbd> to cancel</p>
    <p>It's saved on the remote host and its path is typed into your terminal.</p>
    <div class="err" id="err"></div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const box = document.getElementById('box');
  const err = document.getElementById('err');
  box.focus();
  window.addEventListener('focus', () => box.focus());
  const read = (blob) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok({ data: r.result, mime: blob.type || 'image/png' }); r.onerror = bad; r.readAsDataURL(blob); });
  async function send(blobs) {
    const imgs = blobs.filter((b) => b && b.type.startsWith('image/'));
    if (!imgs.length) { err.textContent = 'No image found. Copy a screenshot or an image first.'; return; }
    vscode.postMessage({ type: 'images', images: await Promise.all(imgs.map(read)) });
  }
  document.addEventListener('paste', (e) => { e.preventDefault(); send([...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile())); });
  document.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
  document.addEventListener('dragleave', () => box.classList.remove('over'));
  document.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); send([...(e.dataTransfer?.files || [])]); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
</script></body></html>`;
}
