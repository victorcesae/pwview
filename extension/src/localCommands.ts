// Claude Code's interactive commands (/config, /permissions, /model, /mcp…) only exist in its terminal
// app: through the SDK, "/permissions" would just be sent to the model as text. In a Steerhouse chat
// they open the same settings here instead; /terminal opens the session in Claude Code for the rest.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatSession } from './chat';
import { claudeDir } from './paths';

/** The commands the chat handles itself (the webview lists the same names). */
export const LOCAL_COMMANDS = ['config', 'permissions', 'model', 'mcp', 'hooks', 'memory', 'agents', 'login', 'doctor', 'clear', 'terminal', 'steerhouse'] as const;
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
    case 'steerhouse':
      return steerhouseSettings();
    case 'terminal':
      if (!c.state.sessionId) return vscode.window.showInformationMessage(vscode.l10n.t('Send a first message, then the session can open in the terminal.'));
      return vscode.commands.executeCommand('steerhouse.resumeInTerminal', c.state.sessionId);
  }
}

/** Steerhouse's own settings, from the chat: each with its value now, changed right there. */
export async function steerhouseSettings() {
  const cfg = () => vscode.workspace.getConfiguration('steerhouse');
  type Opt = { label: string; value: unknown; description?: string };
  const items: { key: string; label: string; options?: Opt[]; text?: boolean }[] = [
    { key: 'terminalLocation', label: vscode.l10n.t('Terminal position'), options: [{ label: vscode.l10n.t('Right, beside the chat'), value: 'right' }, { label: vscode.l10n.t('Left, beside the chat'), value: 'left' }, { label: vscode.l10n.t('Bottom panel'), value: 'bottom' }] },
    {
      key: 'shell',
      label: vscode.l10n.t('Shell for ! commands'),
      options: [
        { label: vscode.l10n.t('Automatic (your default VS Code terminal)'), value: 'auto' },
        ...(process.platform === 'win32'
          ? [{ label: 'PowerShell', value: 'powershell' }, { label: 'PowerShell 7 (pwsh)', value: 'pwsh' }, { label: 'Command Prompt (cmd)', value: 'cmd' }, { label: 'Git Bash', value: 'git bash' }]
          : [{ label: 'bash', value: 'bash' }, { label: 'zsh', value: 'zsh' }, { label: 'fish', value: 'fish' }]),
        { label: vscode.l10n.t('Other (type a name or path)…'), value: '__custom' },
      ],
    },
    { key: 'sidebarGrouping', label: vscode.l10n.t('Sidebar'), options: [{ label: vscode.l10n.t('By chat (Pinned, Active, Recent)'), value: 'chats' }, { label: vscode.l10n.t('By project folder'), value: 'projects' }] },
    { key: 'notifications', label: vscode.l10n.t('Notify when a chat finishes or needs you'), options: [{ label: vscode.l10n.t('On'), value: true }, { label: vscode.l10n.t('Off'), value: false }] },
    { key: 'codeCompletion.enabled', label: vscode.l10n.t('Tab completion in the editor'), options: [{ label: vscode.l10n.t('On'), value: true }, { label: vscode.l10n.t('Off'), value: false }] },
    { key: 'verify.command', label: vscode.l10n.t('Verify command after each turn'), text: true },
    { key: 'defaultSurface', label: vscode.l10n.t('Where chats open'), options: [{ label: vscode.l10n.t('Steerhouse chat'), value: 'chat' }, { label: vscode.l10n.t('Terminal'), value: 'terminal' }] },
  ];
  const show = (v: unknown) => (v === true ? vscode.l10n.t('On') : v === false ? vscode.l10n.t('Off') : v === '' || v === undefined ? vscode.l10n.t('not set') : String(v));
  const pick = await vscode.window.showQuickPick(
    [
      ...items.map((i) => ({ label: i.label, description: show(cfg().get(i.key)), i })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: vscode.l10n.t('$(settings-gear) All Steerhouse settings…'), i: undefined },
    ] as (vscode.QuickPickItem & { i?: (typeof items)[number] })[],
    { title: vscode.l10n.t('Steerhouse settings'), placeHolder: vscode.l10n.t('Pick one to change it') },
  );
  if (!pick) return;
  if (!pick.i) return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:victorcesae.steerhouse');
  const it = pick.i;
  let value: unknown;
  if (it.text) {
    value = await vscode.window.showInputBox({ title: it.label, value: String(cfg().get(it.key) ?? ''), prompt: vscode.l10n.t('Empty to turn it off') });
    if (value === undefined) return;
  } else {
    const now = cfg().get(it.key);
    const o = await vscode.window.showQuickPick(
      it.options!.map((x) => ({ label: x.label, description: x.value === now ? vscode.l10n.t('current') : undefined, x })),
      { title: it.label },
    );
    if (!o) return;
    value = o.x.value;
    if (value === '__custom') {
      value = await vscode.window.showInputBox({ title: it.label, prompt: vscode.l10n.t('A shell name or the full path to its executable') });
      if (!value) return;
    }
  }
  await cfg().update(it.key, value, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0}: {1}', it.label, show(value)), 4000);
}
