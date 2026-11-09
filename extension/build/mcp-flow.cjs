// One-off codemod: replace the "open .mcp.json" connectors command with a guided "Add MCP server".
const fs = require('fs');
const E = 'src/extension.ts';
let s = fs.readFileSync(E, 'utf8');
const start = s.indexOf("    vscode.commands.registerCommand('agentlens.manageConnectors'");
const end = s.indexOf('    }),\n', start) + '    }),\n'.length;
if (start < 0) throw new Error('manageConnectors not found');
const flow = String.raw`    // Connectors: add an MCP server (popular or your own) for the team, just you here, or everywhere
    vscode.commands.registerCommand('agentlens.manageConnectors', async (cwd?: string) => {
      const dir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!dir) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      type Pick = vscode.QuickPickItem & { preset?: McpPreset; custom?: 'stdio' | 'http'; edit?: boolean };
      const what = await vscode.window.showQuickPick<Pick>(
        [
          ...MCP_PRESETS.map((p): Pick => ({ label: p.label, description: p.transport === 'http' ? p.url : [p.command, ...(p.args ?? [])].join(' '), detail: vscode.l10n.t(p.detail), preset: p })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          { label: '$(terminal) ' + vscode.l10n.t('Your own: a command'), detail: vscode.l10n.t('e.g. npx -y some-mcp-server'), custom: 'stdio' },
          { label: '$(globe) ' + vscode.l10n.t('Your own: a URL'), detail: vscode.l10n.t('A remote MCP server (HTTP); sign-in happens when it is first used'), custom: 'http' },
          { label: '$(json) ' + vscode.l10n.t('Edit .mcp.json by hand'), edit: true },
        ],
        { title: vscode.l10n.t('Add an MCP server'), placeHolder: vscode.l10n.t('Pick a server to give the agent new tools') },
      );
      if (!what) return;
      if (what.edit) {
        const file = path.join(dir, '.mcp.json');
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
        return vscode.window.showTextDocument(vscode.Uri.file(file));
      }
      let server: McpServer;
      if (what.preset) server = { ...what.preset };
      else if (what.custom === 'http') {
        const url = await vscode.window.showInputBox({ title: vscode.l10n.t('Server URL'), placeHolder: 'https://example.com/mcp', validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : vscode.l10n.t('Enter an http(s) URL')) });
        if (!url) return;
        server = { name: '', transport: 'http', url: url.trim() };
      } else {
        const line = await vscode.window.showInputBox({ title: vscode.l10n.t('Command that starts the server'), placeHolder: 'npx -y some-mcp-server', validateInput: (v) => (v.trim() ? undefined : vscode.l10n.t('Enter a command')) });
        if (!line) return;
        server = { name: '', transport: 'stdio', ...splitCommand(line.trim()) };
      }
      const guess = server.name || (server.url ? new URL(server.url).hostname.split('.').filter((p) => !['www', 'mcp', 'api', 'com', 'dev', 'io', 'app'].includes(p))[0] : server.args?.find((a) => !a.startsWith('-'))?.replace(/^@[^/]+\//, '').replace(/[@].*$/, '').replace(/-?mcp-?/g, '')) || 'server';
      const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Name'), value: guess.replace(/[^A-Za-z0-9_-]/g, '-'), validateInput: (v) => (validName(v) ? undefined : vscode.l10n.t('Letters, digits, - and _ only')) });
      if (!name) return;
      server.name = name;
      const scopes: (vscode.QuickPickItem & { scope: McpScope })[] = [
        { label: vscode.l10n.t('The team (this project)'), description: '.mcp.json', detail: vscode.l10n.t('Saved in the project; commit it so everyone gets it'), scope: 'project' },
        { label: vscode.l10n.t('Just me, in this project'), detail: vscode.l10n.t('Only on your machine, only in {0}', path.basename(dir)), scope: 'local' },
        { label: vscode.l10n.t('Just me, in all my projects'), detail: vscode.l10n.t('Your Claude Code user settings'), scope: 'user' },
      ];
      const scope = await vscode.window.showQuickPick(scopes, { title: vscode.l10n.t('Who gets "{0}"?', name) });
      if (!scope) return;
      const exe = agentExecutable();
      if (!exe) return vscode.window.showErrorMessage(vscode.l10n.t('Claude Code was not found. Install it first.'));
      const account = preferredAccount();
      const r = await runClaude(exe, mcpAddArgs(server, scope.scope), dir, await envFor(account));
      if (!r.ok) return vscode.window.showErrorMessage(vscode.l10n.t('Could not add "{0}": {1}', name, r.out.slice(0, 300)));
      const live = await chats.addMcp(dir, name, sdkConfig(server));
      vscode.window.showInformationMessage(
        live ? vscode.l10n.t('"{0}" added and connected to {1} open chat(s).', name, live) : vscode.l10n.t('"{0}" added. New chats in this folder will use it.', name),
      );
    }),
`;
s = s.slice(0, start) + flow + s.slice(end);
s = s.replace("import { installedAgents, runCliAgent } from './agents';", "import { installedAgents, runCliAgent } from './agents';\nimport { MCP_PRESETS, mcpAddArgs, runClaude, sdkConfig, splitCommand, validName, type McpPreset, type McpScope, type McpServer } from './mcp';");
fs.writeFileSync(E, s);
console.log('ok');
