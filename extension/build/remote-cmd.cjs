// One-off codemod: "Steerhouse: Open on Phone" command (remote view server).
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 90));
  fs.writeFileSync(f, s.split(a).join(b));
};
const E = 'src/extension.ts';
R(
  E,
  `    // Delete sessions (several when selected together)`,
  `    // Your sessions on your phone: a small web page with a secret key in its link
    vscode.commands.registerCommand('steerhouse.remoteAccess', async () => {
      const remote = (remoteServer ??= new RemoteServer({ sessions: () => sessions, send: (id, text, mode) => send(id, text, mode) }));
      const link = async () => {
        const base = remote.host === '0.0.0.0' ? vscode.Uri.parse(\`http://\${lanAddress() ?? '127.0.0.1'}:\${remote.port}/\`) : await vscode.env.asExternalUri(vscode.Uri.parse(\`http://127.0.0.1:\${remote.port}/\`));
        return base.with({ query: \`k=\${remote.key}\` }).toString(true);
      };
      if (remote.running) {
        const copy = vscode.l10n.t('Copy Link');
        const openIt = vscode.l10n.t('Open');
        const stop = vscode.l10n.t('Stop');
        const a = await vscode.window.showInformationMessage(vscode.l10n.t('Steerhouse is serving your sessions on port {0}.', remote.port), copy, openIt, stop);
        if (a === copy) await vscode.env.clipboard.writeText(await link());
        if (a === openIt) await vscode.env.openExternal(vscode.Uri.parse(await link()));
        if (a === stop) {
          await remote.stop();
          remoteItem.hide();
        }
        return;
      }
      type P = vscode.QuickPickItem & { host: '127.0.0.1' | '0.0.0.0' };
      const how = await vscode.window.showQuickPick<P>(
        [
          {
            label: '$(lock) ' + vscode.l10n.t('Private: this computer, or anywhere via port forwarding'),
            detail: vscode.l10n.t('Only this machine can open it. For your phone, forward the port in the Ports panel (private ports ask for a GitHub sign-in).'),
            host: '127.0.0.1',
          },
          {
            label: '$(broadcast) ' + vscode.l10n.t('Phones on the same Wi-Fi'),
            detail: vscode.l10n.t('Anyone on this network who has the link can read and steer your sessions. Use only on networks you trust.'),
            host: '0.0.0.0',
          },
        ],
        { title: vscode.l10n.t('Open your sessions on a phone or another browser') },
      );
      if (!how) return;
      const port = await remote.start(how.host);
      remoteItem.text = '$(device-mobile) ' + port;
      remoteItem.tooltip = vscode.l10n.t('Steerhouse is serving your sessions (click for the link or to stop)');
      remoteItem.show();
      const url = await link();
      await vscode.env.clipboard.writeText(url);
      const openIt = vscode.l10n.t('Open');
      const a = await vscode.window.showInformationMessage(vscode.l10n.t('Link copied. Open it on your phone: it holds a secret key, so share it only with yourself.'), openIt);
      if (a === openIt) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    // Delete sessions (several when selected together)`,
);
R(
  E,
  `  const marks = () => ({`,
  `  let remoteServer: RemoteServer | undefined;
  const remoteItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  remoteItem.command = 'steerhouse.remoteAccess';
  ctx.subscriptions.push(remoteItem, { dispose: () => void remoteServer?.stop() });
  const marks = () => ({`,
);
R(E, `import { addWorktree, removeWorktree, repoRoot, slug, validBranch, worktreeInfo } from './worktree';`, `import { addWorktree, removeWorktree, repoRoot, slug, validBranch, worktreeInfo } from './worktree';\nimport { lanAddress, RemoteServer } from './remote';`);
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.contributes.commands.push({ command: 'steerhouse.remoteAccess', title: '%cmd.remote.access%', category: 'Steerhouse', icon: '$(device-mobile)' });
const title = p.contributes.menus['view/title'] ?? (p.contributes.menus['view/title'] = []);
title.push({ command: 'steerhouse.remoteAccess', when: 'view == steerhouse.sessions', group: 'navigation@9' });
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
const add = (f, o) => {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  Object.assign(j, o);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
};
add('package.nls.json', { 'cmd.remote.access': 'Open on Phone…' });
add('package.nls.pt-br.json', { 'cmd.remote.access': 'Abrir no celular…' });
add('l10n/bundle.l10n.pt-br.json', {
  'Copy Link': 'Copiar link',
  Stop: 'Parar',
  'Steerhouse is serving your sessions on port {0}.': 'O Steerhouse está servindo suas sessões na porta {0}.',
  'Private: this computer, or anywhere via port forwarding': 'Privado: este computador, ou qualquer lugar via encaminhamento de porta',
  'Only this machine can open it. For your phone, forward the port in the Ports panel (private ports ask for a GitHub sign-in).': 'Só esta máquina abre. Para o celular, encaminhe a porta no painel Portas (portas privadas pedem login no GitHub).',
  'Phones on the same Wi-Fi': 'Celulares no mesmo Wi-Fi',
  'Anyone on this network who has the link can read and steer your sessions. Use only on networks you trust.': 'Qualquer pessoa nesta rede com o link pode ler e direcionar suas sessões. Use só em redes confiáveis.',
  'Open your sessions on a phone or another browser': 'Abrir suas sessões em um celular ou outro navegador',
  'Steerhouse is serving your sessions (click for the link or to stop)': 'O Steerhouse está servindo suas sessões (clique para o link ou para parar)',
  'Link copied. Open it on your phone: it holds a secret key, so share it only with yourself.': 'Link copiado. Abra no celular: ele contém uma chave secreta, então não compartilhe.',
});
console.log('ok');
