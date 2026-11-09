// Right-click actions on files and folders in the Sessions tree, like the Explorer's: open, open to
// the side, reveal (in the Explorer, where every other extension's actions are, and in the OS file
// manager), find in folder, new file / folder, compare, copy path, rename, delete (to the trash).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type Node = { path?: string; dir?: boolean } | vscode.Uri | undefined;
const pathOf = (n: Node) => (n instanceof vscode.Uri ? n.fsPath : n?.path);
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Whether deleting can go to the system trash. VS Code's remote file systems (SSH, WSL, containers)
 * refuse `useTrash`, and extensions can't ask for that capability, so this follows the window's kind.
 */
export const canTrash = () => !vscode.env.remoteName;
/** Delete a file or folder: to the trash when there is one, otherwise permanently (say so first). */
export const removePath = (p: string) => vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: canTrash() });

/** Path for "Copy Relative Path": relative to the workspace folder that contains it. */
export function relativeTo(file: string, roots: string[]): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  for (const r of roots.map(norm).sort((a, b) => b.length - a.length))
    if (f.toLowerCase() === r.toLowerCase() || f.toLowerCase().startsWith(r.toLowerCase() + '/')) return f.slice(r.length + 1) || path.basename(f);
  return f;
}

/** A new file or folder name that is usable here (no separators going up, not empty, not taken). */
export function checkNewName(dir: string, name: string): string | undefined {
  const n = name.trim();
  if (!n) return vscode.l10n.t('Enter a name');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(n) || path.isAbsolute(n)) return vscode.l10n.t('Use a name inside this folder');
  if (fs.existsSync(path.join(dir, n))) return vscode.l10n.t('{0} already exists here', n);
  return undefined;
}

export function registerFileActions(ctx: vscode.ExtensionContext, refresh: () => void) {
  const roots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  let compareWith: string | undefined;
  const reg = (id: string, fn: (p: string) => unknown) =>
    ctx.subscriptions.push(
      vscode.commands.registerCommand(id, (n: Node) => {
        const p = pathOf(n);
        if (p) return fn(p);
      }),
    );

  reg('steerhouse.fs.openToSide', (p) => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), { viewColumn: vscode.ViewColumn.Beside, preview: false }));
  reg('steerhouse.fs.revealInExplorer', (p) => vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(p)));
  reg('steerhouse.fs.revealInOS', (p) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p)));
  reg('steerhouse.fs.findInFolder', (p) => vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: relativeTo(p, roots()) + '/**', triggerSearch: false }));
  reg('steerhouse.fs.copyPath', (p) => vscode.env.clipboard.writeText(p));
  reg('steerhouse.fs.copyRelativePath', (p) => vscode.env.clipboard.writeText(relativeTo(p, roots())));

  const create = async (p: string, folder: boolean) => {
    const dir = isDir(p) ? p : path.dirname(p);
    const name = await vscode.window.showInputBox({ title: folder ? vscode.l10n.t('New folder in {0}', path.basename(dir)) : vscode.l10n.t('New file in {0}', path.basename(dir)), validateInput: (v) => checkNewName(dir, v) });
    if (!name) return;
    const target = vscode.Uri.file(path.join(dir, name.trim()));
    if (folder) await vscode.workspace.fs.createDirectory(target);
    else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      await vscode.window.showTextDocument(target);
    }
    refresh();
  };
  reg('steerhouse.fs.newFile', (p) => create(p, false));
  reg('steerhouse.fs.newFolder', (p) => create(p, true));

  reg('steerhouse.fs.selectForCompare', (p) => {
    compareWith = p;
    vscode.commands.executeCommand('setContext', 'steerhouse.compareSelected', true);
    vscode.window.setStatusBarMessage(vscode.l10n.t('$(diff) Selected {0} for compare', path.basename(p)), 4000);
  });
  reg('steerhouse.fs.compareWithSelected', (p) => {
    if (!compareWith) return;
    return vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(compareWith), vscode.Uri.file(p), `${path.basename(compareWith)} ↔ ${path.basename(p)}`);
  });

  // rename through a workspace edit, so open editors and imports that VS Code tracks follow along
  reg('steerhouse.fs.rename', async (p) => {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const dot = base.lastIndexOf('.');
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Rename {0}', base), value: base, valueSelection: [0, dot > 0 && !isDir(p) ? dot : base.length], validateInput: (v) => (v.trim() === base ? undefined : checkNewName(dir, v)) });
    if (!name || name.trim() === base) return;
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(p), vscode.Uri.file(path.join(dir, name.trim())));
    await vscode.workspace.applyEdit(edit);
    refresh();
  });

  // delete asks first, then moves to the trash (recoverable) when the machine has one, like the Explorer
  reg('steerhouse.fs.delete', async (p) => {
    const base = path.basename(p);
    const ok = await vscode.window.showWarningMessage(
      isDir(p) ? vscode.l10n.t('Delete the folder {0} and everything in it?', base) : vscode.l10n.t('Delete {0}?', base),
      { modal: true, detail: canTrash() ? vscode.l10n.t('It moves to the trash (Recycle Bin), where you can restore it.') : vscode.l10n.t('This is a remote machine, which has no trash: it is deleted permanently. This cannot be undone.') },
      canTrash() ? vscode.l10n.t('Move to Trash') : vscode.l10n.t('Delete Permanently'),
    );
    if (!ok) return;
    await removePath(p);
    refresh();
  });
}
