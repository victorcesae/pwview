// One-off codemod: provider keys from SecretStorage, Add model provider command, host + vendor in chats.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
const E = 'src/extension.ts';

// one scan per Claude folder (model providers share the default folder)
R(
  E,
  "  const engine = new Engine(() => listAccounts().map((a) => ({ account: a.id, dir: path.join(a.configDir, 'projects') })));",
  "  const engine = new Engine(() => {\n    const seen = new Set<string>();\n    return listAccounts()\n      .filter((a) => !a.provider && !seen.has(a.configDir) && !!seen.add(a.configDir))\n      .map((a) => ({ account: a.id, dir: path.join(a.configDir, 'projects') }));\n  });\n  /** Env for an account, with a provider's API key read from VS Code's secure storage. */\n  const envFor = async (a: Account) => accountEnv(a, a.provider?.hasKey ? await ctx.secrets.get(secretKey(a.provider.id)) : undefined);",
);
R(E, "import { addAccount, listAccounts,", "import { addProvider, PRESETS, listModels, secretKey } from './providers';\nimport { addAccount, listAccounts,");
// env through envFor everywhere
R(E, "cwd, prompt ? [prompt] : [], accountEnv(account));\n    else chats.start({ cwd, prompt: prompt || undefined, account });", "cwd, prompt ? [prompt] : [], await envFor(account));\n    else chats.start({ cwd, prompt: prompt || undefined, account, env: await envFor(account) });");
R(E, "['--resume', s.info.id], accountEnv(account));\n      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account });", "['--resume', s.info.id], await envFor(account));\n      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account, env: await envFor(account) });");
R(E, "['--resume', s.info.id], accountEnv(accountOf(s.info.account)));", "['--resume', s.info.id], await envFor(accountOf(s.info.account)));");
R(E, "      pickAccount().then((account) => account && chats.start({ cwd, account }));", "      pickAccount().then(async (account) => account && chats.start({ cwd, account, env: await envFor(account) }));");
// the resume / resumeInTerminal handlers become async
R(E, "vscode.commands.registerCommand('steerhouse.resumeSession', (x: unknown) => {", "vscode.commands.registerCommand('steerhouse.resumeSession', async (x: unknown) => {");
R(E, "vscode.commands.registerCommand('steerhouse.resumeInTerminal', (x: unknown) => {", "vscode.commands.registerCommand('steerhouse.resumeInTerminal', async (x: unknown) => {");

// Add model provider
R(
  E,
  "    vscode.commands.registerCommand('steerhouse.addAccount', async () => {",
  `    vscode.commands.registerCommand('steerhouse.addProvider', async () => {
      const preset = (await vscode.window.showQuickPick(PRESETS.map((p) => ({ label: p.label, detail: p.detail, p })), { placeHolder: vscode.l10n.t('Which models do you want to use?') }))?.p;
      if (!preset) return;
      const baseUrl = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Endpoint (Anthropic-compatible)'), value: preset.baseUrl, placeHolder: 'https://…', ignoreFocusOut: true });
      if (!baseUrl) return;
      let key: string | undefined;
      if (preset.needsKey) {
        key = await vscode.window.showInputBox({ prompt: vscode.l10n.t('API key for {0} (stored in VS Code secure storage)', preset.label), password: true, ignoreFocusOut: true });
        if (key === undefined) return;
      }
      let models: string[] = [];
      try {
        models = await listModels(preset, baseUrl, key);
      } catch (e) {
        vscode.window.showWarningMessage(vscode.l10n.t('Could not list models from {0}: {1}. Type the model name instead.', baseUrl, String((e as Error).message ?? e)));
      }
      const model = models.length
        ? (await vscode.window.showQuickPick(models, { placeHolder: vscode.l10n.t('Model to use') }))
        : await vscode.window.showInputBox({ prompt: vscode.l10n.t('Model name'), placeHolder: preset.id === 'openrouter' ? 'openai/gpt-5, meta-llama/llama-4-maverick, qwen/qwen3-coder…' : 'llama3.3, qwen3-coder…', ignoreFocusOut: true });
      if (!model) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name for this provider'), value: \`\${preset.label.replace(/ \\(.*\\)$/, '')} · \${model}\` });
      if (!name) return;
      const acc = addProvider({ name, preset: preset.id, baseUrl, model, hasKey: !!key });
      if (key) await ctx.secrets.store(secretKey(acc.provider!.id), key);
      const start = vscode.l10n.t('Start a chat with it');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('Provider "{0}" added.', name), start)) === start) {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (cwd) chats.start({ cwd, account: acc, env: await envFor(acc) });
      }
    }),
    vscode.commands.registerCommand('steerhouse.addAccount', async () => {`,
);
// accounts menu offers providers too
R(E, "          { label: '$(add) ' + vscode.l10n.t('Add account…'), description: '', a: undefined as Account | undefined },", "          { label: '$(add) ' + vscode.l10n.t('Add account…'), description: '', a: undefined as Account | undefined },\n          { label: '$(server-process) ' + vscode.l10n.t('Add model provider (Ollama, OpenRouter, LiteLLM…)'), description: '', a: { id: '__provider' } as Account },");
R(E, "      if (!pick.a) return vscode.commands.executeCommand('steerhouse.addAccount');", "      if (!pick.a) return vscode.commands.executeCommand('steerhouse.addAccount');\n      if (pick.a.id === '__provider') return vscode.commands.executeCommand('steerhouse.addProvider');");
R(E, "        if (act === LOGIN) return runAgent(`Claude login · ${acc.name}`, require('os').homedir(), [], accountEnv(acc));", "        if (act === LOGIN) return runAgent(`Claude login · ${acc.name}`, require('os').homedir(), [], await envFor(acc));");

// chat panel: env passed in; host app name for the "Cursor + Claude" badge
const P = 'src/chatPanel.ts';
R(P, '  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string; account?: Account }) {', '  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string; account?: Account; env?: Record<string, string> }) {');
R(P, 'account: opts.account && { name: opts.account.name, env: accountEnv(opts.account) } }', "account: opts.account && { name: opts.account.name, env: opts.env ?? accountEnv(opts.account), provider: opts.account.provider?.preset }, host: vscode.env.appName, model: opts.account?.provider?.model }");

// chat engine carries host + provider for the header
const C = 'src/chat.ts';
R(C, '  account?: { name: string; env: Record<string, string> };', '  account?: { name: string; env: Record<string, string>; provider?: string };\n  /** editor the chat runs in (Visual Studio Code, Cursor…) */\n  host?: string;');
R(C, '  account: { name: string; email?: string; organization?: string; plan?: string; provider?: string };', '  account: { name: string; email?: string; organization?: string; plan?: string; provider?: string; gateway?: string };\n  host?: string;');
R(C, "      account: { name: opts.account?.name ?? 'Default' },", "      account: { name: opts.account?.name ?? 'Default', gateway: opts.account?.provider },\n      host: opts.host,");
R('webview/src/types.ts', 'account: { name: string; email?: string; organization?: string; plan?: string; provider?: string };', 'account: { name: string; email?: string; organization?: string; plan?: string; provider?: string; gateway?: string }; host?: string;');

// manifest + translations for the new command
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.contributes.commands.push({ command: 'steerhouse.addProvider', title: 'Add Model Provider (Ollama, OpenRouter, LiteLLM…)…', category: 'Steerhouse', icon: '$(server-process)' });
pkg.contributes.menus['view/title'].push({ command: 'steerhouse.addProvider', when: 'view == steerhouse.sessions', group: '1_more@2' });
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('ok');
