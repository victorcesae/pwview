// One-off codemod: wire multi-account support into chat, terminals, tree and UI.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};

// ---- chat engine
R('src/chat.ts', '  costUsd: number;\n', "  costUsd: number;\n  /** Which Claude account this session runs on (name from Steerhouse, details from Claude Code). */\n  account: { name: string; email?: string; organization?: string; plan?: string; provider?: string };\n");
R('src/chat.ts', '  history?: { items: ChatItem[]; todos: Todo[] };', '  history?: { items: ChatItem[]; todos: Todo[] };\n  /** Account: its name and env (CLAUDE_CONFIG_DIR) */\n  account?: { name: string; env: Record<string, string> };');
R('src/chat.ts', '      costUsd: 0,', "      costUsd: 0,\n      account: { name: opts.account?.name ?? 'Default' },");
R('src/chat.ts', "        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'steerhouse' },", "        env: { ...process.env, ...(this.opts.account?.env ?? {}), CLAUDE_AGENT_SDK_CLIENT_APP: 'steerhouse' },");
R(
  'src/chat.ts',
  "      .catch(() => {});\n    this.state.status = 'idle';\n    this.changed();\n  }",
  "      .catch(() => {});\n    this.q\n      .accountInfo()\n      .then((a: any) => {\n        this.state.account = { ...this.state.account, email: a.email, organization: a.organization, plan: a.subscriptionType, provider: a.apiProvider };\n        this.changed();\n      })\n      .catch(() => {});\n    this.state.status = 'idle';\n    this.changed();\n  }",
);

// ---- terminals run as an account too
R('src/util.ts', 'export function runAgent(name: string, cwd: string, args: string[]) {', 'export function runAgent(name: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}) {');
R('src/util.ts', '    env: { STEERHOUSE_TERMINAL: token },', '    env: { ...extraEnv, STEERHOUSE_TERMINAL: token },');

// ---- chat panel
R('src/chatPanel.ts', '  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string }) {', '  start(opts: { cwd: string; resume?: string; title?: string; prompt?: string; account?: Account }) {');
R('src/chatPanel.ts', 'executable: exe, history },', 'executable: exe, history, account: opts.account && { name: opts.account.name, env: accountEnv(opts.account) } },');
R('src/chatPanel.ts', "import { agentExecutable } from './util';", "import { agentExecutable } from './util';\nimport { accountEnv, type Account } from './accounts';");

// ---- extension
const E = 'src/extension.ts';
R(
  E,
  '  const engine = new Engine();',
  `  const engine = new Engine(() => listAccounts().map((a) => ({ account: a.id, dir: path.join(a.configDir, 'projects') })));
  const accountOf = (id: string) => listAccounts().find((a) => a.id === id) ?? listAccounts()[0];
  async function pickAccount(): Promise<Account | undefined> {
    const all = listAccounts();
    if (all.length === 1) return all[0];
    const pref = preferredAccount();
    const pick = await vscode.window.showQuickPick(
      [...all].sort((a, b) => Number(b.id === pref.id) - Number(a.id === pref.id)).map((a) => ({ label: a.name, description: a.id === pref.id ? vscode.l10n.t('default') : a.configDir, a })),
      { placeHolder: vscode.l10n.t('Which Claude account should this session use?') },
    );
    if (pick) setPreferred(pick.a.id);
    return pick?.a;
  }`,
);
R(E, "import { addLink, briefing } from './links';", "import { addLink, briefing } from './links';\nimport { addAccount, listAccounts, preferredAccount, removeAccount, setPreferred, accountEnv, type Account } from './accounts';");
R(
  E,
  "    if (surface() === 'terminal') runAgent(`✦ ${clip(prompt || 'agent', 30)}`, cwd, prompt ? [prompt] : []);\n    else chats.start({ cwd, prompt: prompt || undefined });",
  "    const account = await pickAccount();\n    if (!account) return;\n    if (surface() === 'terminal') runAgent(`✦ ${clip(prompt || 'agent', 30)}`, cwd, prompt ? [prompt] : [], accountEnv(account));\n    else chats.start({ cwd, prompt: prompt || undefined, account });",
);
R(
  E,
  "      if (surface() === 'terminal') runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id]);\n      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title });",
  "      const account = accountOf(s.info.account);\n      if (surface() === 'terminal') runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], accountEnv(account));\n      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account });",
);
R(E, "      if (s) runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id]);", "      if (s) runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], accountEnv(accountOf(s.info.account)));");
R(E, '      chats.start({ cwd });', '      pickAccount().then((account) => account && chats.start({ cwd, account }));');
R(E, '        const added = installHooks();', "        // every account has its own settings.json\n        const added = listAccounts().reduce((n, a) => n + installHooks(path.join(a.configDir, 'settings.json')), 0);");
R(
  E,
  "    vscode.commands.registerCommand('steerhouse.linkSession',",
  `    vscode.commands.registerCommand('steerhouse.addAccount', async () => {
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name for the new Claude account'), placeHolder: vscode.l10n.t('Work, Personal, Client X…') });
      if (!name?.trim()) return;
      const a = addAccount(name);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      runAgent(\`Claude login · \${a.name}\`, cwd, [], accountEnv(a));
      vscode.window.showInformationMessage(vscode.l10n.t('Account "{0}" created. In its terminal type /login and sign in with that account.', a.name));
      refresh(true);
    }),
    vscode.commands.registerCommand('steerhouse.accounts', async () => {
      const pref = preferredAccount();
      const pick = await vscode.window.showQuickPick(
        [
          ...listAccounts().map((a) => ({ label: (a.id === pref.id ? '$(check) ' : '') + a.name, description: a.configDir, a: a as Account | undefined })),
          { label: '$(add) ' + vscode.l10n.t('Add account…'), description: '', a: undefined as Account | undefined },
        ],
        { placeHolder: vscode.l10n.t('Default Claude account for new sessions') },
      );
      if (!pick) return;
      if (!pick.a) return vscode.commands.executeCommand('steerhouse.addAccount');
      const acc = pick.a;
      if (acc.id !== 'default') {
        const USE = vscode.l10n.t('Use by default');
        const LOGIN = vscode.l10n.t('Log in again');
        const REMOVE = vscode.l10n.t('Remove from Steerhouse');
        const act = await vscode.window.showQuickPick([USE, LOGIN, REMOVE], { placeHolder: acc.name });
        if (act === LOGIN) return runAgent(\`Claude login · \${acc.name}\`, require('os').homedir(), [], accountEnv(acc));
        if (act === REMOVE) {
          removeAccount(acc.id);
          return refresh(true);
        }
        if (!act) return;
      }
      setPreferred(acc.id);
    }),
    vscode.commands.registerCommand('steerhouse.linkSession',`,
);

// ---- tree: show the account when there is more than one
R('src/tree.ts', '        const bits = [', "        const bits = [listAccounts().length > 1 ? `👤 ${listAccounts().find((a) => a.id === i.account)?.name ?? i.account}` : '', ");
R('src/tree.ts', "import { norm } from './paths';", "import { norm } from './paths';\nimport { listAccounts } from './accounts';");

// ---- webview: header chip
R('webview/src/types.ts', 'slashCommands: string[]; costUsd: number;', 'slashCommands: string[]; costUsd: number; account: { name: string; email?: string; organization?: string; plan?: string; provider?: string };');
R(
  'webview/src/views/Chat.tsx',
  '        {chat.costUsd > 0 &&',
  `        <span
          className="text-muted-foreground inline-flex max-w-64 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px]"
          title={[chat.account.email, chat.account.organization, chat.account.plan, chat.account.provider].filter(Boolean).join(' · ')}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{chat.account.email ?? chat.account.name}</span>
          {chat.account.plan && <span className="opacity-70">· {chat.account.plan}</span>}
        </span>
        {chat.costUsd > 0 &&`,
);
R('webview/src/views/Chat.tsx', 'import { Ban, Bot, RotateCcw,', 'import { Ban, Bot, RotateCcw, UserRound,');
R('webview/src/mock.ts', 'costUsd: 0.42,', "costUsd: 0.42, account: { name: 'Work', email: 'victor@example.com', plan: 'max', organization: 'NZero Labs' },");

// ---- manifest commands (+ strings for both languages)
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const c = p.contributes;
c.commands.push({ command: 'steerhouse.addAccount', title: 'Add Claude Account…', category: 'Steerhouse', icon: '$(person-add)' }, { command: 'steerhouse.accounts', title: 'Claude Accounts…', category: 'Steerhouse', icon: '$(account)' });
c.menus['view/title'].push({ command: 'steerhouse.accounts', when: 'view == steerhouse.sessions', group: '1_more@1' });
p.version = '0.4.0';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
console.log('wired');
