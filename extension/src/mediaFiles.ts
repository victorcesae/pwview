// Local files the chat previews (images, video, audio, PDFs, documents the agent wrote or
// mentioned): which exist, their size and webview URI, and the Open / Reveal / Open externally
// actions of their cards. The webview only guesses paths; this is the source of truth.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Folders the chat webview may load files from, besides its own bundle. */
export function mediaRoots(cwd: string): vscode.Uri[] {
  const dirs = [cwd, ...(vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath), os.tmpdir()];
  return [...new Set(dirs.map((d) => path.resolve(d)))].map((d) => vscode.Uri.file(d));
}

/** `~/x`, `./x`, `x` (from the chat folder), `/abs/x`, `C:\x` → an absolute path. */
export function resolveMention(raw: string, cwd: string): string {
  const p = raw.replace(/^file:\/\//, '');
  if (/^~[\\/]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

const inside = (file: string, dir: string) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export type FileInfo = { path: string; name: string; size: number; uri?: string };

/** Answers a batch of candidate paths: null for ones that don't exist or aren't files. */
export async function fileInfos(paths: string[], cwd: string, webview: vscode.Webview) {
  const roots = mediaRoots(cwd).map((u) => u.fsPath);
  return Promise.all(
    paths.slice(0, 200).map(async (key) => {
      try {
        const abs = resolveMention(key, cwd);
        const st = await fs.promises.stat(abs);
        if (!st.isFile()) return { key, info: null };
        // outside the allowed roots the webview can't load it: a file card without a preview
        const uri = roots.some((r) => inside(abs, r)) ? webview.asWebviewUri(vscode.Uri.file(abs)).toString() : undefined;
        const info: FileInfo = { path: abs, name: path.basename(abs), size: st.size, uri };
        return { key, info };
      } catch {
        return { key, info: null };
      }
    }),
  );
}

/** Whether an installed extension opens PDFs in an editor (VS Code itself can't). */
const pdfViewer = () =>
  vscode.extensions.all.some((e) => (e.packageJSON?.contributes?.customEditors ?? []).some((c: { selector?: { filenamePattern?: string }[] }) => c.selector?.some((s) => /pdf/i.test(s.filenamePattern ?? ''))));
/** Binary formats VS Code has no editor for: hand them to the system. */
const SYSTEM = /\.(docx?|xlsx?|pptx?|od[tsp]|rtf|zip|tar|gz|tgz|7z|epub)$/i;

export async function mediaAction(file: string, action: 'open' | 'reveal' | 'external') {
  const uri = vscode.Uri.file(file);
  if (action === 'reveal') return vscode.commands.executeCommand('revealFileInOS', uri);
  if (action === 'external' || SYSTEM.test(file) || (/\.pdf$/i.test(file) && !pdfViewer())) return vscode.env.openExternal(uri);
  try {
    await vscode.commands.executeCommand('vscode.open', uri);
  } catch {
    await vscode.env.openExternal(uri);
  }
}

/** The lightbox's "Open in editor": a local image as is, a pasted / tool image via a temp file. */
export async function openMedia(file?: string, data?: string) {
  if (file) return mediaAction(file, 'open');
  const m = data && /^data:image\/([\w+.-]+);base64,(.*)$/s.exec(data);
  if (!m) return;
  const ext = m[1] === 'svg+xml' ? 'svg' : m[1] === 'jpeg' ? 'jpg' : m[1];
  const dir = path.join(os.tmpdir(), 'steerhouse-images');
  await fs.promises.mkdir(dir, { recursive: true });
  const out = path.join(dir, `image-${Date.now()}.${ext}`);
  await fs.promises.writeFile(out, Buffer.from(m[2], 'base64'));
  return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(out));
}
