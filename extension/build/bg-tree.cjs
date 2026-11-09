// One-off codemod: "Background commands" under each session in the Sessions tree.
const fs = require('fs');
const T = 'src/tree.ts';
let s = fs.readFileSync(T, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) throw new Error('MISSING ' + a.slice(0, 80));
  s = s.replace(a, b);
};
R(
  `  | { kind: 'accounts' }`,
  `  | { kind: 'tasks'; s: Session; via?: string }
  | { kind: 'task'; s: Session; task: BgTask; via?: string }
  | { kind: 'accounts' }`,
);
R(
  `        if (own.length) out.push({ kind: 'changes', s: node.s, list: own, via: node.via });`,
  `        if (own.length) out.push({ kind: 'changes', s: node.s, list: own, via: node.via });
        if (node.s.t.tasks?.length) out.push({ kind: 'tasks', s: node.s, via: node.via });`,
);
R(
  `      case 'archived':
        return node.projects;`,
  `      case 'archived':
        return node.projects;
      case 'tasks':
        // running first, newest first
        return [...node.s.t.tasks]
          .map((task) => ({ task, st: guessStatus(task, node.s.info.state === 'working') }))
          .sort((a, b) => Number(b.st === 'running') - Number(a.st === 'running') || (b.task.started ?? '').localeCompare(a.task.started ?? ''))
          .map(({ task, st }): Node => ({ kind: 'task', s: node.s, task: { ...task, status: st }, via: node.via }));`,
);
R(
  `      case 'archived': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived'), C.Collapsed);`,
  `      case 'tasks': {
        const running = node.s.t.tasks.filter((t) => guessStatus(t, node.s.info.state === 'working') === 'running').length;
        const it = new vscode.TreeItem(vscode.l10n.t('Background commands'), running ? C.Expanded : C.Collapsed);
        it.id = \`\${node.via ?? ''}|tasks:\${node.s.info.id}\`;
        it.iconPath = new vscode.ThemeIcon('terminal', running ? new vscode.ThemeColor('charts.blue') : undefined);
        it.description = running ? vscode.l10n.t('{0} running', running) : String(node.s.t.tasks.length);
        it.tooltip = vscode.l10n.t('Commands the agent left running: dev servers, watchers, long test runs');
        return it;
      }
      case 'task': {
        const t = node.task;
        const it = new vscode.TreeItem(clip(t.description || t.command || t.id, 60), C.None);
        it.id = \`\${node.via ?? ''}|task:\${node.s.info.id}:\${t.id}\`;
        const icon: Record<string, [string, string?]> = { running: ['loading~spin', 'charts.blue'], completed: ['pass', 'charts.green'], failed: ['error', 'charts.red'], stopped: ['debug-stop'], unknown: ['question', 'disabledForeground'] };
        const [i, color] = icon[t.status] ?? icon.unknown;
        it.iconPath = new vscode.ThemeIcon(i, color ? new vscode.ThemeColor(color) : undefined);
        const label = { running: vscode.l10n.t('running'), completed: vscode.l10n.t('done'), failed: vscode.l10n.t('failed'), stopped: vscode.l10n.t('stopped'), unknown: vscode.l10n.t('maybe stopped') }[t.status];
        it.description = [label, t.started ? ago(t.started) : ''].filter(Boolean).join(' · ');
        const md = new vscode.MarkdownString();
        md.appendCodeblock(t.command, 'bash');
        if (t.outputFile) md.appendMarkdown('\\n' + vscode.l10n.t('Output') + ': \`' + t.outputFile + '\`');
        it.tooltip = md;
        it.contextValue = 'bgtask';
        it.command = { command: 'steerhouse.openTaskFile', title: 'Open output', arguments: [{ task: t }] };
        return it;
      }
      case 'archived': {
        const it = new vscode.TreeItem(vscode.l10n.t('Archived'), C.Collapsed);`,
);
s = s.replace("import { worktreeInfo } from './worktree';", "import { worktreeInfo } from './worktree';\nimport { guessStatus, type BgTask } from './bgtasks';");
fs.writeFileSync(T, s);

const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.contributes.commands.push(
  { command: 'steerhouse.followTask', title: '%cmd.follow.task%', category: 'Steerhouse', icon: '$(debug-console)' },
  { command: 'steerhouse.openTaskFile', title: '%cmd.open.task.file%', category: 'Steerhouse', icon: '$(go-to-file)' },
);
p.contributes.menus['view/item/context'].push({ command: 'steerhouse.followTask', when: 'view == steerhouse.sessions && viewItem == bgtask', group: 'inline@1' });
for (const c of ['steerhouse.followTask', 'steerhouse.openTaskFile']) p.contributes.menus.commandPalette.push({ command: c, when: 'false' });
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
const add = (f, o) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(j, o);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
};
add('package.nls.json', { 'cmd.follow.task': 'Follow in Terminal', 'cmd.open.task.file': 'Open Output' });
add('package.nls.pt-br.json', { 'cmd.follow.task': 'Acompanhar no terminal', 'cmd.open.task.file': 'Abrir saída' });
add('l10n/bundle.l10n.pt-br.json', {
  'Background commands': 'Comandos em segundo plano',
  'Commands the agent left running: dev servers, watchers, long test runs': 'Comandos que o agente deixou rodando: servidores de dev, watchers, testes longos',
  running: 'rodando',
  done: 'concluído',
  failed: 'falhou',
  stopped: 'parado',
  'maybe stopped': 'talvez parado',
  Output: 'Saída',
});
console.log('ok');
