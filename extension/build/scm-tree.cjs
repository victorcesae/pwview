// One-off codemod: "Source control" under each project (and worktree) in the Sessions tree.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 80));
  fs.writeFileSync(f, s.replace(a, b));
};
const T = 'src/tree.ts';
R(T, `  | { kind: 'accounts' }`, `  | { kind: 'scm'; root: string }
  | { kind: 'scmfile'; root: string; file: ScmFile }
  | { kind: 'accounts' }`);
R(T, `import { worktreeInfo } from './worktree';`, `import { worktreeInfo } from './worktree';\nimport { scmFiles, scmSummary, type Scm, type ScmFile } from './scm';`);
R(T, `  refresh() {`, `  private scm?: Scm;
  /** Source control (VS Code's Git) for the "Source control" node of each project. */
  setScm(scm: Scm) {
    this.scm = scm;
  }

  refresh() {`);
R(
  T,
  `        const rules: Node[] = fs.existsSync(node.path) ? [{ kind: 'rules', scope: 'project', root: node.path }] : [];
        return [...rules, ...files, ...node.sessions.map((s): Node => ({ kind: 'session', s }))];`,
  `        const rules: Node[] = fs.existsSync(node.path) ? [{ kind: 'rules', scope: 'project', root: node.path }] : [];
        // shown once VS Code's Git has the repository (opened in the background the first time)
        const scm: Node[] = fs.existsSync(node.path) && this.scm?.peek(node.path) ? [{ kind: 'scm', root: node.path }] : [];
        return [...scm, ...rules, ...files, ...node.sessions.map((s): Node => ({ kind: 'session', s }))];`,
);
R(
  T,
  `      case 'archived':
        return node.projects;`,
  `      case 'archived':
        return node.projects;
      case 'scm': {
        const r = this.scm?.peek(node.root);
        return r ? scmFiles(r.state).map((file): Node => ({ kind: 'scmfile', root: node.root, file })) : [];
      }`,
);
R(
  T,
  `      case 'tasks': {
        const running =`,
  `      case 'scm': {
        const r = this.scm?.peek(node.root);
        const n = r ? scmFiles(r.state).length : 0;
        const it = new vscode.TreeItem(vscode.l10n.t('Source control'), n ? C.Collapsed : C.None);
        it.id = \`scm:\${node.root}\`;
        it.iconPath = new vscode.ThemeIcon('source-control', n ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined);
        it.description = r ? scmSummary(r.state, vscode.l10n.t) : '';
        it.tooltip = node.root;
        const h = r?.state.HEAD;
        it.contextValue = ['scm', n ? 'dirty' : 'clean', h?.upstream ? 'tracked' : 'untracked', h?.ahead ? 'ahead' : '', h?.behind ? 'behind' : ''].filter(Boolean).join(' ');
        return it;
      }
      case 'scmfile': {
        const f = node.file;
        const it = new vscode.TreeItem(path.basename(f.path), C.None);
        it.id = \`scmfile:\${node.root}:\${f.staged}:\${f.path}\`;
        it.resourceUri = vscode.Uri.file(f.path); // file icon and git colour from the theme
        it.description = [f.letter, f.staged ? vscode.l10n.t('staged') : '', rel(path.dirname(f.path), node.root)].filter(Boolean).join(' · ');
        it.tooltip = \`\${f.path}\\n\${vscode.l10n.t(f.label)}\${f.staged ? ' · ' + vscode.l10n.t('staged') : ''}\`;
        it.contextValue = 'scmfile';
        it.command = { command: 'steerhouse.scm.openChange', title: 'Open change', arguments: [node] };
        return it;
      }
      case 'tasks': {
        const running =`,
);

const E = 'src/extension.ts';
R(E, `  registerFileActions(ctx, () => tree.refresh());`, `  registerFileActions(ctx, () => tree.refresh());
  // Source control per project, through VS Code's own Git
  const scm = new Scm(() => tree.refresh());
  tree.setScm(scm);
  const rootOf = (n?: { root?: string; path?: string }) => n?.root ?? n?.path;
  const scmRun = (fn: (root: string) => Promise<unknown>) => async (n?: { root?: string; path?: string }) => {
    const root = rootOf(n);
    if (!root) return;
    try {
      await fn(root);
    } catch (e: any) {
      vscode.window.showErrorMessage(vscode.l10n.t('Git: {0}', String(e?.stderr || e?.message || e).split('\\n')[0]));
    }
    tree.refresh();
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand('steerhouse.scm.commit', scmRun((r) => scm.commit(r))),
    vscode.commands.registerCommand('steerhouse.scm.push', scmRun((r) => scm.push(r))),
    vscode.commands.registerCommand('steerhouse.scm.pull', scmRun((r) => scm.pull(r))),
    vscode.commands.registerCommand('steerhouse.scm.sync', scmRun((r) => scm.sync(r))),
    vscode.commands.registerCommand('steerhouse.scm.openView', () => vscode.commands.executeCommand('workbench.view.scm')),
    vscode.commands.registerCommand('steerhouse.scm.openChange', (n?: { root: string; file: ScmFile }) => n && scm.openDiff(n.root, n.file)),
    vscode.commands.registerCommand('steerhouse.scm.openFile', (n?: { file: ScmFile }) => n && vscode.commands.executeCommand('vscode.open', vscode.Uri.file(n.file.path))),
  );`);
R(E, `import { registerFileActions } from './fileActions';`, `import { registerFileActions } from './fileActions';\nimport { Scm, type ScmFile } from './scm';`);

const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const cmds = [
  ['steerhouse.scm.commit', 'Commit…', 'Fazer commit…', '$(check)', 'view == steerhouse.sessions && viewItem =~ /^scm dirty/', 'inline@1'],
  ['steerhouse.scm.sync', 'Sync (Pull and Push)', 'Sincronizar (pull e push)', '$(sync)', 'view == steerhouse.sessions && viewItem =~ /^scm .*\\btracked\\b/', 'inline@2'],
  ['steerhouse.scm.push', 'Push', 'Push', '$(cloud-upload)', 'view == steerhouse.sessions && viewItem =~ /^scm\\b/', '1_sync@1'],
  ['steerhouse.scm.pull', 'Pull', 'Pull', '$(cloud-download)', 'view == steerhouse.sessions && viewItem =~ /^scm .*\\btracked\\b/', '1_sync@2'],
  ['steerhouse.scm.openView', 'Open Source Control', 'Abrir Controle do Código-Fonte', '$(source-control)', 'view == steerhouse.sessions && viewItem =~ /^scm\\b/', 'inline@3'],
  ['steerhouse.scm.openFile', 'Open File', 'Abrir Arquivo', '$(go-to-file)', 'view == steerhouse.sessions && viewItem == scmfile', 'inline@1'],
  ['steerhouse.scm.openChange', 'Open Changes', 'Abrir Alterações', '$(diff)', undefined, undefined],
];
const en = JSON.parse(fs.readFileSync('package.nls.json', 'utf8'));
const pt = JSON.parse(fs.readFileSync('package.nls.pt-br.json', 'utf8'));
for (const [id, eng, por, icon, when, group] of cmds) {
  const key = 'cmd.' + id.replace(/^steerhouse\./, '').replace(/\./g, '-');
  en[key] = eng;
  pt[key] = por;
  p.contributes.commands.push({ command: id, title: `%${key}%`, category: 'Steerhouse', icon });
  p.contributes.menus.commandPalette.push({ command: id, when: 'false' });
  if (when) p.contributes.menus['view/item/context'].push({ command: id, when, group });
}
// the main actions also in the right-click menu (inline buttons are icons only)
p.contributes.menus['view/item/context'].push(
  { command: 'steerhouse.scm.commit', when: 'view == steerhouse.sessions && viewItem =~ /^scm dirty/', group: '0_commit@1' },
  { command: 'steerhouse.scm.sync', when: 'view == steerhouse.sessions && viewItem =~ /^scm .*\\btracked\\b/', group: '1_sync@0' },
  { command: 'steerhouse.scm.openView', when: 'view == steerhouse.sessions && viewItem =~ /^scm\\b/', group: '2_view@1' },
);
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
fs.writeFileSync('package.nls.json', JSON.stringify(en, null, 2) + '\n');
fs.writeFileSync('package.nls.pt-br.json', JSON.stringify(pt, null, 2) + '\n');
const b = JSON.parse(fs.readFileSync('l10n/bundle.l10n.pt-br.json', 'utf8'));
Object.assign(b, {
  'Source control': 'Controle do código-fonte',
  'not pushed': 'sem push',
  detached: 'desanexado',
  '{0} change': '{0} alteração',
  '{0} changes': '{0} alterações',
  clean: 'limpo',
  staged: 'preparado',
  'working tree': 'árvore de trabalho',
  modified: 'modificado',
  added: 'adicionado',
  deleted: 'excluído',
  renamed: 'renomeado',
  copied: 'copiado',
  untracked: 'não rastreado',
  'type changed': 'tipo alterado',
  conflict: 'conflito',
  changed: 'alterado',
  'Nothing to commit in {0}.': 'Nada para commitar em {0}.',
  'Resolve the merge conflicts first.': 'Resolva os conflitos de merge antes.',
  'Commit {0} staged change(s) in {1}': 'Commit de {0} alteração(ões) preparada(s) em {1}',
  'Commit all {0} change(s) in {1}': 'Commit de todas as {0} alteração(ões) em {1}',
  'Commit message': 'Mensagem do commit',
  'Enter a commit message': 'Digite uma mensagem de commit',
  '$(git-commit) Committed in {0}': '$(git-commit) Commit feito em {0}',
  'Pushing {0}…': 'Fazendo push de {0}…',
  'Pulling {0}…': 'Fazendo pull de {0}…',
  'Git: {0}': 'Git: {0}',
});
fs.writeFileSync('l10n/bundle.l10n.pt-br.json', JSON.stringify(b, null, 2) + '\n');
console.log('ok');
