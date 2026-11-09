import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentInfo, Change, Engine, HotFile, Session, State } from './engine';
import { norm } from './paths';
import { projectRules, userRules, type RuleFile } from './rules';
import { worktreeInfo } from './worktree';
import { accountIdentity, listAccounts, preferredAccount, type Account } from './accounts';
import { modelLabel } from './pricing';
import { vendorOf } from './providers';
import { ago, clip, rel } from './util';

export type Node =
  | { kind: 'hint'; text: string; command: string; icon: string }
  | { kind: 'hot'; files: HotFile[] }
  | { kind: 'hotfile'; hot: HotFile }
  | { kind: 'project'; path: string; sessions: Session[]; current: boolean; pinned?: boolean; archived?: boolean }
  | { kind: 'archived'; projects: Extract<Node, { kind: 'project' }>[] }
  | { kind: 'session'; s: Session; via?: string }
  | { kind: 'agent'; s: Session; a: AgentInfo; via?: string }
  | { kind: 'changes'; s: Session; agentId?: string; list: Change[]; via?: string }
  | { kind: 'change'; s: Session; c: Change; via?: string }
  /** the project's folders and files, like the Explorer; files agents changed are marked */
  | { kind: 'accounts' }
  | { kind: 'account'; a: Account }
  | { kind: 'rules'; scope: 'user' | 'project'; root?: string }
  | { kind: 'rule'; scope: 'user' | 'project'; r: RuleFile }
  | { kind: 'files'; root: string; s?: Session; sessions: Session[]; via?: string }
  | { kind: 'fs'; path: string; dir: boolean; root: string; s?: Session; sessions: Session[]; via?: string };

// Names hidden by the user's files.exclude (a "**/.git" pattern hides ".git").
function excluded(): Set<string> {
  const ex = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {};
  return new Set(Object.entries(ex).filter(([, on]) => on === true).map(([g]) => g.replace(/^\*\*\//, '')).filter((g) => !/[*?{[]/.test(g)));
}

/** Per changed file: edits and lines, from the given sessions (and their sub-agents). */
export function changedFiles(sessions: Session[]): Map<string, { added: number; removed: number; edits: number }> {
  const out = new Map<string, { added: number; removed: number; edits: number }>();
  for (const s of sessions)
    for (const c of [...s.t.changes, ...s.agents.flatMap((a) => a.t.changes)]) {
      const k = norm(c.file);
      const e = out.get(k) ?? { added: 0, removed: 0, edits: 0 };
      e.added += c.added;
      e.removed += c.removed;
      e.edits++;
      out.set(k, e);
    }
  return out;
}

const MAX_ENTRIES = 2000;

/** One folder's entries: folders first, then files, by name; hidden ones left out. */
export function listDir(dir: string, hide: Set<string>): { path: string; dir: boolean }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !hide.has(e.name))
    .map((e) => ({ path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || path.basename(a.path).localeCompare(path.basename(b.path)))
    .slice(0, MAX_ENTRIES);
}

/** media/vendors/<vendor>.svg, set by the extension at activation. */
let mediaRoot: vscode.Uri | undefined;
export const setMediaRoot = (u: vscode.Uri) => (mediaRoot = u);
const vendorIcon = (model?: string) => (mediaRoot ? vscode.Uri.joinPath(mediaRoot, 'vendors', `${vendorOf(model)}.svg`) : new vscode.ThemeIcon('circle-filled'));

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
    /** projects the user pinned to the top or archived (moved under "Archived") */
    private marks: () => { pinned: string[]; archived: string[] } = () => ({ pinned: [], archived: [] }),
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
        out.push({ kind: 'hint', text: h === 'some' ? 'Update hooks to enable steering & send now' : 'Enable messages to agents (steer, queue, send now)', command: 'steerhouse.installHooks', icon: 'warning' });
      const hot = Engine.hotFiles(sessions);
      if (hot.length) out.push({ kind: 'hot', files: hot });
      out.push({ kind: 'accounts' }, { kind: 'rules', scope: 'user' });
      const roots = this.workspaceRoots();
      const byProject = new Map<string, Session[]>();
      for (const s of sessions) (byProject.get(s.info.project) ?? byProject.set(s.info.project, []).get(s.info.project)!).push(s);
      const { pinned, archived } = this.marks();
      const has = (list: string[], p: string) => list.some((x) => norm(x) === norm(p));
      const all = [...byProject.entries()].map(([p, list]) => ({
        kind: 'project' as const,
        path: p,
        sessions: list,
        current: roots.some((r) => norm(p) === r || norm(p).startsWith(r + '/')),
        pinned: has(pinned, p),
        archived: has(archived, p),
      }));
      // pinned first, then this workspace, then most recently active
      all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.current) - Number(a.current) || (b.sessions[0].info.updated ?? '').localeCompare(a.sessions[0].info.updated ?? ''));
      const projects = all.filter((p) => !p.archived);
      const hidden = all.filter((p) => p.archived);
      if (!sessions.length)
        out.push({ kind: 'hint', text: vscode.l10n.t('No agent sessions yet. Start one'), command: 'steerhouse.newSession', icon: 'add' });
      return [...out, ...projects, ...(hidden.length ? [{ kind: 'archived' as const, projects: hidden }] : [])];
    }
    switch (node.kind) {
      case 'archived':
        return node.projects;
      case 'hot':
        return node.files.map((hot) => ({ kind: 'hotfile', hot }));
      case 'hotfile':
        return sessions.filter((s) => node.hot.sessions.includes(s.info.id)).map((s) => ({ kind: 'session', s, via: `hot:${node.hot.file}` }));
      case 'project': {
        const files: Node[] = fs.existsSync(node.path) ? [{ kind: 'files', root: node.path, sessions: node.sessions }] : [];
        const rules: Node[] = fs.existsSync(node.path) ? [{ kind: 'rules', scope: 'project', root: node.path }] : [];
        return [...rules, ...files, ...node.sessions.map((s): Node => ({ kind: 'session', s }))];
      }
      case 'accounts':
        return [
          ...listAccounts().map((a): Node => ({ kind: 'account', a })),
          { kind: 'hint', text: vscode.l10n.t('Add a Claude account…'), command: 'steerhouse.addAccount', icon: 'add' },
          { kind: 'hint', text: vscode.l10n.t('Add a model provider (Ollama, OpenRouter…)…'), command: 'steerhouse.addProvider', icon: 'server' },
        ];
      case 'rules': {
        const list = node.scope === 'user' ? userRules() : projectRules(node.root!);
        return list.map((r): Node => ({ kind: 'rule', scope: node.scope, r }));
      }
      case 'session': {
        const out: Node[] = node.s.agents.map((a) => ({ kind: 'agent', s: node.s, a: a.info, via: node.via }));
        const own = node.s.t.changes;
        if (own.length) out.push({ kind: 'changes', s: node.s, list: own, via: node.via });
        if (fs.existsSync(node.s.info.project)) out.push({ kind: 'files', root: node.s.info.project, s: node.s, sessions: [node.s], via: node.via });
        return out;
      }
      case 'files':
      case 'fs': {
        const dir = node.kind === 'files' ? node.root : node.path;
        if (node.kind === 'fs' && !node.dir) return [];
        return listDir(dir, excluded()).map((e): Node => ({ kind: 'fs', path: e.path, dir: e.dir, root: node.root, s: node.s, sessions: node.sessions, via: node.via }));
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
      case 'archived': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived'), C.Collapsed);
        it.id = 'archived';
        it.iconPath = new vscode.ThemeIcon('archive');
        it.description = vscode.l10n.t('{0} projects', node.projects.length);
        return it;
      }
      case 'project': {
        const wt = worktreeInfo(node.path);
        const it = new vscode.TreeItem(path.basename(node.path) || node.path, node.current && !node.archived ? C.Expanded : C.Collapsed);
        it.id = `project:${node.path}`;
        it.iconPath = new vscode.ThemeIcon(wt ? 'git-branch' : node.pinned ? 'pinned' : node.current ? 'root-folder-opened' : 'folder');
        const working = node.sessions.filter((s) => s.info.state === 'working').length;
        it.description = [
          wt ? vscode.l10n.t('worktree of {0}', path.basename(wt.main)) + (wt.branch ? ` · ${wt.branch}` : '') : '',
          vscode.l10n.t('{0} sessions', node.sessions.length),
          working ? vscode.l10n.t('{0} working', working) : '',
          node.current ? vscode.l10n.t('this workspace') : '',
        ]
          .filter(Boolean)
          .join(' · ');
        it.tooltip = node.path;
        // e.g. "project pinned worktree": menus match the words they need
        it.contextValue = ['project', node.pinned ? 'pinned' : 'unpinned', node.archived ? 'archived' : 'active', wt ? 'worktree' : ''].filter(Boolean).join(' ');
        return it;
      }
      case 'session': {
        const i = node.s.info;
        const it = new vscode.TreeItem(clip(i.title, 70), C.Collapsed);
        it.id = `${node.via ?? ''}|s:${i.id}`;
        // the agent's own mark (Claude, GPT, Llama…); a spinner while it works
        it.iconPath = i.state === 'working' ? stateIcon('working') : vendorIcon(i.model);
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
        it.command = { command: 'steerhouse.openSession', title: 'Open', arguments: [i.id] };
        return it;
      }
      case 'agent': {
        const a = node.a;
        const it = new vscode.TreeItem(clip(a.description, 70), a.edits ? C.Collapsed : C.None);
        it.id = `${node.via ?? ''}|a:${node.s.info.id}:${a.id}`;
        it.iconPath = a.state === 'working' ? stateIcon('working') : new vscode.ThemeIcon('hubot');
        it.description = [a.agentType, `${a.edits} edits`, `${a.tools} tools`, ago(a.updated)].filter(Boolean).join(' · ');
        it.tooltip = `Sub-agent ${a.id}\n${a.description}`;
        it.command = { command: 'steerhouse.openSession', title: 'Open', arguments: [node.s.info.id, a.id] };
        return it;
      }
      case 'changes': {
        const it = new vscode.TreeItem('Changes', C.Collapsed);
        it.iconPath = new vscode.ThemeIcon('diff');
        it.description = String(node.list.length);
        return it;
      }
      case 'accounts': {
        const it = new vscode.TreeItem(vscode.l10n.t('Accounts'), C.Collapsed);
        it.id = 'accounts';
        it.iconPath = new vscode.ThemeIcon('accounts-view-bar-icon');
        it.description = String(listAccounts().length);
        it.tooltip = vscode.l10n.t('Claude accounts and model providers Steerhouse can run chats with');
        return it;
      }
      case 'account': {
        const a = node.a;
        const who = accountIdentity(a);
        const it = new vscode.TreeItem(a.name, C.None);
        it.id = 'account:' + a.id;
        it.iconPath = mediaRoot ? vscode.Uri.joinPath(mediaRoot, 'vendors', `${a.provider ? vendorOf(a.provider.model) : 'anthropic'}.svg`) : new vscode.ThemeIcon('account');
        const isDefault = preferredAccount().id === a.id;
        it.description = [
          a.provider ? `${a.provider.model ?? ''} · ${a.provider.baseUrl.replace(/^https?:\/\//, '')}` : (who?.email ?? vscode.l10n.t('not signed in')),
          who?.organization && !a.provider ? who.organization : '',
          isDefault ? vscode.l10n.t('default') : '',
        ]
          .filter(Boolean)
          .join(' · ');
        it.tooltip = [a.name, a.provider ? a.provider.baseUrl : a.configDir, who?.email].filter(Boolean).join('\n');
        it.contextValue = a.provider ? 'account-provider' : who ? 'account-claude' : 'account-signedout';
        if (!a.provider && !who) it.command = { command: 'steerhouse.login', title: 'Log in' };
        return it;
      }
      case 'rules': {
        const list = node.scope === 'user' ? userRules() : projectRules(node.root!);
        const it = new vscode.TreeItem(node.scope === 'user' ? vscode.l10n.t('My rules') : vscode.l10n.t('Project rules'), C.Collapsed);
        it.id = `rules:${node.scope}:${node.root ?? ''}`;
        it.iconPath = new vscode.ThemeIcon(node.scope === 'user' ? 'account' : 'law');
        const n = list.filter((r) => r.exists).length;
        it.description = n ? String(n) : vscode.l10n.t('none yet');
        it.tooltip = node.scope === 'user' ? vscode.l10n.t('Rules every agent follows in every project') : vscode.l10n.t('Rules agents follow in this project');
        it.contextValue = node.scope === 'user' ? 'rules-user' : 'rules-project';
        return it;
      }
      case 'rule': {
        const it = new vscode.TreeItem(node.r.label, C.None);
        it.id = `rule:${node.r.path}`;
        it.resourceUri = vscode.Uri.file(node.r.path);
        it.iconPath = new vscode.ThemeIcon(node.r.exists ? 'file' : 'new-file');
        it.description = node.r.exists ? vscode.l10n.t(node.r.hint) : vscode.l10n.t('create') + ' · ' + vscode.l10n.t(node.r.hint);
        it.tooltip = node.r.path;
        it.command = { command: 'steerhouse.openRules', title: 'Open', arguments: [node.r.path, node.scope] };
        return it;
      }
      case 'files': {
        const changed = changedFiles(node.sessions);
        const it = new vscode.TreeItem(vscode.l10n.t('Files'), C.Collapsed);
        it.id = `${node.via ?? ''}|files:${node.s?.info.id ?? ''}:${node.root}`;
        it.iconPath = new vscode.ThemeIcon('files');
        it.description = changed.size ? (node.s ? vscode.l10n.t('{0} changed by this session', changed.size) : vscode.l10n.t('{0} changed by agents', changed.size)) : '';
        it.tooltip = node.root;
        return it;
      }
      case 'fs': {
        const changed = changedFiles(node.sessions);
        const key = norm(node.path);
        const it = new vscode.TreeItem(path.basename(node.path), node.dir ? C.Collapsed : C.None);
        it.id = `${node.via ?? ''}|fs:${node.s?.info.id ?? ''}:${node.path}`;
        it.resourceUri = vscode.Uri.file(node.path); // file-type icons and git colors from the theme
        if (node.dir) {
          const inside = [...changed.keys()].filter((f) => f.startsWith(key + '/')).length;
          if (inside) it.description = vscode.l10n.t('{0} changed', inside);
        } else {
          const c = changed.get(key);
          if (c) it.description = `+${c.added} −${c.removed} · ${c.edits} edit${c.edits > 1 ? 's' : ''}`;
          it.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(node.path)] };
        }
        it.tooltip = node.path;
        it.contextValue = node.dir ? 'fsfolder' : 'fsfile';
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
        it.command = { command: 'steerhouse.openChange', title: 'Open diff', arguments: [node.s.info.id, c.id] };
        return it;
      }
    }
  }
}
