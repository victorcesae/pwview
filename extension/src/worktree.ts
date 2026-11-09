// A chat in its own git worktree: a separate folder on a new branch, so agents working in parallel
// never edit the same checkout. Worktrees live next to the repo in "<repo>.worktrees/<branch>".
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile('git', args, { cwd, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })),
  );
}

/** "Fix the login bug!" → "fix-the-login-bug" (valid in a branch name and a folder name). */
export function slug(text: string, max = 40): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'chat'
  );
}

/** Branch names git accepts (a practical subset of git check-ref-format). */
export const validBranch = (b: string) => /^[A-Za-z0-9._/-]+$/.test(b) && !/(^[./-]|[./]$|\.\.|\/\/|\.lock$|@\{)/.test(b);

/** Where the worktree for a branch goes: next to the repo, in "<repo>.worktrees/". */
export function worktreePath(repoRoot: string, branch: string): string {
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`, branch.replace(/[\\/]/g, '-'));
}

/** The repo's top folder, or undefined when the folder is not in a git repo. */
export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? path.resolve(r.out.split('\n')[0]) : undefined;
}

/** True when the folder is a linked worktree (its .git is a file pointing at the main repo). */
export function isWorktree(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

/** For a linked worktree: the main repo folder and the branch checked out. */
export function worktreeInfo(dir: string): { main: string; branch?: string } | undefined {
  try {
    const gitFile = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    const gitdir = /gitdir:\s*(.+)/.exec(gitFile)?.[1]?.trim();
    if (!gitdir) return undefined;
    const abs = path.resolve(dir, gitdir); // <main>/.git/worktrees/<name>
    const main = path.dirname(path.dirname(path.dirname(abs)));
    const head = fs.readFileSync(path.join(abs, 'HEAD'), 'utf8').trim();
    return { main, branch: /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] };
  } catch {
    return undefined;
  }
}

/** Creates the worktree on a new branch from the current commit. */
export async function addWorktree(root: string, branch: string): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const dir = worktreePath(root, branch);
  if (fs.existsSync(dir)) return { ok: false, error: `${dir} already exists` };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await git(['worktree', 'add', '-b', branch, dir], root);
  return r.ok ? { ok: true, dir } : { ok: false, error: r.out };
}

/** Removes a worktree folder (git refuses when it has uncommitted changes unless forced). The branch stays. */
export async function removeWorktree(dir: string, force = false): Promise<{ ok: boolean; out: string }> {
  const info = worktreeInfo(dir);
  if (!info) return { ok: false, out: 'not a git worktree' };
  return git(['worktree', 'remove', ...(force ? ['--force'] : []), dir], info.main);
}
