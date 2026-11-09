// Source control per project in the Sessions tree, through VS Code's own Git extension (the same
// engine as the Source Control view): branch, ahead / behind, changed files with their diff,
// Commit, Push, Pull, Sync.
import * as path from 'path';
import * as vscode from 'vscode';

// ---- the slice of the Git extension API that is used (extensions/git/src/api/git.d.ts)
export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: number;
}
export interface GitRepo {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { name?: string; ahead?: number; behind?: number; upstream?: { remote: string; name: string } };
    readonly indexChanges: GitChange[];
    readonly workingTreeChanges: GitChange[];
    readonly untrackedChanges?: GitChange[];
    readonly mergeChanges: GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
  add(paths: string[]): Promise<void>;
  commit(message: string, opts?: { all?: boolean | 'tracked' }): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
  status(): Promise<void>;
}
interface GitApi {
  openRepository(root: vscode.Uri): Promise<GitRepo | null>;
  getRepository(uri: vscode.Uri): GitRepo | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

/** Status numbers of the Git API (Status enum) → letter shown next to a file, like the SCM view. */
const LETTER: Record<number, [string, string]> = {
  0: ['M', 'modified'],
  1: ['A', 'added'],
  2: ['D', 'deleted'],
  3: ['R', 'renamed'],
  4: ['C', 'copied'],
  5: ['M', 'modified'],
  6: ['D', 'deleted'],
  7: ['U', 'untracked'],
  9: ['A', 'added'],
  10: ['R', 'renamed'],
  11: ['T', 'type changed'],
};
export const statusLetter = (s: number): [string, string] => LETTER[s] ?? (s >= 12 ? ['!', 'conflict'] : ['?', 'changed']);

export interface ScmFile {
  path: string;
  /** staged (in the index) or not */
  staged: boolean;
  letter: string;
  label: string;
  conflict: boolean;
}

/** All changes of a repository, conflicts first, then staged, then the rest; no duplicates. */
export function scmFiles(state: GitRepo['state']): ScmFile[] {
  const seen = new Set<string>();
  const out: ScmFile[] = [];
  const add = (list: GitChange[] | undefined, staged: boolean, conflict = false) => {
    for (const c of list ?? []) {
      const key = `${staged}:${c.uri.fsPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [letter, label] = conflict ? ['!', 'conflict'] : statusLetter(c.status);
      out.push({ path: c.uri.fsPath, staged, letter, label, conflict });
    }
  };
  add(state.mergeChanges, false, true);
  add(state.indexChanges, true);
  add(state.workingTreeChanges, false);
  add(state.untrackedChanges, false);
  return out;
}

/** "main · ↑2 ↓1 · 3 changes" */
export function scmSummary(state: GitRepo['state'], t: (s: string, ...a: unknown[]) => string = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, i) => String(a[i]))): string {
  const h = state.HEAD;
  const n = scmFiles(state).length;
  const sync = h?.upstream ? `${h.ahead ? '↑' + h.ahead : ''}${h.ahead && h.behind ? ' ' : ''}${h.behind ? '↓' + h.behind : ''}` : t('not pushed');
  return [h?.name ?? t('detached'), sync, n ? t(n === 1 ? '{0} change' : '{0} changes', n) : t('clean')].filter(Boolean).join(' · ');
}

export class Scm {
  private api?: GitApi;
  private repos = new Map<string, GitRepo | null>();
  private listening = new Set<GitRepo>();

  constructor(private onChange: () => void) {}

  private async git(): Promise<GitApi | undefined> {
    if (this.api) return this.api;
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): GitApi }>('vscode.git');
    if (!ext) return undefined;
    const exp = ext.isActive ? ext.exports : await ext.activate();
    this.api = exp?.getAPI(1);
    return this.api;
  }

  /** The repository that contains this folder (opened once, then followed for changes). */
  async repo(folder: string): Promise<GitRepo | undefined> {
    if (this.repos.has(folder)) return this.repos.get(folder) ?? undefined;
    const api = await this.git();
    const uri = vscode.Uri.file(folder);
    const r = api ? (api.getRepository(uri) ?? (await api.openRepository(uri).catch(() => null))) : null;
    this.repos.set(folder, r);
    if (r && !this.listening.has(r)) {
      this.listening.add(r);
      let timer: ReturnType<typeof setTimeout> | undefined;
      r.state.onDidChange(() => {
        clearTimeout(timer);
        timer = setTimeout(() => this.onChange(), 300);
      });
    }
    return r ?? undefined;
  }

  /** Repo state if it is already open (sync, for tree labels); opens it in the background otherwise. */
  peek(folder: string): GitRepo | undefined {
    if (!this.repos.has(folder)) void this.repo(folder).then((r) => r && this.onChange());
    return this.repos.get(folder) ?? undefined;
  }

  async openDiff(folder: string, file: ScmFile) {
    const api = await this.git();
    const uri = vscode.Uri.file(file.path);
    const name = path.basename(file.path);
    if (!api || file.letter === 'U' || file.letter === 'A') return vscode.commands.executeCommand('vscode.open', uri);
    if (file.letter === 'D') return vscode.commands.executeCommand('vscode.open', api.toGitUri(uri, 'HEAD'));
    // staged: HEAD ↔ index; not staged: index ↔ working file (as the Source Control view shows)
    const left = api.toGitUri(uri, file.staged ? 'HEAD' : '~');
    const right = file.staged ? api.toGitUri(uri, '~') : uri;
    return vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${file.staged ? vscode.l10n.t('staged') : vscode.l10n.t('working tree')})`);
  }

  /** Commit: what is staged, or everything when nothing is (after asking). */
  async commit(folder: string) {
    const r = await this.repo(folder);
    if (!r) return;
    const files = scmFiles(r.state);
    if (!files.length) return vscode.window.showInformationMessage(vscode.l10n.t('Nothing to commit in {0}.', path.basename(folder)));
    const staged = files.filter((f) => f.staged).length;
    if (files.some((f) => f.conflict)) return vscode.window.showWarningMessage(vscode.l10n.t('Resolve the merge conflicts first.'));
    const message = await vscode.window.showInputBox({
      title: staged ? vscode.l10n.t('Commit {0} staged change(s) in {1}', staged, path.basename(folder)) : vscode.l10n.t('Commit all {0} change(s) in {1}', files.length, path.basename(folder)),
      prompt: vscode.l10n.t('Commit message'),
      validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter a commit message')),
    });
    if (!message) return;
    if (!staged) {
      // nothing staged: stage everything (also new files) and commit, like "Commit All"
      await r.add(files.map((f) => f.path));
    }
    await r.commit(message.trim());
    vscode.window.setStatusBarMessage(vscode.l10n.t('$(git-commit) Committed in {0}', path.basename(folder)), 4000);
  }

  async push(folder: string) {
    const r = await this.repo(folder);
    if (!r) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing {0}…', path.basename(folder)) }, () => r.push());
  }

  async pull(folder: string) {
    const r = await this.repo(folder);
    if (!r) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pulling {0}…', path.basename(folder)) }, () => r.pull());
  }

  async sync(folder: string) {
    await this.pull(folder);
    await this.push(folder);
  }
}
