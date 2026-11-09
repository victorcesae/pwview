// One-off codemod: pin / archive projects and worktree projects in the Sessions tree; worktree and
// pin/archive commands.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 90));
  fs.writeFileSync(f, s.split(a).join(b));
};
const T = 'src/tree.ts';
R(T, `  | { kind: 'project'; path: string; sessions: Session[]; current: boolean }`, `  | { kind: 'project'; path: string; sessions: Session[]; current: boolean; pinned?: boolean; archived?: boolean }
  | { kind: 'archived'; projects: Extract<Node, { kind: 'project' }>[] }`);
R(T, `    private attached: () => Set<string>,`, `    private attached: () => Set<string>,
    /** projects the user pinned to the top or archived (moved under "Archived") */
    private marks: () => { pinned: string[]; archived: string[] } = () => ({ pinned: [], archived: [] }),`);
R(T, `      const projects = [...byProject.entries()].map(([p, list]) => ({
        kind: 'project' as const,
        path: p,
        sessions: list,
        current: roots.some((r) => norm(p) === r || norm(p).startsWith(r + '/')),
      }));
      projects.sort((a, b) => Number(b.current) - Number(a.current) || (b.sessions[0].info.updated ?? '').localeCompare(a.sessions[0].info.updated ?? ''));
      if (!sessions.length)
        out.push({ kind: 'hint', text: 'No agent sessions yet. Start one', command: 'steerhouse.newSession', icon: 'add' });
      return [...out, ...projects];`, `      const { pinned, archived } = this.marks();
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
      return [...out, ...projects, ...(hidden.length ? [{ kind: 'archived' as const, projects: hidden }] : [])];`);
R(T, `    switch (node.kind) {
      case 'hot':
        return node.files.map((hot) => ({ kind: 'hotfile', hot }));`, `    switch (node.kind) {
      case 'archived':
        return node.projects;
      case 'hot':
        return node.files.map((hot) => ({ kind: 'hotfile', hot }));`);
R(T, `      case 'project': {
        const it = new vscode.TreeItem(path.basename(node.path) || node.path, node.current ? C.Expanded : C.Collapsed);
        it.iconPath = new vscode.ThemeIcon(node.current ? 'root-folder-opened' : 'folder');
        const working = node.sessions.filter((s) => s.info.state === 'working').length;
        it.description = [vscode.l10n.t('{0} sessions', node.sessions.length), working ? vscode.l10n.t('{0} working', working) : '', node.current ? vscode.l10n.t('this workspace') : ''].filter(Boolean).join(' · ');
        it.tooltip = node.path;
        it.contextValue = 'project';
        return it;
      }`, `      case 'archived': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived'), C.Collapsed);
        it.id = 'archived';
        it.iconPath = new vscode.ThemeIcon('archive');
        it.description = vscode.l10n.t('{0} projects', node.projects.length);
        return it;
      }
      case 'project': {
        const wt = worktreeInfo(node.path);
        const it = new vscode.TreeItem(path.basename(node.path) || node.path, node.current && !node.archived ? C.Expanded : C.Collapsed);
        it.id = \`project:\${node.path}\`;
        it.iconPath = new vscode.ThemeIcon(wt ? 'git-branch' : node.pinned ? 'pinned' : node.current ? 'root-folder-opened' : 'folder');
        const working = node.sessions.filter((s) => s.info.state === 'working').length;
        it.description = [
          wt ? vscode.l10n.t('worktree of {0}', path.basename(wt.main)) + (wt.branch ? \` · \${wt.branch}\` : '') : '',
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
      }`);
R(T, `import { projectRules, userRules, type RuleFile } from './rules';`, `import { projectRules, userRules, type RuleFile } from './rules';\nimport { worktreeInfo } from './worktree';`);

// ---- extension: marks + commands
const E = 'src/extension.ts';
R(E, `  const tree = new SessionsTree(() => sessions, () => hooks, () => attachedSessions());`, `  const marks = () => ({ pinned: ctx.globalState.get<string[]>('steerhouse.pinned', []), archived: ctx.globalState.get<string[]>('steerhouse.archived', []) });
  const tree = new SessionsTree(() => sessions, () => hooks, () => attachedSessions(), marks);
  /** Adds or removes a project in a pinned / archived list, then repaints the tree. */
  const mark = async (list: 'pinned' | 'archived', p: string | undefined, on: boolean) => {
    if (!p) return;
    const key = \`steerhouse.\${list}\`;
    const cur = ctx.globalState.get<string[]>(key, []).filter((x) => x !== p);
    await ctx.globalState.update(key, on ? [...cur, p] : cur);
    tree.refresh();
  };`);
R(E, `    // Delete sessions (several when selected together)`, `    vscode.commands.registerCommand('steerhouse.pinProject', (n?: { path?: string }) => mark('pinned', n?.path, true)),
    vscode.commands.registerCommand('steerhouse.unpinProject', (n?: { path?: string }) => mark('pinned', n?.path, false)),
    vscode.commands.registerCommand('steerhouse.archiveProject', async (n?: { path?: string }) => (await mark('pinned', n?.path, false), mark('archived', n?.path, true))),
    vscode.commands.registerCommand('steerhouse.unarchiveProject', (n?: { path?: string }) => mark('archived', n?.path, false)),
    // A chat in its own git worktree (new branch, separate folder), so parallel agents don't collide
    vscode.commands.registerCommand('steerhouse.newChatInWorktree', async (n?: { path?: string } | vscode.Uri) => {
      const from = n instanceof vscode.Uri ? n.fsPath : (n?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (!from) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      const root = await repoRoot(from);
      if (!root) return vscode.window.showWarningMessage(vscode.l10n.t('{0} is not in a git repository.', path.basename(from)));
      const task = await vscode.window.showInputBox({ title: vscode.l10n.t('New chat in a worktree of {0}', path.basename(root)), prompt: vscode.l10n.t('What is this chat for? It names the branch.'), placeHolder: vscode.l10n.t('e.g. fix login redirect') });
      if (task === undefined) return;
      const branch = await vscode.window.showInputBox({
        title: vscode.l10n.t('Branch'),
        value: \`steerhouse/\${slug(task || new Date().toISOString().slice(0, 16))}\`,
        validateInput: (b) => (validBranch(b) ? undefined : vscode.l10n.t('Not a valid branch name')),
      });
      if (!branch) return;
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Creating worktree {0}…', branch) }, () => addWorktree(root, branch));
      if (!r.ok) return vscode.window.showErrorMessage(vscode.l10n.t('Could not create the worktree: {0}', r.error.slice(0, 300)));
      const account = await pickAgent(r.dir);
      if (account) chats.start({ cwd: r.dir, account, env: await envFor(account), title: task || undefined, prompt: undefined });
      refresh(true);
    }),
    vscode.commands.registerCommand('steerhouse.removeWorktree', async (n?: { path?: string }) => {
      const dir = n?.path;
      const info = dir && worktreeInfo(dir);
      if (!dir || !info) return;
      const ok = await vscode.window.showWarningMessage(
        vscode.l10n.t('Remove the worktree folder {0}?', path.basename(dir)),
        { modal: true, detail: vscode.l10n.t('The folder is deleted; the branch {0} and its commits stay in {1}. Sessions that ran there keep their history.', info.branch ?? '?', path.basename(info.main)) },
        vscode.l10n.t('Remove Worktree'),
      );
      if (!ok) return;
      let r = await removeWorktree(dir);
      if (!r.ok && /modified|untracked|dirty|changes/i.test(r.out)) {
        const force = await vscode.window.showWarningMessage(
          vscode.l10n.t('{0} has uncommitted changes.', path.basename(dir)),
          { modal: true, detail: vscode.l10n.t('Removing it anyway deletes those changes for good.') },
          vscode.l10n.t('Remove Anyway'),
        );
        if (!force) return;
        r = await removeWorktree(dir, true);
      }
      if (!r.ok) return vscode.window.showErrorMessage(r.out.slice(0, 300));
      vscode.window.setStatusBarMessage(vscode.l10n.t('$(git-branch) Steerhouse: worktree {0} removed', path.basename(dir)), 5000);
      refresh(true);
    }),
    // Delete sessions (several when selected together)`);
R(E, `import { installedAgents, runCliAgent } from './agents';`, `import { installedAgents, runCliAgent } from './agents';\nimport { addWorktree, removeWorktree, repoRoot, slug, validBranch, worktreeInfo } from './worktree';`);

// ---- manifest
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cmd = (command, key, icon) => p.contributes.commands.push({ command, title: `%${key}%`, category: 'Steerhouse', ...(icon ? { icon } : {}) });
cmd('steerhouse.newChatInWorktree', 'cmd.new.chat.worktree', '$(git-branch)');
cmd('steerhouse.removeWorktree', 'cmd.remove.worktree', '$(trash)');
cmd('steerhouse.pinProject', 'cmd.pin.project', '$(pin)');
cmd('steerhouse.unpinProject', 'cmd.unpin.project', '$(pinned)');
cmd('steerhouse.archiveProject', 'cmd.archive.project', '$(archive)');
cmd('steerhouse.unarchiveProject', 'cmd.unarchive.project', '$(inbox)');
const menu = p.contributes.menus['view/item/context'];
// existing "New chat here" entries now match a project by word
for (const m of menu) if (m.command === 'steerhouse.newChatHere' && m.when.includes('viewItem == project')) m.when = 'view == steerhouse.sessions && viewItem =~ /^project\\b/';
menu.push(
  { command: 'steerhouse.newChatInWorktree', when: 'view == steerhouse.sessions && viewItem =~ /^project\\b/', group: 'inline@1' },
  { command: 'steerhouse.pinProject', when: 'view == steerhouse.sessions && viewItem =~ /^project unpinned active/', group: '2_organize@1' },
  { command: 'steerhouse.unpinProject', when: 'view == steerhouse.sessions && viewItem =~ /^project pinned/', group: '2_organize@1' },
  { command: 'steerhouse.archiveProject', when: 'view == steerhouse.sessions && viewItem =~ /^project .* active/', group: '2_organize@2' },
  { command: 'steerhouse.unarchiveProject', when: 'view == steerhouse.sessions && viewItem =~ /^project .* archived/', group: '2_organize@2' },
  { command: 'steerhouse.removeWorktree', when: 'view == steerhouse.sessions && viewItem =~ /\\bworktree\\b/', group: '9_delete@1' },
);
p.contributes.menus['explorer/context'].push({ command: 'steerhouse.newChatInWorktree', when: 'explorerResourceIsFolder', group: 'steerhouse@2' });
for (const c of ['steerhouse.removeWorktree', 'steerhouse.pinProject', 'steerhouse.unpinProject', 'steerhouse.archiveProject', 'steerhouse.unarchiveProject']) p.contributes.menus.commandPalette.push({ command: c, when: 'false' });
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
const add = (f, o) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(j, o);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
};
add('package.nls.json', { 'cmd.new.chat.worktree': 'New Chat in a Worktree…', 'cmd.remove.worktree': 'Remove Worktree…', 'cmd.pin.project': 'Pin to Top', 'cmd.unpin.project': 'Unpin', 'cmd.archive.project': 'Archive Project', 'cmd.unarchive.project': 'Unarchive Project' });
add('package.nls.pt-br.json', { 'cmd.new.chat.worktree': 'Novo chat em um worktree…', 'cmd.remove.worktree': 'Remover worktree…', 'cmd.pin.project': 'Fixar no topo', 'cmd.unpin.project': 'Desafixar', 'cmd.archive.project': 'Arquivar projeto', 'cmd.unarchive.project': 'Desarquivar projeto' });
add('l10n/bundle.l10n.pt-br.json', {
  'No agent sessions yet. Start one': 'Nenhuma sessão de agente ainda. Comece uma',
  Archived: 'Arquivados',
  '{0} projects': '{0} projetos',
  'worktree of {0}': 'worktree de {0}',
  '{0} is not in a git repository.': '{0} não está em um repositório git.',
  'New chat in a worktree of {0}': 'Novo chat em um worktree de {0}',
  'What is this chat for? It names the branch.': 'Para que é este chat? Isso dá nome ao branch.',
  'e.g. fix login redirect': 'ex.: corrigir redirect do login',
  Branch: 'Branch',
  'Not a valid branch name': 'Nome de branch inválido',
  'Creating worktree {0}…': 'Criando worktree {0}…',
  'Could not create the worktree: {0}': 'Não foi possível criar o worktree: {0}',
  'Remove the worktree folder {0}?': 'Remover a pasta do worktree {0}?',
  'The folder is deleted; the branch {0} and its commits stay in {1}. Sessions that ran there keep their history.': 'A pasta é apagada; o branch {0} e seus commits ficam em {1}. As sessões que rodaram lá mantêm o histórico.',
  'Remove Worktree': 'Remover worktree',
  '{0} has uncommitted changes.': '{0} tem alterações sem commit.',
  'Removing it anyway deletes those changes for good.': 'Remover mesmo assim apaga essas alterações para sempre.',
  'Remove Anyway': 'Remover mesmo assim',
  '$(git-branch) Steerhouse: worktree {0} removed': '$(git-branch) Steerhouse: worktree {0} removido',
});
console.log('ok');
