import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentInfo, Change, Engine, HotFile, Session, State } from './engine';
import { norm } from './paths';
import { projectRules, userRules, type RuleFile } from './rules';
import { worktreeInfo } from './worktree';
import { scmFiles, scmSummary, type Scm, type ScmFile } from './scm';
import { guessStatus, type BgTask } from './bgtasks';
import { accountIdentity, listAccounts, preferredAccount, type Account, listCursorAccounts, type CursorAccount } from './accounts';
import { modelLabel } from './pricing';
import { vendorOf } from './providers';
import { ago, clip, rel } from './util';

export type Node =
  | { kind: 'hint'; text: string; command: string; icon: string }
  | { kind: 'hot'; files: HotFile[] }
  | { kind: 'hotfile'; hot: HotFile }
  | { kind: 'archived'; projects: Extract<Node, { kind: 'project' }>[] }
  | { kind: 'project'; path: string; sessions: Session[]; current: boolean; pinned?: boolean; archived?: boolean; noSessions?: boolean }
  | { kind: 'section'; which: 'pinned' | 'active' | 'recent' | 'projects'; items: Node[] }
  | { kind: 'hiddenChats'; sessions: Session[] }
  | { kind: 'session'; s: Session; via?: string; flat?: boolean }
  | { kind: 'agent'; s: Session; a: AgentInfo; via?: string }
  | { kind: 'changes'; s: Session; agentId?: string; list: Change[]; via?: string }
  | { kind: 'change'; s: Session; c: Change; via?: string }
  /** the project's folders and files, like the Explorer; files agents changed are marked */
  | { kind: 'tasks'; s: Session; via?: string }
  | { kind: 'task'; s: Session; task: BgTask; via?: string }
  | { kind: 'scm'; root: string }
  | { kind: 'scmfile'; root: string; file: ScmFile }
  | { kind: 'accounts' }
  | { kind: 'account'; a: Account }
  | { kind: 'cursorAccount'; c: CursorAccount; a: CursorAccount }
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

  /** Per-chat pin / archive / snooze, kept in globalState (set by registerChatMarks). */
  chatMarks?: ChatMarks;

  private needsSetup = false;
  setNeedsSetup(on: boolean) {
    this.needsSetup = on;
    this.refresh();
  }

  private scm?: Scm;
  /** Source control (VS Code's Git) for the "Source control" node of each project. */
  setScm(scm: Scm) {
    this.scm = scm;
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  private workspaceRoots() {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => norm(f.uri.fsPath));
  }

  /** older runs of the same chat, by the id of the newest one */
  private runs = new Map<string, Session[]>();

  getChildren(node?: Node): Node[] {
    const { shown: sessions, runs } = collapseRuns(this.sessions());
    this.runs = runs;
    if (!node) {
      const out: Node[] = [];
      const h = this.hooks();
      if (h !== 'all')
        out.push({ kind: 'hint', text: h === 'some' ? 'Update hooks to enable steering & send now' : 'Enable messages to agents (steer, queue, send now)', command: 'steerhouse.installHooks', icon: 'warning' });
      const hot = Engine.hotFiles(sessions);
      if (hot.length) out.push({ kind: 'hot', files: hot });
      if (this.needsSetup) out.unshift({ kind: 'hint', text: vscode.l10n.t('Finish setting up: Get Started'), command: 'steerhouse.walkthrough', icon: 'rocket' });
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
      if (vscode.workspace.getConfiguration('steerhouse').get<string>('sidebarGrouping', 'chats') !== 'projects') return [...out, ...this.chatSections(sessions, all)];
      return [...out, ...projects, ...(hidden.length ? [{ kind: 'archived' as const, projects: hidden }] : [])];
    }
    switch (node.kind) {
      case 'archived':
        return node.projects;
      case 'section':
        return node.items;
      case 'hiddenChats':
        return node.sessions.map((s): Node => ({ kind: 'session', s, flat: true }));
      case 'scm': {
        const r = this.scm?.peek(node.root);
        return r ? scmFiles(r.state).map((file): Node => ({ kind: 'scmfile', root: node.root, file })) : [];
      }
      case 'tasks':
        // running first, newest first
        return [...node.s.t.tasks]
          .map((task) => ({ task, st: guessStatus(task, node.s.info.state === 'working') }))
          .sort((a, b) => Number(b.st === 'running') - Number(a.st === 'running') || (b.task.started ?? '').localeCompare(a.task.started ?? ''))
          .map(({ task, st }): Node => ({ kind: 'task', s: node.s, task: { ...task, status: st }, via: node.via }));
      case 'hot':
        return node.files.map((hot) => ({ kind: 'hotfile', hot }));
      case 'hotfile':
        return sessions.filter((s) => node.hot.sessions.includes(s.info.id)).map((s) => ({ kind: 'session', s, via: `hot:${node.hot.file}` }));
      case 'project': {
        const files: Node[] = fs.existsSync(node.path) ? [{ kind: 'files', root: node.path, sessions: node.sessions }] : [];
        const rules: Node[] = fs.existsSync(node.path) ? [{ kind: 'rules', scope: 'project', root: node.path }] : [];
        // shown once VS Code's Git has the repository (opened in the background the first time)
        const scm: Node[] = fs.existsSync(node.path) && this.scm?.peek(node.path) ? [{ kind: 'scm', root: node.path }] : [];
        return [...scm, ...rules, ...files, ...(node.noSessions ? [] : node.sessions.map((s): Node => ({ kind: 'session', s })))];
      }
      case 'accounts':
        return [
          ...listAccounts().map((a): Node => ({ kind: 'account', a })),
          ...listCursorAccounts().map((c): Node => ({ kind: 'cursorAccount', c, a: c })),
          { kind: 'hint', text: vscode.l10n.t('Add a Claude account…'), command: 'steerhouse.addAccount', icon: 'add' },
          { kind: 'hint', text: vscode.l10n.t('Add a Cursor account…'), command: 'steerhouse.addCursorAccount', icon: 'add' },
          { kind: 'hint', text: vscode.l10n.t('Add a model provider (Ollama, OpenRouter…)…'), command: 'steerhouse.addProvider', icon: 'server' },
        ];
      case 'rules': {
        const list = node.scope === 'user' ? userRules() : projectRules(node.root!);
        return list.map((r): Node => ({ kind: 'rule', scope: node.scope, r }));
      }
      case 'session': {
        const older = node.via === 'run' ? [] : (this.runs.get(node.s.info.id) ?? []);
        const out: Node[] = [...older.map((s): Node => ({ kind: 'session', s, via: 'run' })), ...node.s.agents.map((a) => ({ kind: 'agent', s: node.s, a: a.info, via: node.via }) as Node)];
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

  /** The chat-first layout: Pinned, Active, Recent (all folders mixed), then the projects, collapsed. */
  private chatSections(sessions: Session[], projects: Extract<Node, { kind: 'project' }>[]): Node[] {
    const cm = this.chatMarks;
    const newest = [...sessions].sort((a, b) => (b.info.updated ?? '').localeCompare(a.info.updated ?? ''));
    const hidden = newest.filter((s) => cm && (cm.isArchived(s.info.id) || cm.snoozedUntil(s.info.id)));
    const shown = newest.filter((s) => !hidden.includes(s));
    const row = (s: Session): Node => ({ kind: 'session', s, flat: true });
    const pinned = shown.filter((s) => cm?.isPinned(s.info.id));
    const rest = shown.filter((s) => !pinned.includes(s));
    const active = rest.filter((s) => s.info.state !== 'idle');
    const recent = rest.filter((s) => s.info.state === 'idle');
    const out: Node[] = [];
    if (pinned.length) out.push({ kind: 'section', which: 'pinned', items: pinned.map(row) });
    if (active.length) out.push({ kind: 'section', which: 'active', items: active.map(row) });
    if (recent.length || hidden.length) out.push({ kind: 'section', which: 'recent', items: [...recent.map(row), ...(hidden.length ? [{ kind: 'hiddenChats' as const, sessions: hidden }] : [])] });
    if (projects.length) out.push({ kind: 'section', which: 'projects', items: projects.map((p) => ({ ...p, noSessions: true })) });
    return out;
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
      case 'scm': {
        const r = this.scm?.peek(node.root);
        const n = r ? scmFiles(r.state).length : 0;
        const it = new vscode.TreeItem(vscode.l10n.t('Source control'), n ? C.Collapsed : C.None);
        it.id = `scm:${node.root}`;
        it.iconPath = new vscode.ThemeIcon('source-control', n ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
        it.description = r ? scmSummary(r.state, (s, ...a) => vscode.l10n.t(s, ...(a as (string | number)[]))) : '';
        it.tooltip = node.root;
        const h = r?.state.HEAD;
        it.contextValue = ['scm', n ? 'dirty' : 'clean', h?.upstream ? 'tracked' : 'untracked', h?.ahead ? 'ahead' : '', h?.behind ? 'behind' : ''].filter(Boolean).join(' ');
        return it;
      }
      case 'scmfile': {
        const f = node.file;
        const it = new vscode.TreeItem(path.basename(f.path), C.None);
        it.id = `scmfile:${node.root}:${f.staged}:${f.path}`;
        it.resourceUri = vscode.Uri.file(f.path); // file icon and git colour from the theme
        it.description = [f.letter, f.staged ? vscode.l10n.t('staged') : '', rel(path.dirname(f.path), node.root)].filter(Boolean).join(' · ');
        it.tooltip = `${f.path}\n${vscode.l10n.t(f.label)}${f.staged ? ' · ' + vscode.l10n.t('staged') : ''}`;
        it.contextValue = 'scmfile';
        it.command = { command: 'steerhouse.scm.openChange', title: 'Open change', arguments: [node] };
        return it;
      }
      case 'tasks': {
        const running = node.s.t.tasks.filter((t) => guessStatus(t, node.s.info.state === 'working') === 'running').length;
        const it = new vscode.TreeItem(vscode.l10n.t('Background commands'), running ? C.Expanded : C.Collapsed);
        it.id = `${node.via ?? ''}|tasks:${node.s.info.id}`;
        it.iconPath = new vscode.ThemeIcon('terminal', running ? new vscode.ThemeColor('charts.blue') : undefined);
        it.description = running ? vscode.l10n.t('{0} running', running) : String(node.s.t.tasks.length);
        it.tooltip = vscode.l10n.t('Commands the agent left running: dev servers, watchers, long test runs');
        return it;
      }
      case 'task': {
        const t = node.task;
        const it = new vscode.TreeItem(clip(t.description || t.command || t.id, 60), C.None);
        it.id = `${node.via ?? ''}|task:${node.s.info.id}:${t.id}`;
        const icon: Record<string, [string, string?]> = { running: ['loading~spin', 'charts.blue'], completed: ['pass', 'charts.green'], failed: ['error', 'charts.red'], stopped: ['debug-stop'], unknown: ['question', 'disabledForeground'] };
        const [i, color] = icon[t.status] ?? icon.unknown;
        it.iconPath = new vscode.ThemeIcon(i, color ? new vscode.ThemeColor(color) : undefined);
        const label = { running: vscode.l10n.t('running'), completed: vscode.l10n.t('done'), failed: vscode.l10n.t('failed'), stopped: vscode.l10n.t('stopped'), unknown: vscode.l10n.t('maybe stopped') }[t.status];
        it.description = [label, t.started ? ago(t.started) : ''].filter(Boolean).join(' · ');
        const md = new vscode.MarkdownString();
        md.appendCodeblock(t.command, 'bash');
        if (t.outputFile) md.appendMarkdown('\n' + vscode.l10n.t('Output') + ': `' + t.outputFile + '`');
        it.tooltip = md;
        it.contextValue = 'bgtask';
        it.command = { command: 'steerhouse.openTaskFile', title: 'Open output', arguments: [{ task: t }] };
        return it;
      }
      case 'archived': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived'), C.Collapsed);
        it.id = 'archived';
        it.iconPath = new vscode.ThemeIcon('archive');
        it.description = vscode.l10n.t('{0} projects', node.projects.length);
        return it;
      }
      case 'section': {
        const labels = { pinned: vscode.l10n.t('Pinned'), active: vscode.l10n.t('Active'), recent: vscode.l10n.t('Recent'), projects: vscode.l10n.t('Projects') };
        const icons = { pinned: 'pinned', active: 'pulse', recent: 'history', projects: 'folder-library' };
        const it = new vscode.TreeItem(labels[node.which], node.which === 'projects' ? C.Collapsed : C.Expanded);
        it.id = `section:${node.which}`;
        it.iconPath = new vscode.ThemeIcon(icons[node.which]);
        it.description = String(node.items.filter((n) => n.kind !== 'hiddenChats').length);
        it.contextValue = `section-${node.which}`;
        return it;
      }
      case 'hiddenChats': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived ({0})', node.sessions.length), C.Collapsed);
        it.id = 'hiddenChats';
        it.iconPath = new vscode.ThemeIcon('archive');
        it.tooltip = vscode.l10n.t('Archived and snoozed chats');
        return it;
      }
      case 'project': {
        const wt = worktreeInfo(node.path);
        const it = new vscode.TreeItem(path.basename(node.path) || node.path, node.current && !node.archived && !node.noSessions ? C.Expanded : C.Collapsed);
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
        const it = new vscode.TreeItem(clip(i.title, 48), C.Collapsed);
        it.id = `${node.via ?? ''}|s:${i.id}`;
        // the agent's own mark (Claude, GPT, Llama…); a spinner while it works
        it.iconPath = i.state === 'working' ? stateIcon('working') : vendorIcon(i.model);
        const bits = [listAccounts().length > 1 ? `👤 ${listAccounts().find((a) => a.id === i.account)?.name ?? i.account}` : '', this.attached().has(i.id) ? '⌨ terminal' : '', i.model ? modelLabel(i.model) : '', i.branch, `${i.edits} edits`, i.agents.length ? `${i.agents.length} agents` : '', i.pendingComments ? `${i.pendingComments} comments queued` : '', ago(i.updated)];
        it.description = node.flat ? [path.basename(i.project) || i.project, i.branch, ago(i.updated)].filter(Boolean).join(' · ') : bits.filter(Boolean).join(' · ');
        const cm = this.chatMarks;
        const snoozed = cm?.snoozedUntil(i.id);
        if (node.flat && cm?.isArchived(i.id)) it.description += ' · ' + vscode.l10n.t('archived');
        else if (node.flat && snoozed) it.description += ' · ' + vscode.l10n.t('hidden until {0}', new Date(snoozed).toLocaleString());
        const nRuns = node.via === 'run' ? 0 : (this.runs.get(i.id)?.length ?? 0);
        if (nRuns) it.description = `${it.description} · ${vscode.l10n.t('{0} earlier runs', nRuns)}`;
        if (node.via === 'run') it.description = `${vscode.l10n.t('earlier run')} · ${it.description}`;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${i.title}**\n\n`);
        md.appendMarkdown(`$(folder) \`${i.project}\`  \n`);
        if (i.branch) md.appendMarkdown(`$(git-branch) ${i.branch}  \n`);
        if (i.model) md.appendMarkdown(`$(sparkle) ${i.model}  \n`);
        md.appendMarkdown(`$(pulse) ${i.state} · updated ${ago(i.updated)}\n\n`);
        if (i.lastPrompt) md.appendMarkdown(`---\n**Last prompt:** ${clip(i.lastPrompt, 400)}\n\n`);
        if (i.linked.length) md.appendMarkdown(`$(link) Shares files with ${i.linked.length} other session(s)\n`);
        it.tooltip = md;
        // "session pinned hidden": menus match the words they need (\bsession\b keeps the old menus)
        it.contextValue = ['session', cm?.isPinned(i.id) ? 'pinned' : 'unpinned', cm && (cm.isArchived(i.id) || snoozed) ? 'hidden' : 'shown'].join(' ');
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
      case 'cursorAccount': {
        const it = new vscode.TreeItem(node.c.name, C.None);
        it.id = 'account:' + node.c.id;
        it.iconPath = mediaRoot ? vscode.Uri.joinPath(mediaRoot, 'vendors', 'cursor.svg') : new vscode.ThemeIcon('account');
        it.description = 'Cursor Agent';
        it.tooltip = [node.c.name, node.c.dir].join('\n');
        it.contextValue = 'account-cursor';
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

/** Per-chat marks in globalState: pinned ids, archived ids, and snoozed ids with the time they come back. */
export class ChatMarks {
  constructor(private state: vscode.Memento) {}
  private list = (k: string) => this.state.get<string[]>(k, []);
  isPinned = (id: string) => this.list('steerhouse.chatPinned').includes(id);
  isArchived = (id: string) => this.list('steerhouse.chatArchived').includes(id);
  /** when a snoozed chat comes back (ms), or undefined if it is not snoozed now */
  snoozedUntil(id: string): number | undefined {
    const t = this.state.get<Record<string, number>>('steerhouse.chatSnoozed', {})[id];
    return t && t > Date.now() ? t : undefined;
  }
  async set(list: 'chatPinned' | 'chatArchived', ids: string[], on: boolean) {
    const k = `steerhouse.${list}`;
    const cur = this.list(k).filter((x) => !ids.includes(x));
    await this.state.update(k, on ? [...cur, ...ids] : cur);
  }
  async snooze(ids: string[], ms: number | undefined) {
    const now = Date.now();
    const cur = Object.fromEntries(Object.entries(this.state.get<Record<string, number>>('steerhouse.chatSnoozed', {})).filter(([id, t]) => t > now && !ids.includes(id)));
    if (ms) for (const id of ids) cur[id] = now + ms;
    await this.state.update('steerhouse.chatSnoozed', cur);
  }
}

/** Pin / unpin / snooze / archive commands for chats in the tree. Menus pass the clicked node and the selection. */
export function registerChatMarks(ctx: vscode.ExtensionContext, tree: SessionsTree): vscode.Disposable[] {
  const cm = (tree.chatMarks = new ChatMarks(ctx.globalState));
  const ids = (n: unknown, sel?: unknown[]) =>
    [...new Set(((sel?.length ? sel : [n]) as (Node | undefined)[]).filter((x): x is Extract<Node, { kind: 'session' }> => x?.kind === 'session').map((x) => x.s.info.id))];
  const cmd = (name: string, run: (list: string[]) => Promise<unknown>) =>
    vscode.commands.registerCommand(name, async (n?: unknown, sel?: unknown[]) => {
      const list = ids(n, sel);
      if (!list.length) return;
      await run(list);
      tree.refresh();
    });
  const DAY = 86_400_000;
  // re-show chats whose snooze ran out
  const timer = setInterval(() => tree.refresh(), 10 * 60_000);
  return [
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('steerhouse.sidebarGrouping') && tree.refresh()),
    cmd('steerhouse.pinChat', (l) => cm.set('chatPinned', l, true)),
    cmd('steerhouse.unpinChat', (l) => cm.set('chatPinned', l, false)),
    cmd('steerhouse.snoozeChatDay', (l) => cm.snooze(l, DAY)),
    cmd('steerhouse.snoozeChatWeek', (l) => cm.snooze(l, 7 * DAY)),
    cmd('steerhouse.archiveChat', async (l) => (await cm.set('chatPinned', l, false), cm.set('chatArchived', l, true))),
    cmd('steerhouse.unarchiveChat', async (l) => (await cm.set('chatArchived', l, false), cm.snooze(l, undefined))),
  ];
}

/**
 * "Edit and run again" and restores fork the session: each copy starts with the same prompt and
 * would show as a duplicate. Only the newest copy is listed; the others become its earlier runs.
 */
export function collapseRuns(all: Session[]): { shown: Session[]; runs: Map<string, Session[]> } {
  const groups = new Map<string, Session[]>();
  const shown: Session[] = [];
  for (const s of all) {
    const p = s.info.firstPrompt?.trim();
    if (!p || p.length < 12) {
      shown.push(s);
      continue;
    }
    const k = `${norm(s.info.project)}\0${p}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else (groups.set(k, [s]), shown.push(s));
  }
  const runs = new Map<string, Session[]>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.info.updated ?? '').localeCompare(a.info.updated ?? ''));
    const i = shown.indexOf(g.find((x) => shown.includes(x))!);
    shown[i] = g[0]; // the newest stands for the group, where the group was listed
    runs.set(g[0].info.id, g.slice(1));
  }
  // a working or pinned older run must not vanish: list it on its own
  for (const [id, older] of runs) {
    const keep = older.filter((s) => s.info.state === 'working');
    if (keep.length) (shown.push(...keep), runs.set(id, older.filter((s) => !keep.includes(s))));
  }
  return { shown, runs };
}
