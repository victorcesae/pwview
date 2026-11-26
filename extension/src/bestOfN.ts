// Best of N: the same prompt run N times in parallel, each chat in its own git worktree (from the
// current HEAD), then a Compare panel shows the runs side by side: status, time, cost, the diffs.
// One can be applied to the original working tree; a judge chat can recommend one.
import { spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatSession } from './chat';
import { TreeFile, workingTree } from './gitActions';
import { addWorktree, git, removeWorktree, repoRoot } from './worktree';

// ---------- pure helpers (unit tested) ----------

export const MIN_N = 2;
export const MAX_N = 4;
export const clampN = (n: number) => Math.min(MAX_N, Math.max(MIN_N, Math.round(Number.isFinite(n) ? n : MIN_N)));

/** steerhouse/bon-<short>-<i> (i from 1). */
export const bonBranch = (short: string, i: number) => `steerhouse/bon-${short}-${i}`;

/** A short id for one Best of N batch, safe in a branch name. */
export const bonShort = (now = Date.now(), rnd = Math.random()) => (now.toString(36).slice(-4) + Math.floor(rnd * 1296).toString(36).padStart(2, '0')).toLowerCase();

export const runTitle = (i: number, model?: string) => `Best of N · run ${i} · ${model || 'default'}`;

/** Totals of a diff: files, lines added, lines removed. */
export function diffStats(files: { added: number; removed: number }[]) {
  return { files: files.length, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) };
}

/** Keeps the first `max` characters of a diff, saying how much was cut. */
export function capText(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} more characters]`;
}

/** The judge's prompt: the task and each run's diff (each capped so the whole fits). */
export function judgePrompt(task: string, runs: { label: string; diff: string }[], totalCap = 120_000) {
  const each = Math.max(2000, Math.floor(totalCap / Math.max(1, runs.length)));
  const parts = runs.map((r, i) => `## Candidate ${i + 1}: ${r.label}\n\n\`\`\`diff\n${r.diff.trim() ? capText(r.diff, each) : '(no changes)'}\n\`\`\``);
  return [
    `I ran the same task ${runs.length} times in parallel, each in its own git worktree. Compare the ${runs.length} results below and recommend one.`,
    `For each candidate: does it do the task, is it correct, what does it miss or break, how big and clean is the change. Then say which one to apply (and anything worth taking from the others). Do not edit files.`,
    `## Task\n\n${task}`,
    ...parts,
  ].join('\n\n');
}

// ---------- the runs and the Compare panel ----------

export type RunModel = string | undefined;
type Run = {
  i: number;
  model?: string;
  branch: string;
  dir: string;
  chat?: ChatSession;
  started: number;
  finished?: number;
  files: TreeFile[];
  error?: string;
  sawWork?: boolean;
};

export type BestOfNDeps = {
  /** opens a chat in `cwd` and sends the prompt; undefined when it couldn't start */
  startChat: (cwd: string, title: string, prompt: string, model?: string) => Promise<ChatSession | undefined>;
  /** brings an open chat's tab to the front */
  reveal: (chat: ChatSession) => void;
  /** a judge chat in the original folder */
  judge: (cwd: string, title: string, prompt: string) => Promise<unknown>;
};

/** Asks for the prompt, N and the models, then creates the worktrees, opens the chats and the Compare panel. */
export async function bestOfN(ctx: vscode.ExtensionContext, deps: BestOfNDeps, from: { cwd?: string; prompt?: string; model?: string; models?: { value: string; displayName: string }[] }) {
  const cwd = from.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
  const root = await repoRoot(cwd);
  if (!root) return vscode.window.showWarningMessage(vscode.l10n.t('{0} is not in a git repository.', path.basename(cwd)));
  const prompt = await vscode.window.showInputBox({ title: vscode.l10n.t('Best of N: prompt'), prompt: vscode.l10n.t('The same prompt goes to every run.'), value: from.prompt ?? '', ignoreFocusOut: true });
  if (!prompt?.trim()) return;
  const nPick = await vscode.window.showQuickPick(
    [2, 3, 4].map((n) => ({ label: String(n), description: vscode.l10n.t('{0} runs in parallel', n), n })),
    { title: vscode.l10n.t('Best of N: how many runs?') },
  );
  if (!nPick) return;
  const n = clampN(nPick.n);
  const current = from.model;
  const currentLabel = current ? (from.models?.find((m) => m.value === current)?.displayName ?? current) : vscode.l10n.t('default model');
  let models: RunModel[] = Array.from({ length: n }, () => current);
  if (from.models?.length) {
    const how = await vscode.window.showQuickPick(
      [
        { label: vscode.l10n.t('Same model for all: {0}', currentLabel), mix: false },
        { label: vscode.l10n.t('Pick a model per run…'), mix: true },
      ],
      { title: vscode.l10n.t('Best of N: models') },
    );
    if (!how) return;
    if (how.mix) {
      models = [];
      for (let i = 1; i <= n; i++) {
        const m = await vscode.window.showQuickPick(
          from.models.map((x) => ({ label: x.displayName, description: x.value === current ? vscode.l10n.t('current') : x.value, value: x.value })),
          { title: vscode.l10n.t('Best of N: model for run {0} of {1}', i, n) },
        );
        if (!m) return;
        models.push(m.value);
      }
    }
  }
  const short = bonShort();
  const runs: Run[] = [];
  const failed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Best of N: creating {0} worktrees…', n) }, async () => {
    for (let i = 1; i <= n; i++) {
      const branch = bonBranch(short, i);
      const r = await addWorktree(root, branch);
      if (!r.ok) return r.error;
      runs.push({ i, model: models[i - 1], branch, dir: r.dir, started: Date.now(), files: [] });
    }
    return undefined;
  });
  if (failed) {
    vscode.window.showErrorMessage(vscode.l10n.t('Could not create the worktree: {0}', failed.slice(0, 300)));
    if (!runs.length) return;
  }
  for (const r of runs) {
    r.started = Date.now();
    r.chat = await deps.startChat(r.dir, runTitle(r.i, r.model), prompt, r.model);
    if (!r.chat) r.error = vscode.l10n.t('The chat did not start.');
  }
  new ComparePanel(ctx, deps, root, prompt, runs);
}

class ComparePanel {
  private panel: vscode.WebviewPanel;
  private timer?: ReturnType<typeof setInterval>;
  private ticks = 0;
  private applied?: number;
  private cleaned = false;

  constructor(
    ctx: vscode.ExtensionContext,
    private deps: BestOfNDeps,
    private root: string,
    private prompt: string,
    private runs: Run[],
  ) {
    const webRoot = vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel('steerhouse.compare', vscode.l10n.t('Best of N · compare'), { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webRoot] });
    this.panel.iconPath = { light: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'steerhouse-light.svg'), dark: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'steerhouse-dark.svg') };
    this.panel.webview.html = html(this.panel.webview, webRoot);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => clearInterval(this.timer));
    this.timer = setInterval(() => void this.tick(), 2000);
  }

  private async tick() {
    // statuses every 2s; diffs every 6s (and once a run finishes)
    const diffsToo = this.ticks++ % 3 === 0;
    for (const r of this.runs) {
      const s = r.chat?.state;
      if (!s) continue;
      const busy = s.status === 'working' || s.status === 'waiting';
      if (busy) r.sawWork = true;
      if (!busy && r.sawWork && !r.finished && (s.status !== 'idle' || s.items.some((x) => x.kind === 'result'))) {
        r.finished = Date.now();
        await this.loadDiff(r);
      }
    }
    if (diffsToo) for (const r of this.runs) if (!r.finished && !this.cleaned) await this.loadDiff(r);
    this.post();
  }

  private async loadDiff(r: Run) {
    if (this.cleaned) return;
    const w = await workingTree(r.dir);
    r.files = w.files;
    if (w.error) r.error = w.error;
  }

  private post() {
    if (!this.panel.visible && this.ticks > 1) return;
    const runs = this.runs.map((r) => {
      const s = r.chat?.state;
      const status = this.cleaned ? 'removed' : (s?.status ?? 'error');
      return {
        i: r.i,
        title: runTitle(r.i, r.model),
        model: r.model,
        branch: r.branch,
        dir: r.dir,
        status,
        elapsedMs: (r.finished ?? Date.now()) - r.started,
        finished: !!r.finished,
        costUsd: s?.costUsd ?? 0,
        files: r.files.map((f) => ({ path: f.path, rel: f.rel, added: f.added, removed: f.removed, hunks: f.hunks.slice(0, 40), untracked: f.untracked, binary: f.binary })),
        added: diffStats(r.files).added,
        removed: diffStats(r.files).removed,
        error: r.error,
      };
    });
    this.panel.webview.postMessage({ type: 'data', data: { view: 'compare', compare: { prompt: this.prompt, root: this.root, runs, applied: this.applied, cleaned: this.cleaned } } });
  }

  private run(i: unknown) {
    return this.runs.find((r) => r.i === i);
  }

  private async onMessage(m: { type: string; i?: number }) {
    if (m.type === 'ready') return void (await this.tick());
    if (m.type === 'openUrl') return;
    const r = this.run(m.i);
    if (m.type === 'compareOpenChat' && r?.chat) return this.deps.reveal(r.chat);
    if (m.type === 'compareOpenFolder' && r) return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.dir), { forceNewWindow: true });
    if (m.type === 'compareJudge') return this.judge();
    if (m.type === 'compareApply' && r) return this.apply(r);
    if (m.type === 'compareCleanup') return this.cleanup();
  }

  private async diffOf(r: Run) {
    // untracked files too: intent-to-add makes them show up in git diff HEAD
    await git(['add', '-N', '.'], r.dir);
    return (await git(['diff', 'HEAD', '--no-color', '--no-ext-diff'], r.dir)).out;
  }

  private async judge() {
    const parts = [];
    for (const r of this.runs) parts.push({ label: `run ${r.i} (${r.model || 'default'}, branch ${r.branch})`, diff: await this.diffOf(r) });
    await this.deps.judge(this.root, vscode.l10n.t('Best of N · judge'), judgePrompt(this.prompt, parts));
  }

  private async apply(r: Run) {
    const ok = vscode.l10n.t('Apply');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Apply the changes of run {0} to {1}?', r.i, path.basename(this.root)),
      { modal: true, detail: vscode.l10n.t('Its diff against HEAD is applied to your working tree with git apply --3way. Conflicts are left for you to resolve.') },
      ok,
    );
    if (pick !== ok) return;
    await git(['add', '-N', '.'], r.dir);
    const diff = await new Promise<{ ok: boolean; out: Buffer }>((resolve) => {
      const p = spawn('git', ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff'], { cwd: r.dir, windowsHide: true });
      const chunks: Buffer[] = [];
      p.stdout.on('data', (d: Buffer) => chunks.push(d));
      p.on('close', (code) => resolve({ ok: code === 0, out: Buffer.concat(chunks) }));
      p.on('error', (e) => resolve({ ok: false, out: Buffer.from(String(e)) }));
    });
    if (!diff.ok) return vscode.window.showErrorMessage(diff.out.toString('utf8').slice(0, 300));
    if (!diff.out.toString('utf8').trim()) return vscode.window.showInformationMessage(vscode.l10n.t('Run {0} changed nothing.', r.i));
    const res = await applyPatch(this.root, diff.out);
    if (!res.ok) return vscode.window.showErrorMessage(vscode.l10n.t('git apply failed: {0}', res.out.slice(0, 400)));
    this.applied = r.i;
    vscode.window.showInformationMessage(res.out ? vscode.l10n.t('Run {0} applied to {1}: {2}', r.i, path.basename(this.root), res.out.slice(0, 200)) : vscode.l10n.t('Run {0} applied to {1}.', r.i, path.basename(this.root)));
    this.post();
  }

  private async cleanup() {
    const ok = vscode.l10n.t('Clean Up');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove the {0} Best of N worktrees and their branches?', this.runs.length),
      { modal: true, detail: vscode.l10n.t('Their uncommitted changes are deleted for good. Apply the one you want first.') },
      ok,
    );
    if (pick !== ok) return;
    const errors: string[] = [];
    for (const r of this.runs) {
      r.chat?.close();
      const w = await removeWorktree(r.dir, true);
      if (!w.ok) errors.push(`${r.branch}: ${w.out}`);
      const b = await git(['branch', '-D', r.branch], this.root);
      if (!b.ok) errors.push(`${r.branch}: ${b.out}`);
    }
    this.cleaned = true;
    if (errors.length) vscode.window.showWarningMessage(errors.join('\n').slice(0, 500));
    else vscode.window.setStatusBarMessage(vscode.l10n.t('$(git-branch) Steerhouse: Best of N worktrees removed'), 5000);
    this.post();
  }
}

function applyPatch(cwd: string, patch: Buffer): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('git', ['apply', '--3way', '--whitespace=nowarn', '-'], { cwd, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }));
    p.on('error', (e) => resolve({ ok: false, out: String(e) }));
    p.stdin.end(patch);
  });
}

function html(webview: vscode.Webview, root: vscode.Uri) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
  return `<!doctype html>
<html lang="${vscode.env.language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script type="module" nonce="${nonce}" src="${js}"></script></body></html>`;
}
