// Changes panel of a chat (host side): the whole working tree as a diff, open a file's native diff,
// revert a file, and Commit / Push / Create PR in the chat's folder.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ghExe } from './prs';
import { removePath } from './fileActions';
import { ALLOW_MARK, describeFindings, scanDiff, scanFileNames } from './secretScan';

export type ChangesMsg =
  | { type: 'changesTree' }
  | { type: 'changesOpenDiff'; path: string }
  | { type: 'changesRevert'; path: string }
  | { type: 'gitCommit'; message: string }
  | { type: 'gitPush' }
  | { type: 'gitCreatePr' }
  | { type: 'changesHunk'; action: 'revert' | 'stage'; path: string; hunk: Hunk; tree?: boolean }
  | { type: 'changesUndoEdit'; path: string; hunks: Hunk[]; reqId: string }
  | { type: 'changesContext'; path: string; start: number; end: number; reqId: string };

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };
export type TreeFile = { path: string; rel: string; added: number; removed: number; hunks: Hunk[]; untracked?: boolean; binary?: boolean };

const CHANGES = new Set(['changesTree', 'changesOpenDiff', 'changesRevert', 'gitCommit', 'gitPush', 'gitCreatePr', 'changesHunk', 'changesUndoEdit', 'changesContext']);
export const isChangesMsg = (m: { type: string }): m is ChangesMsg => CHANGES.has(m.type);

function run(exe: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(exe, args, { cwd, timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) =>
      resolve({ ok: !e, out: String(stdout), err: `${stderr || (e ? e.message : '')}`.trim() }),
    ),
  );
}
const git = (args: string[], cwd: string) => run('git', args, cwd);

export async function repoRoot(cwd: string): Promise<string | undefined> {
  if (!fs.existsSync(cwd)) return undefined;
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? path.resolve(r.out.trim()) : undefined;
}

/** `git diff` output → one entry per file with its hunks. */
export function parseUnifiedDiff(text: string, root: string): TreeFile[] {
  const files: TreeFile[] = [];
  let f: TreeFile | undefined;
  let h: Hunk | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rel = / b\/(.*)$/.exec(line)?.[1] ?? line;
      f = { path: path.join(root, rel), rel, added: 0, removed: 0, hunks: [] };
      files.push(f);
      h = undefined;
      continue;
    }
    if (!f) continue;
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hm) {
      h = { oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4], lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) {
      if (line.startsWith('Binary files')) f.binary = true;
      continue;
    }
    if (line[0] === '+') f.added++;
    else if (line[0] === '-') f.removed++;
    else if (line[0] !== ' ' && line[0] !== '\\') continue;
    h.lines.push(line);
  }
  return files;
}

/** Everything that differs from HEAD in the repo of `cwd`, untracked files included. */
export async function workingTree(cwd: string): Promise<{ root?: string; files: TreeFile[]; error?: string }> {
  const root = await repoRoot(cwd);
  if (!root) return { files: [], error: vscode.l10n.t('This folder is not a git repository.') };
  const hasHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], root)).ok;
  const d = await git(['diff', hasHead ? 'HEAD' : '--cached', '--no-color', '--no-ext-diff', '-M'], root);
  if (!d.ok) return { root, files: [], error: d.err };
  const files = parseUnifiedDiff(d.out, root);
  const u = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const rel of u.out.split('\0').filter(Boolean).slice(0, 200)) {
    const p = path.join(root, rel);
    const f: TreeFile = { path: p, rel, added: 0, removed: 0, hunks: [], untracked: true };
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > 512 * 1024 || buf.subarray(0, 8000).includes(0)) f.binary = true;
      else {
        const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
        f.added = lines.length;
        f.hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }];
      }
    } catch {
      continue;
    }
    files.push(f);
  }
  return { root, files };
}

const isTracked = async (file: string, root: string) => (await git(['ls-files', '--error-unmatch', '--', file], root)).ok;

async function openDiff(file: string, cwd: string) {
  const uri = vscode.Uri.file(file);
  const root = (await repoRoot(path.dirname(file))) ?? (await repoRoot(cwd));
  const api = vscode.extensions.getExtension<any>('vscode.git')?.exports?.getAPI?.(1);
  if (!root || !api || !(await isTracked(file, root))) return vscode.commands.executeCommand('vscode.open', uri);
  return vscode.commands.executeCommand('vscode.diff', api.toGitUri(uri, 'HEAD'), uri, `${path.basename(file)} (HEAD ↔ ${vscode.l10n.t('working tree')})`);
}

async function revert(file: string, cwd: string): Promise<boolean> {
  const root = (await repoRoot(path.dirname(file))) ?? (await repoRoot(cwd));
  if (!root) {
    vscode.window.showErrorMessage(vscode.l10n.t('Only files in a git repository can be reverted.'));
    return false;
  }
  const tracked = await isTracked(file, root);
  const ok = vscode.l10n.t('Revert');
  const name = path.basename(file);
  const pick = await vscode.window.showWarningMessage(tracked ? vscode.l10n.t('Discard all changes to {0} since the last commit?', name) : vscode.l10n.t('Delete the new file {0}?', name), { modal: true }, ok);
  if (pick !== ok) return false;
  if (!tracked) {
    await removePath(file);
    return true;
  }
  const r = await git(['checkout', 'HEAD', '--', file], root);
  if (!r.ok) vscode.window.showErrorMessage(vscode.l10n.t('Could not revert {0}: {1}', name, r.err));
  return r.ok;
}

/** Old / new side of a hunk, without the +/- / space markers. */
export function hunkSides(h: Hunk): { old: string[]; new: string[] } {
  const o: string[] = [];
  const n: string[] = [];
  for (const l of h.lines) {
    if (l[0] === '\\') continue;
    if (l[0] !== '+') o.push(l.slice(1));
    if (l[0] !== '-') n.push(l.slice(1));
  }
  return { old: o, new: n };
}

/** Reverse-apply hunks to `text` by plain text replacement: each hunk's new side is looked up
 *  (nearest to its recorded line first) and replaced by its old side. undefined when one no longer matches. */
export function reverseApplyText(text: string, hunks: Hunk[]): string | undefined {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // apply bottom-up so earlier hunks keep their line numbers
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const { old, new: neu } = hunkSides(h);
    let at = -1;
    if (!neu.length) at = Math.min(Math.max(h.newStart, 0), lines.length);
    else {
      const matches = (i: number) => neu.every((l, k) => lines[i + k] === l);
      const want = Math.max(h.newStart - 1, 0);
      for (let d = 0; d <= lines.length && at < 0; d++) {
        if (want - d >= 0 && want - d + neu.length <= lines.length && matches(want - d)) at = want - d;
        else if (d && want + d + neu.length <= lines.length && matches(want + d)) at = want + d;
        if (want - d < 0 && want + d + neu.length > lines.length) break;
      }
    }
    if (at < 0) return undefined;
    lines.splice(at, neu.length, ...old);
  }
  return lines.join(eol);
}

/** A one-hunk unified diff of `rel` that `git apply` accepts. */
export function hunkPatch(rel: string, h: Hunk): string {
  const r = rel.replace(/\\/g, '/');
  return `diff --git a/${r} b/${r}\n--- a/${r}\n+++ b/${r}\n@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}\n`;
}

function gitStdin(args: string[], cwd: string, input: string): Promise<{ ok: boolean; err: string }> {
  return new Promise((resolve) => {
    const p = execFile('git', args, { cwd, timeout: 60_000, windowsHide: true }, (e, _o, stderr) => resolve({ ok: !e, err: `${stderr || (e ? e.message : '')}`.trim() }));
    p.stdin?.end(input);
  });
}

function revertText(file: string, hunks: Hunk[]): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    return e?.message ?? String(e);
  }
  const out = reverseApplyText(text, hunks);
  if (out === undefined) return vscode.l10n.t('The file changed since, so the change no longer applies.');
  fs.writeFileSync(file, out);
  return undefined;
}

/** Revert (reverse-apply to the working file) or stage one hunk. Returns an error message, if any. */
async function hunkAction(m: Extract<ChangesMsg, { type: 'changesHunk' }>, cwd: string): Promise<string | undefined> {
  const root = (await repoRoot(path.dirname(m.path))) ?? (await repoRoot(cwd));
  if (m.action === 'stage') {
    if (!root) return vscode.l10n.t('This folder is not a git repository.');
    const r = await gitStdin(['apply', '--cached', '--recount', '-'], root, hunkPatch(path.relative(root, m.path), m.hunk));
    return r.ok ? undefined : r.err;
  }
  if (root && (await isTracked(m.path, root))) {
    const r = await gitStdin(['apply', '-R', '--recount', '-'], root, hunkPatch(path.relative(root, m.path), m.hunk));
    if (r.ok) return undefined;
    if (m.tree) return r.err;
  }
  return revertText(m.path, [m.hunk]);
}

/** Current lines start..end (1-based, inclusive) of a file. */
function contextLines(file: string, start: number, end: number): { lines: string[]; total: number } | { error: string } {
  try {
    const all = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    const s = Math.max(1, start);
    return { lines: all.slice(s - 1, Math.max(s - 1, end)), total: all.length };
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}

const fail = (msg: string) => (vscode.window.showErrorMessage(msg), false);

/** Secret scan of what is about to leave: the staged changes (commit) or the commits not on the
 *  remote yet (push, PR). True to go on: nothing found, or the user chose to go on anyway. */
async function secretsOk(root: string, what: 'commit' | 'push' | 'pr'): Promise<boolean> {
  let diff: string;
  let names: string;
  if (what === 'commit') {
    diff = (await git(['diff', '--cached', '--no-color', '--no-ext-diff', '-U0'], root)).out;
    names = (await git(['diff', '--cached', '--name-only', '--diff-filter=AMR'], root)).out;
  } else if ((await git(['rev-parse', '--verify', '--quiet', '@{u}'], root)).ok) {
    diff = (await git(['diff', '--no-color', '--no-ext-diff', '-U0', '@{u}..HEAD'], root)).out;
    names = (await git(['diff', '--name-only', '--diff-filter=AMR', '@{u}..HEAD'], root)).out;
  } else {
    // no upstream: every commit no remote has
    diff = (await git(['log', '-p', '--no-color', '--no-ext-diff', '-U0', '--format=', 'HEAD', '--not', '--remotes'], root)).out;
    names = (await git(['log', '--name-only', '--diff-filter=AMR', '--format=', 'HEAD', '--not', '--remotes'], root)).out;
  }
  const findings = [...scanFileNames([...new Set(names.split('\n').map((x) => x.trim()).filter(Boolean))]), ...scanDiff(diff)];
  if (!findings.length) return true;
  const go = what === 'commit' ? vscode.l10n.t('Commit anyway') : what === 'push' ? vscode.l10n.t('Push anyway') : vscode.l10n.t('Create PR anyway');
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t('Possible secrets found ({0})', findings.length),
    {
      modal: true,
      detail: `${describeFindings(findings)}\n\n${vscode.l10n.t('Remove them (or add {0} to a line that is a false alarm) before you share these changes.', ALLOW_MARK)}`,
    },
    go,
  );
  return pick === go;
}

async function commit(cwd: string, suggestion: string): Promise<boolean> {
  const root = await repoRoot(cwd);
  if (!root) return fail(vscode.l10n.t('This folder is not a git repository.'));
  const message = await vscode.window.showInputBox({
    title: vscode.l10n.t('Commit all changes'),
    prompt: root,
    value: suggestion,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter a commit message')),
  });
  if (!message?.trim()) return false;
  const add = await git(['add', '-A'], root);
  if (!add.ok) return fail(vscode.l10n.t('git add failed: {0}', add.err));
  if (!(await secretsOk(root, 'commit'))) return false;
  const c = await git(['commit', '-m', message], root);
  if (!c.ok) return fail(vscode.l10n.t('Commit failed: {0}', c.err || c.out));
  vscode.window.showInformationMessage(vscode.l10n.t('Committed: {0}', message.split('\n')[0]));
  return true;
}

async function push(cwd: string): Promise<boolean> {
  const root = await repoRoot(cwd);
  if (!root) return fail(vscode.l10n.t('This folder is not a git repository.'));
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out.trim();
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
  const remote = upstream.ok ? upstream.out.trim() : (await git(['remote'], root)).out.split('\n')[0]?.trim();
  if (!remote) return fail(vscode.l10n.t('This repository has no remote to push to.'));
  const ok = vscode.l10n.t('Push');
  if ((await vscode.window.showWarningMessage(vscode.l10n.t('Push {0} to {1}?', branch, remote), { modal: true }, ok)) !== ok) return false;
  if (!(await secretsOk(root, 'push'))) return false;
  const r = await git(upstream.ok ? ['push'] : ['push', '-u', remote, 'HEAD'], root);
  if (!r.ok) return fail(vscode.l10n.t('Push failed: {0}', r.err));
  vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0}', branch));
  return true;
}

async function createPr(cwd: string): Promise<string | undefined> {
  const exe = ghExe();
  if (!exe) return void fail(vscode.l10n.t('GitHub CLI (gh) not found'));
  const root = (await repoRoot(cwd)) ?? cwd;
  if (!(await secretsOk(root, 'pr'))) return;
  const r = await run(exe, ['pr', 'create', '--fill'], root);
  const url = /https:\/\/\S+\/pull\/\d+/.exec(`${r.out}\n${r.err}`)?.[0];
  if (!url) return void fail(vscode.l10n.t('Could not create the pull request: {0}', r.err || r.out));
  return url;
}

/** Handles a Changes-panel message. `reply` answers the page, `note` adds a line to the chat,
 *  `suggestion` is the commit message to prefill when the page sends none. */
export async function handleChanges(m: ChangesMsg, cwd: string, reply: (msg: unknown) => void, note: (text: string) => void, suggestion: () => string) {
  const tree = async () => reply({ type: 'changesTreeResult', ...(await workingTree(cwd)) });
  switch (m.type) {
    case 'changesTree':
      return tree();
    case 'changesOpenDiff':
      return void (await openDiff(m.path, cwd));
    case 'changesRevert':
      if (await revert(m.path, cwd)) await tree();
      return;
    case 'gitCommit':
      if (await commit(cwd, m.message || suggestion())) await tree();
      return;
    case 'changesHunk': {
      const err = await hunkAction(m, cwd);
      if (err) vscode.window.showErrorMessage(m.action === 'stage' ? vscode.l10n.t('Could not stage the hunk: {0}', err) : vscode.l10n.t('Could not revert the hunk: {0}', err));
      if (m.tree) await tree();
      return;
    }
    case 'changesUndoEdit': {
      const err = revertText(m.path, m.hunks);
      if (err) vscode.window.showErrorMessage(vscode.l10n.t('Could not undo the edit to {0}: {1}', path.basename(m.path), err));
      return reply({ type: 'changesUndoResult', reqId: m.reqId, ok: !err });
    }
    case 'changesContext':
      return reply({ type: 'changesContextResult', reqId: m.reqId, start: Math.max(1, m.start), ...contextLines(m.path, m.start, m.end) });
    case 'gitPush':
      return void (await push(cwd));
    case 'gitCreatePr': {
      const url = await createPr(cwd);
      if (url) note(vscode.l10n.t('Pull request created: {0}', url));
      return;
    }
  }
}
