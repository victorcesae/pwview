// One-off: Explorer-like right-click menu on files and folders in the Sessions tree.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 80));
  fs.writeFileSync(f, s.replace(a, b));
};
R('src/extension.ts', `  restoreTestHooks(chats);`, `  restoreTestHooks(chats);
  registerFileActions(ctx, () => tree.refresh());`);
R('src/extension.ts', `import { migrateFromAgentLens } from './migrate';`, `import { migrateFromAgentLens } from './migrate';\nimport { registerFileActions } from './fileActions';`);

const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const C = [
  ['steerhouse.fs.openToSide', 'Open to the Side', 'Abrir ao Lado', 'file'],
  ['steerhouse.fs.revealInExplorer', 'Reveal in Explorer (all actions)', 'Revelar no Explorador (todas as ações)', 'both'],
  ['steerhouse.fs.revealInOS', 'Reveal in File Explorer', 'Revelar no Explorador de Arquivos', 'both'],
  ['steerhouse.fs.newFile', 'New File…', 'Novo Arquivo…', 'folder'],
  ['steerhouse.fs.newFolder', 'New Folder…', 'Nova Pasta…', 'folder'],
  ['steerhouse.fs.findInFolder', 'Find in Folder…', 'Localizar na Pasta…', 'folder'],
  ['steerhouse.fs.selectForCompare', 'Select for Compare', 'Selecionar para Comparar', 'file'],
  ['steerhouse.fs.compareWithSelected', 'Compare with Selected', 'Comparar com o Selecionado', 'file'],
  ['steerhouse.fs.copyPath', 'Copy Path', 'Copiar o Caminho', 'both'],
  ['steerhouse.fs.copyRelativePath', 'Copy Relative Path', 'Copiar Caminho Relativo', 'both'],
  ['steerhouse.fs.rename', 'Rename…', 'Renomear…', 'both'],
  ['steerhouse.fs.delete', 'Delete', 'Excluir', 'both'],
];
const group = {
  'steerhouse.fs.openToSide': 'navigation@1',
  'steerhouse.fs.revealInExplorer': 'navigation@2',
  'steerhouse.fs.revealInOS': 'navigation@3',
  'steerhouse.fs.newFile': '1_new@1',
  'steerhouse.fs.newFolder': '1_new@2',
  'steerhouse.fs.findInFolder': '4_search@1',
  'steerhouse.fs.selectForCompare': '3_compare@1',
  'steerhouse.fs.compareWithSelected': '3_compare@2',
  'steerhouse.fs.copyPath': '6_copypath@1',
  'steerhouse.fs.copyRelativePath': '6_copypath@2',
  'steerhouse.fs.rename': '7_modification@1',
  'steerhouse.fs.delete': '7_modification@2',
};
const en = JSON.parse(fs.readFileSync('package.nls.json', 'utf8'));
const pt = JSON.parse(fs.readFileSync('package.nls.pt-br.json', 'utf8'));
const menu = p.contributes.menus['view/item/context'];
for (const [id, eng, por, on] of C) {
  const key = 'cmd.' + id.replace(/^steerhouse\./, '').replace(/\./g, '-');
  en[key] = eng;
  pt[key] = por;
  p.contributes.commands.push({ command: id, title: `%${key}%`, category: 'Steerhouse' });
  p.contributes.menus.commandPalette.push({ command: id, when: 'false' });
  const item = on === 'file' ? 'viewItem == fsfile' : on === 'folder' ? 'viewItem == fsfolder' : 'viewItem =~ /^fs(file|folder)$/';
  const extra = id === 'steerhouse.fs.compareWithSelected' ? ' && steerhouse.compareSelected' : '';
  menu.push({ command: id, when: `view == steerhouse.sessions && ${item}${extra}`, group: group[id] });
}
// the folder actions Steerhouse already had, in the same menu
menu.push(
  { command: 'steerhouse.openTerminalHere', when: 'view == steerhouse.sessions && viewItem =~ /^fs(file|folder)$/', group: 'navigation@4' },
  { command: 'steerhouse.newChatHere', when: 'view == steerhouse.sessions && viewItem == fsfolder', group: 'steerhouse@1' },
  { command: 'steerhouse.newChatInWorktree', when: 'view == steerhouse.sessions && viewItem == fsfolder', group: 'steerhouse@2' },
);
p.contributes.keybindings.push(
  { command: 'steerhouse.fs.rename', key: 'f2', when: 'focusedView == steerhouse.sessions && viewItem =~ /^fs(file|folder)$/' },
);
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
fs.writeFileSync('package.nls.json', JSON.stringify(en, null, 2) + '\n');
fs.writeFileSync('package.nls.pt-br.json', JSON.stringify(pt, null, 2) + '\n');
const b = JSON.parse(fs.readFileSync('l10n/bundle.l10n.pt-br.json', 'utf8'));
Object.assign(b, {
  'Enter a name': 'Digite um nome',
  'Use a name inside this folder': 'Use um nome dentro desta pasta',
  '{0} already exists here': '{0} já existe aqui',
  'New folder in {0}': 'Nova pasta em {0}',
  'New file in {0}': 'Novo arquivo em {0}',
  '$(diff) Selected {0} for compare': '$(diff) {0} selecionado para comparar',
  'Rename {0}': 'Renomear {0}',
  'Delete the folder {0} and everything in it?': 'Excluir a pasta {0} e tudo dentro dela?',
  'It moves to the trash (Recycle Bin), where you can restore it.': 'Vai para a lixeira, de onde você pode restaurar.',
});
fs.writeFileSync('l10n/bundle.l10n.pt-br.json', JSON.stringify(b, null, 2) + '\n');
console.log('ok');
