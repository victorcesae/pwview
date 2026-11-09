import * as path from 'path';
import * as vscode from 'vscode';
import { AgentInfo, Change, Engine, HotFile, Session, State } from './engine';
import { norm } from './paths';
import { listAccounts } from './accounts';
import { modelLabel } from './pricing';
import { ago, clip, rel } from './util';

export type Node =
  | { kind: 'hint'; text: string; command: string; icon: string }
  | { kind: 'hot'; files: HotFile[] }
  | { kind: 'hotfile'; hot: HotFile }
  | { kind: 'project'; path: string; sessions: Session[]; current: boolean }
  | { kind: 'session'; s: Session; via?: string }
  | { kind: 'agent'; s: Session; a: AgentInfo; via?: string }
  | { kind: 'changes'; s: Session; agentId?: string; list: Change[]; via?: string }
  | { kind: 'change'; s: Session; c: Change; via?: string };

const stateIcon = (st: State) =>
  st === 'working'
    ? new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'))
    : st === 'recent'
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));

export class SessionsTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private sessions: () => Session[],
    private hooks: () => 'all' | 'some' | 'none',
    private attached: () => Set<string>,
  ) {}

  refresh() {
    this.emitter.fire(undefined);
  }

  private workspaceRoots() {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => norm(f.uri.fsPath));
  }

  getChildren(node?: Node): Node[] {
    const sessions = this.sessions();
    if (!node) {
      const out: Node[] = [];
      const h = this.hooks();
      if (h !== 'all')
        out.push({ kind: 'hint', text: h === 'some' ? 'Update hooks to enable steering & send now' : 'Enable messages to agents (steer, queue, send now)', command: 'agentlens.installHooks', icon: 'warning' });
      const hot = Engine.hotFiles(sessions);
      if (hot.length) out.push({ kind: 'hot', files: hot });
      const roots = this.workspaceRoots();
      const byProject = new Map<string, Session[]>();
      for (const s of sessions) (byProject.get(s.info.project) ?? byProject.set(s.info.project, []).get(s.info.project)!).push(s);
      const projects = [...byProject.entries()].map(([p, list]) => ({
        kind: 'project' as const,
        path: p,
        sessions: list,
        current: roots.some((r) => norm(p) === r || norm(p).startsWith(r + '/')),
      }));
      projects.sort((a, b) => Number(b.current) - Number(a.current) || (b.sessions[0].info.updated ?? '').localeCompare(a.sessions[0].info.updated ?? ''));
      if (!sessions.length)
        out.push({ kind: 'hint', text: 'No agent sessions yet. Start one', command: 'agentlens.newSession', icon: 'add' });
      return [...out, ...projects];
    }
    switch (node.kind) {
      case 'hot':
        return node.files.map((hot) => ({ kind: 'hotfile', hot }));
      case 'hotfile':
        return sessions.filter((s) => node.hot.sessions.includes(s.info.id)).map((s) => ({ kind: 'session', s, via: `hot:${node.hot.file}` }));
      case 'project':
        return node.sessions.map((s) => ({ kind: 'session', s }));
      case 'session': {
        const out: Node[] = node.s.agents.map((a) => ({ kind: 'agent', s: node.s, a: a.info, via: node.via }));
        const own = node.s.t.changes;
        if (own.length) out.push({ kind: 'changes', s: node.s, list: own, via: node.via });
        return out;
      }
      case 'agent': {
        const a = node.s.agents.find((x) => x.info.id === node.a.id);
        return (a?.t.changes ?? []).slice().reverse().map((c) => ({ kind: 'change', s: node.s, c, via: node.via }));
      }
      case 'changes':
        return node.list.slice().reverse().map((c) => ({ kind: 'change', s: node.s, c, via: node.via }));
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case 'hint': {
        const it = new vscode.TreeItem(node.text, C.None);
        it.iconPath = new vscode.ThemeIcon(node.icon);
        it.command = { command: node.command, title: node.text };
        return it;
      }
      case 'hot': {
        const it = new vscode.TreeItem('Files touched by several sessions', C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.orange'));
        it.description = String(node.files.length);
        it.tooltip = 'The same file was changed by more than one session: check that the changes fit together.';
        return it;
      }
      case 'hotfile': {
        const it = new vscode.TreeItem(path.basename(node.hot.file), C.Collapsed);
        it.resourceUri = vscode.Uri.file(node.hot.file);
        it.description = `${node.hot.sessions.length} sessions · ${node.hot.changes} edits · ${ago(node.hot.updated)}`;
        it.tooltip = node.hot.file;
        return it;
      }
      case 'project': {
        const it = new vscode.TreeItem(path.basename(node.path) || node.path, node.current ? C.Expanded : C.Collapsed);
        it.iconPath = new vscode.ThemeIcon(node.current ? 'root-folder-opened' : 'folder');
        const working = node.sessions.filter((s) => s.info.state === 'working').length;
        it.description = `${node.sessions.length} sessions${working ? ` · ${working} working` : ''}${node.current ? ' · this workspace' : ''}`;
        it.tooltip = node.path;
        return it;
      }
      case 'session': {
        const i = node.s.info;
        const it = new vscode.TreeItem(clip(i.title, 70), i.agents.length || i.edits ? C.Collapsed : C.None);
        it.id = `${node.via ?? ''}|s:${i.id}`;
        it.iconPath = stateIcon(i.state);
        const bits = [listAccounts().length > 1 ? `👤 ${listAccounts().find((a) => a.id === i.account)?.name ?? i.account}` : '', this.attached().has(i.id) ? '⌨ terminal' : '', i.model ? modelLabel(i.model) : '', i.branch, `${i.edits} edits`, i.agents.length ? `${i.agents.length} agents` : '', i.pendingComments ? `${i.pendingComments} comments queued` : '', ago(i.updated)];
        it.description = bits.filter(Boolean).join(' · ');
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${i.title}**\n\n`);
        md.appendMarkdown(`$(folder) \`${i.project}\`  \n`);
        if (i.branch) md.appendMarkdown(`$(git-branch) ${i.branch}  \n`);
        if (i.model) md.appendMarkdown(`$(sparkle) ${i.model}  \n`);
        md.appendMarkdown(`$(pulse) ${i.state} · updated ${ago(i.updated)}\n\n`);
        if (i.lastPrompt) md.appendMarkdown(`---\n**Last prompt:** ${clip(i.lastPrompt, 400)}\n\n`);
        if (i.linked.length) md.appendMarkdown(`$(link) Shares files with ${i.linked.length} other session(s)\n`);
        it.tooltip = md;
        it.contextValue = 'session';
        if (this.attached().has(i.id)) md.appendMarkdown(`
$(terminal) Runs in a VS Code terminal: **Send now** can interrupt it.`);
        it.command = { command: 'agentlens.openSession', title: 'Open', arguments: [i.id] };
        return it;
      }
      case 'agent': {
        const a = node.a;
        const it = new vscode.TreeItem(clip(a.description, 70), a.edits ? C.Collapsed : C.None);
        it.id = `${node.via ?? ''}|a:${node.s.info.id}:${a.id}`;
        it.iconPath = a.state === 'working' ? stateIcon('working') : new vscode.ThemeIcon('hubot');
        it.description = [a.agentType, `${a.edits} edits`, `${a.tools} tools`, ago(a.updated)].filter(Boolean).join(' · ');
        it.tooltip = `Sub-agent ${a.id}\n${a.description}`;
        it.command = { command: 'agentlens.openSession', title: 'Open', arguments: [node.s.info.id, a.id] };
        return it;
      }
      case 'changes': {
        const it = new vscode.TreeItem('Changes', C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('diff');
        it.description = String(node.list.length);
        return it;
      }
      case 'change': {
        const c = node.c;
        const it = new vscode.TreeItem(path.basename(c.file), C.None);
        it.id = `${node.via ?? ''}|c:${node.s.info.id}:${c.agentId ?? ''}:${c.id}`;
        it.resourceUri = vscode.Uri.file(c.file);
        it.description = `+${c.added} −${c.removed} · ${rel(path.dirname(c.file), node.s.info.project)} · ${ago(c.timestamp)}`;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${c.kind}** \`${c.file}\`\n\n`);
        if (c.why) md.appendMarkdown(`---\n${clip(c.why, 600)}`);
        it.tooltip = md;
        it.command = { command: 'agentlens.openChange', title: 'Open diff', arguments: [node.s.info.id, c.id] };
        return it;
      }
    }
  }
}
