// Which folder a new chat works in: when the workspace holds several repositories, ask.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target']);

/** Git repositories at or below this folder. A repository's own subfolders are not searched. */
export function findRepos(root: string, depth = 2): string[] {
  if (fs.existsSync(path.join(root, '.git'))) return [root];
  if (depth <= 0) return [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .flatMap((e) => findRepos(path.join(root, e.name), depth - 1));
}

/** Workspace folders and the repositories inside them, the last used first, then by name. */
export function folderChoices(roots: string[], last?: string): string[] {
  const all = [...new Set(roots.flatMap((r) => [r, ...findRepos(r)]))];
  const byName = (a: string, b: string) => path.basename(a).localeCompare(path.basename(b));
  return all.sort((a, b) => Number(b === last) - Number(a === last) || Number(roots.includes(b)) - Number(roots.includes(a)) || byName(a, b));
}

/** The folder for a new chat. Asks only when there is a choice to make. */
export async function pickFolder(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const browse = async () => (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: vscode.l10n.t('Folder for the new chat') }))?.[0]?.fsPath;
  const lastKey = 'steerhouse.lastFolder';
  const choices = folderChoices(roots, ctx.globalState.get<string>(lastKey));
  if (choices.length === 0) return browse();
  if (choices.length === 1) return choices[0];
  type Item = vscode.QuickPickItem & { dir?: string };
  const isRepo = (d: string) => fs.existsSync(path.join(d, '.git'));
  const items: Item[] = [
    ...choices.map((dir): Item => ({ label: `$(${isRepo(dir) ? 'repo' : 'folder'}) ${path.basename(dir) || dir}`, description: dir, dir })),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(folder-opened) ' + vscode.l10n.t('Browse…') },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('New chat'), placeHolder: vscode.l10n.t('Which folder or repository should it work in?'), matchOnDescription: true });
  if (!pick) return undefined;
  const dir = pick.dir ?? (await browse());
  if (dir) await ctx.globalState.update(lastKey, dir);
  return dir;
}

/** Glob for a typed part of a file path: anywhere in the tree, in any case, its special characters taken literally. */
export function filePattern(query: string): string {
  const safe = [...query].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : /[\\*?[\]{}()!]/.test(c) ? `[${c}]` : c)).join('');
  return `**/*${safe}*`;
}

/** Files for the chat box's @ completion, relative to the chat's folder (which may be outside the workspace). */
export async function completeFiles(cwd: string, query: string): Promise<string[]> {
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(cwd), filePattern(query)), '**/{node_modules,.git,dist,build,target}/**', 8);
  return found.map((u) => path.relative(cwd, u.fsPath).replace(/\\/g, '/'));
}
