// Skills across agents. Every agent uses the same SKILL.md folder format, but each one
// loads skills from different folders. Paths follow the `npx skills` CLI (vercel-labs/skills),
// which is also what we use to install, enable, update and remove skills.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { which } from './util';

export interface AgentDef {
  id: string; // `npx skills -a <id>`
  label: string;
  project: string[]; // relative to the workspace folder
  global: string[]; // ~ = home
  detect: string[]; // the agent counts as installed if one of these exists
}

export const AGENTS: AgentDef[] = [
  { id: 'claude-code', label: 'Claude Code', project: ['.claude/skills'], global: ['~/.claude/skills'], detect: ['~/.claude'] },
  // Cursor also reads Claude Code and Codex skill folders.
  { id: 'cursor', label: 'Cursor', project: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'], global: ['~/.cursor/skills'], detect: ['~/.cursor'] },
  { id: 'codex', label: 'Codex', project: ['.agents/skills'], global: ['~/.codex/skills', '~/.agents/skills'], detect: ['~/.codex'] },
  { id: 'gemini-cli', label: 'Gemini CLI', project: ['.agents/skills'], global: ['~/.gemini/skills'], detect: ['~/.gemini'] },
  { id: 'github-copilot', label: 'Copilot', project: ['.agents/skills'], global: ['~/.copilot/skills'], detect: ['~/.copilot'] },
  { id: 'windsurf', label: 'Windsurf', project: ['.windsurf/skills'], global: ['~/.codeium/windsurf/skills'], detect: ['~/.codeium/windsurf'] },
  { id: 'opencode', label: 'OpenCode', project: ['.agents/skills'], global: ['~/.config/opencode/skills'], detect: ['~/.config/opencode'] },
];

const home = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const exists = (p: string) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

export const installedAgents = () => AGENTS.filter((a) => a.detect.some((d) => exists(home(d))));

export interface Skill {
  name: string;
  description: string;
  scope: 'project' | 'user';
  root: string; // workspace folder for project skills, home for user skills
  locations: string[]; // every folder holding this skill (symlinks resolved)
  agents: AgentDef[]; // agents that load it
  file: string; // SKILL.md to open
}

function readSkill(dir: string): { name: string; description: string } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const get = (k: string) => new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm').exec(fm)?.[1].trim().replace(/^["']|["']$/g, '');
  return { name: get('name') || path.basename(dir), description: get('description') ?? '' };
}

export function scanSkills(): Skill[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const byKey = new Map<string, Skill>();
  const visit = (base: string, scope: Skill['scope'], root: string, agent: AgentDef) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const dir = path.join(base, e.name);
      const meta = readSkill(dir);
      if (!meta) continue;
      const key = `${scope}:${root}:${meta.name}`;
      const s = byKey.get(key) ?? { ...meta, scope, root, locations: [], agents: [], file: path.join(dir, 'SKILL.md') };
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch {
        /* broken link */
      }
      if (!s.locations.includes(real)) s.locations.push(real);
      if (!s.agents.includes(agent)) s.agents.push(agent);
      byKey.set(key, s);
    }
  };
  for (const agent of AGENTS) {
    for (const f of folders) for (const p of agent.project) visit(path.join(f, p), 'project', f, agent);
    for (const g of agent.global) visit(home(g), 'user', os.homedir(), agent);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type Node = { kind: 'scope'; scope: Skill['scope']; skills: Skill[] } | { kind: 'skill'; skill: Skill } | { kind: 'empty' };

export class SkillsTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh() {
    this.emitter.fire();
  }
  getChildren(n?: Node): Node[] {
    if (!n) {
      const all = scanSkills();
      if (!all.length) return [{ kind: 'empty' }];
      return (['project', 'user'] as const)
        .map((scope) => ({ kind: 'scope' as const, scope, skills: all.filter((s) => s.scope === scope) }))
        .filter((g) => g.skills.length);
    }
    return n.kind === 'scope' ? n.skills.map((skill) => ({ kind: 'skill', skill })) : [];
  }
  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === 'empty') {
      const it = new vscode.TreeItem('No skills yet. Add one from skills.sh');
      it.iconPath = new vscode.ThemeIcon('cloud-download');
      it.command = { command: 'agentlens.skillAdd', title: 'Add skill' };
      return it;
    }
    if (n.kind === 'scope') {
      const it = new vscode.TreeItem(n.scope === 'project' ? 'This project' : 'Personal (all projects)', vscode.TreeItemCollapsibleState.Expanded);
      it.iconPath = new vscode.ThemeIcon(n.scope === 'project' ? 'repo' : 'account');
      it.description = String(n.skills.length);
      return it;
    }
    const s = n.skill;
    const missing = installedAgents().filter((a) => !s.agents.includes(a));
    const it = new vscode.TreeItem(s.name);
    it.iconPath = new vscode.ThemeIcon(missing.length ? 'book' : 'pass-filled', missing.length ? undefined : new vscode.ThemeColor('charts.green'));
    it.description = s.agents.map((a) => a.label).join(' · ');
    const md = new vscode.MarkdownString(`**${s.name}**\n\n${s.description}\n\n`);
    md.appendMarkdown(`**Loaded by:** ${s.agents.map((a) => a.label).join(', ')}\n\n`);
    if (missing.length) md.appendMarkdown(`**Not visible to:** ${missing.map((a) => a.label).join(', ')} (use *Enable for more agents*)\n\n`);
    md.appendMarkdown(s.locations.map((l) => `\`${l}\``).join('  \n'));
    it.tooltip = md;
    it.contextValue = 'skill';
    it.command = { command: 'agentlens.openFile', title: 'Open', arguments: [s.file] };
    return it;
  }
}

/**
 * Run `npx skills …` as the terminal's own process (not typed into the user's default shell,
 * which may be Git Bash / PowerShell / fish and may get other text typed into it).
 */
function skillsCli(title: string, args: string[], cwd?: string) {
  const npx = which('npx');
  if (!npx) {
    vscode.window.showErrorMessage('AgentLens: npx was not found. Install Node.js to add skills.');
    return;
  }
  const all = ['-y', 'skills', ...args];
  const isScript = /\.(cmd|bat)$/i.test(npx);
  const t = vscode.window.createTerminal({
    name: title,
    cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    iconPath: new vscode.ThemeIcon('book'),
    shellPath: isScript ? 'cmd.exe' : npx,
    shellArgs: isScript ? ['/c', npx, ...all] : all,
  });
  t.show();
}

async function pickAgents(preselect: (a: AgentDef) => boolean, exclude: AgentDef[] = []): Promise<AgentDef[] | undefined> {
  const installed = installedAgents();
  const items = AGENTS.filter((a) => !exclude.includes(a)).map((a) => ({
    label: a.label,
    description: installed.includes(a) ? 'installed' : '',
    picked: preselect(a),
    agent: a,
  }));
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Which agents should load it?' });
  return picked?.map((p) => p.agent);
}

async function pickScope(): Promise<'project' | 'user' | undefined> {
  if (!vscode.workspace.workspaceFolders?.length) return 'user';
  const p = await vscode.window.showQuickPick(
    [
      { label: 'This project', description: 'committed with the repo, shared with the team', scope: 'project' as const },
      { label: 'Personal', description: 'only you, every project (-g)', scope: 'user' as const },
    ],
    { placeHolder: 'Install where?' },
  );
  return p?.scope;
}

const agentFlags = (agents: AgentDef[]) => agents.flatMap((a) => ['-a', a.id]);

export function registerSkills(ctx: vscode.ExtensionContext) {
  const tree = new SkillsTree();
  const later = () => setTimeout(() => tree.refresh(), 4000);
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentlens.skills', tree),
    vscode.commands.registerCommand('agentlens.skillsRefresh', () => tree.refresh()),
    vscode.commands.registerCommand('agentlens.skillAdd', async () => {
      const source = await vscode.window.showInputBox({
        prompt: 'Skill source: GitHub owner/repo, git URL, URL to a SKILL.md, or a local folder',
        placeHolder: 'vercel-labs/agent-skills',
      });
      if (!source) return;
      const agents = await pickAgents((a) => installedAgents().includes(a));
      if (!agents?.length) return;
      const scope = await pickScope();
      if (!scope) return;
      skillsCli('skills: add', ['add', source, ...agentFlags(agents), ...(scope === 'user' ? ['-g'] : [])]);
      later();
    }),
    vscode.commands.registerCommand('agentlens.skillFind', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Search skills (skills.sh)', placeHolder: 'react, testing, postgres…' });
      if (query === undefined) return;
      skillsCli('skills: find', ['find', ...(query ? [query] : [])]);
    }),
    vscode.commands.registerCommand('agentlens.skillUpdate', () => {
      skillsCli('skills: update', ['update']);
      later();
    }),
    vscode.commands.registerCommand('agentlens.skillEnable', async (n?: { skill?: Skill }) => {
      const s = n?.skill;
      if (!s) return;
      const agents = await pickAgents((a) => installedAgents().includes(a), s.agents);
      if (!agents?.length) return;
      skillsCli('skills: enable', ['add', s.locations[0], ...agentFlags(agents), ...(s.scope === 'user' ? ['-g'] : []), '-y'], s.scope === 'project' ? s.root : undefined);
      later();
    }),
    vscode.commands.registerCommand('agentlens.skillRemove', async (n?: { skill?: Skill }) => {
      const s = n?.skill;
      if (!s) return;
      const ok = await vscode.window.showWarningMessage(
        `Remove skill "${s.name}" from ${s.agents.map((a) => a.label).join(', ')}?`,
        { modal: true },
        'Remove',
      );
      if (ok !== 'Remove') return;
      skillsCli('skills: remove', ['remove', s.name, ...agentFlags(s.agents), ...(s.scope === 'user' ? ['-g'] : []), '-y'], s.scope === 'project' ? s.root : undefined);
      later();
    }),
    vscode.commands.registerCommand('agentlens.newSkill', async () => {
      const name = (await vscode.window.showInputBox({ prompt: 'Skill name (kebab-case)', placeHolder: 'api-conventions' }))?.trim();
      if (!name) return;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const scope = await pickScope();
      if (!scope) return;
      const where = await vscode.window.showQuickPick(
        [
          { label: '.claude/skills', description: 'Claude Code (Cursor reads it too)', dir: scope === 'project' ? '.claude/skills' : '~/.claude/skills' },
          { label: '.agents/skills', description: 'Cursor, Codex, Gemini CLI, Copilot, OpenCode', dir: scope === 'project' ? '.agents/skills' : '~/.agents/skills' },
        ],
        { placeHolder: 'Where should it live? (enable it for more agents later from the Skills view)' },
      );
      if (!where) return;
      const base = scope === 'project' ? path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, where.dir) : home(where.dir);
      const file = path.join(base, slug, 'SKILL.md');
      if (!exists(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(
          file,
          `---\nname: ${slug}\ndescription: When the agent should use this skill. Be specific: this line is what triggers it.\n---\n\n# ${name}\n\nInstructions the agent follows when this skill is used.\n\nScripts next to this file can be run from here, e.g. \`npx tsx scripts/check.ts\`.\n`,
        );
      }
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      tree.refresh();
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.claude,.agents,.cursor,.codex,.windsurf}/skills/**/SKILL.md');
  watcher.onDidCreate(() => tree.refresh());
  watcher.onDidDelete(() => tree.refresh());
  watcher.onDidChange(() => tree.refresh());
  ctx.subscriptions.push(watcher);
}
