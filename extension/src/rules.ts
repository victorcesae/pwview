// Rules the agents follow. Your rules apply to every project (Claude Code: ~/.claude/CLAUDE.md).
// Project rules live in the repo: CLAUDE.md (shared, committed), CLAUDE.local.md (only you),
// AGENTS.md (read by Codex, Cursor and others), .cursor/rules/*.mdc (Cursor).
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { claudeDir } from './paths';

export interface RuleFile {
  path: string;
  label: string;
  /** what reads this file and who sees it */
  hint: string;
  exists: boolean;
}

export function userRules(configDir = claudeDir()): RuleFile[] {
  const p = path.join(configDir, 'CLAUDE.md');
  return [{ path: p, label: 'CLAUDE.md', hint: 'Your rules · every project · Claude Code', exists: fs.existsSync(p) }];
}

export function projectRules(root: string): RuleFile[] {
  const f = (rel: string, hint: string): RuleFile => ({ path: path.join(root, rel), label: rel.replace(/\\/g, '/'), hint, exists: fs.existsSync(path.join(root, rel)) });
  const out = [
    f('CLAUDE.md', 'Project rules · shared with the team (commit it)'),
    f('CLAUDE.local.md', 'Your rules for this project · not committed'),
  ];
  for (const extra of [path.join('.claude', 'CLAUDE.md'), 'AGENTS.md']) {
    const r = f(extra, extra === 'AGENTS.md' ? 'Read by Codex, Cursor and other agents' : 'Project rules (alternate location)');
    if (r.exists) out.push(r);
  }
  const cursorDir = path.join(root, '.cursor', 'rules');
  try {
    for (const name of fs.readdirSync(cursorDir).filter((n) => /\.mdc?$/i.test(n)).sort())
      out.push(f(path.join('.cursor', 'rules', name), 'Cursor rule'));
  } catch {}
  return out;
}

const TEMPLATE: Record<string, string> = {
  user: '# My rules\n\nThese apply to every project.\n\n- \n',
  'CLAUDE.md': '# Project rules\n\nRead by every agent session in this project. Commit this file so the team shares it.\n\n## Commands\n\n- Build: \n- Test: \n\n## Conventions\n\n- \n',
  'CLAUDE.local.md': '# My rules for this project\n\nOnly for you (kept out of git).\n\n- \n',
};

/** Opens a rules file, creating it from a short template the first time. */
export async function openRules(file: string, scope: 'user' | 'project') {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, scope === 'user' ? TEMPLATE.user : (TEMPLATE[path.basename(file)] ?? ''));
    if (path.basename(file) === 'CLAUDE.local.md') ignoreLocal(path.dirname(file));
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

/** CLAUDE.local.md is personal: add it to .gitignore when the folder is a git repo. */
export function ignoreLocal(root: string) {
  if (!fs.existsSync(path.join(root, '.git'))) return;
  const gi = path.join(root, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (/^\/?CLAUDE\.local\.md\s*$/m.test(cur)) return;
  fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + 'CLAUDE.local.md\n');
}

/** Command: pick which rules to edit (yours, or one of the open project's). */
export async function editRules(scope: 'user' | 'project', root?: string) {
  if (scope === 'user') return openRules(userRules()[0].path, 'user');
  const folder = root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return vscode.window.showInformationMessage(vscode.l10n.t('Open a folder to edit its project rules.'));
  const pick = await vscode.window.showQuickPick(
    projectRules(folder).map((r) => ({ label: r.label, description: r.exists ? '' : vscode.l10n.t('create'), detail: vscode.l10n.t(r.hint), r })),
    { title: vscode.l10n.t('Project rules · {0}', path.basename(folder)) },
  );
  if (pick) await openRules(pick.r.path, 'project');
}
