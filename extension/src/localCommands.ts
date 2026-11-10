// Claude Code's interactive commands (/config, /permissions, /model, /mcp…) only exist in its terminal
// app: through the SDK, "/permissions" would just be sent to the model as text. In a Steerhouse chat
// they open the same settings here instead; /terminal opens the session in Claude Code for the rest.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatSession } from './chat';
import { claudeDir } from './paths';

/** The commands the chat handles itself (the webview lists the same names). */
export const LOCAL_COMMANDS = ['config', 'permissions', 'model', 'mcp', 'hooks', 'memory', 'agents', 'login', 'doctor', 'clear', 'terminal'] as const;
export type LocalCommand = (typeof LOCAL_COMMANDS)[number];

/** Claude Code's settings files for a folder, most personal last, like its own /config. */
export function settingsFiles(cwd: string): { label: string; detail: string; file: string }[] {
  return [
    { label: vscode.l10n.t('Just me, every project'), detail: '~/.claude/settings.json', file: path.join(claudeDir(), 'settings.json') },
    { label: vscode.l10n.t('The team, this project (committed)'), detail: '.claude/settings.json', file: path.join(cwd, '.claude', 'settings.json') },
    { label: vscode.l10n.t('Just me, this project'), detail: '.claude/settings.local.json', file: path.join(cwd, '.claude', 'settings.local.json') },
  ];
}

/** Opens a settings file, created with an empty skeleton when it is missing. */
async function openSettings(file: string, skeleton: object) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(skeleton, null, 2) + '\n');
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function pickSettings(cwd: string, title: string, skeleton: object) {
  const pick = await vscode.window.showQuickPick(
    settingsFiles(cwd).map((s) => ({ ...s, description: fs.existsSync(s.file) ? '' : vscode.l10n.t('create') })),
    { title },
  );
  if (pick) await openSettings(pick.file, skeleton);
}

const MODES: { mode: Parameters<ChatSession['setPermissionMode']>[0]; label: string }[] = [
  { mode: 'default', label: 'Ask before acting' },
  { mode: 'acceptEdits', label: 'Accept edits' },
  { mode: 'plan', label: 'Plan mode' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'bypassPermissions', label: 'Bypass permissions' },
];

export async function runLocalCommand(name: LocalCommand, c: ChatSession) {
  const cwd = c.state.cwd;
  switch (name) {
    case 'config': {
      type P = vscode.QuickPickItem & { file?: string };
      const pick = await vscode.window.showQuickPick<P>(
        [
          ...settingsFiles(cwd).map((s) => ({ label: s.label, detail: s.detail, description: fs.existsSync(s.file) ? '' : vscode.l10n.t('create'), file: s.file })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          { label: vscode.l10n.t('Steerhouse settings') },
        ],
        { title: vscode.l10n.t('Claude Code settings') },
      );
      if (!pick) return;
      if (pick.file) return openSettings(pick.file, {});
      return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:victorcesae.steerhouse');
    }
    case 'permissions': {
      type P = vscode.QuickPickItem & { mode?: (typeof MODES)[number]['mode']; rules?: boolean };
      const pick = await vscode.window.showQuickPick<P>(
        [
          ...MODES.map((m) => ({ label: vscode.l10n.t(m.label), description: c.state.permissionMode === m.mode ? vscode.l10n.t('current') : '', mode: m.mode })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          { label: vscode.l10n.t('Edit allow and deny rules…'), detail: vscode.l10n.t('Which tools and commands run without asking, in a settings file'), rules: true },
        ],
        { title: vscode.l10n.t('Permissions') },
      );
      if (pick?.mode) return c.setPermissionMode(pick.mode);
      if (pick?.rules) return pickSettings(cwd, vscode.l10n.t('Permission rules: which file?'), { permissions: { allow: [], deny: [] } });
      return;
    }
    case 'hooks':
      return pickSettings(cwd, vscode.l10n.t('Hooks: which settings file?'), { hooks: {} });
    case 'model': {
      if (!c.state.models.length) return vscode.window.showInformationMessage(vscode.l10n.t('The models appear once the chat has started.'));
      const pick = await vscode.window.showQuickPick(
        c.state.models.map((m) => ({ label: m.displayName, description: m.value === c.state.model ? vscode.l10n.t('current') : m.value, value: m.value })),
        { title: vscode.l10n.t('Model') },
      );
      return pick && c.setModel(pick.value);
    }
    case 'mcp':
      return vscode.commands.executeCommand('steerhouse.manageConnectors', cwd);
    case 'memory':
      return vscode.commands.executeCommand('steerhouse.editProjectRules', { root: cwd });
    case 'agents': {
      const dirs = [path.join(cwd, '.claude', 'agents'), path.join(claudeDir(), 'agents')];
      type P = vscode.QuickPickItem & { file?: string; dir?: string };
      const items: P[] = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => ({ label: f.replace(/\.md$/, ''), description: d === dirs[0] ? vscode.l10n.t('project') : vscode.l10n.t('just me'), file: path.join(d, f) })) : []));
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: vscode.l10n.t('New agent for this project…'), dir: dirs[0] }, { label: vscode.l10n.t('New agent for all my projects…'), dir: dirs[1] });
      const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Subagents') });
      if (pick?.file) return vscode.window.showTextDocument(vscode.Uri.file(pick.file));
      if (!pick?.dir) return;
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Agent name'), prompt: vscode.l10n.t('Lowercase letters and dashes, like code-reviewer'), validateInput: (v) => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : vscode.l10n.t('Lowercase letters, digits and dashes')) });
      if (!name) return;
      const file = path.join(pick.dir, `${name}.md`);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(pick.dir, { recursive: true });
        fs.writeFileSync(file, `---\nname: ${name}\ndescription: When the main agent should hand work to this one\ntools: Read, Grep, Glob\n---\n\nYou are ...\n`);
      }
      return vscode.window.showTextDocument(vscode.Uri.file(file));
    }
    case 'login':
      return vscode.commands.executeCommand('steerhouse.accounts');
    case 'doctor':
      return vscode.commands.executeCommand('steerhouse.doctor');
    case 'clear':
      return vscode.commands.executeCommand('steerhouse.newChatHere', { path: cwd });
    case 'terminal':
      if (!c.state.sessionId) return vscode.window.showInformationMessage(vscode.l10n.t('Send a first message, then the session can open in the terminal.'));
      return vscode.commands.executeCommand('steerhouse.resumeInTerminal', c.state.sessionId);
  }
}
