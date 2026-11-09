// One-off codemod: connectors (MCP servers) in the chat, + menu, image lightbox, no empty blocks.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 90));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};

// ---- engine
const E = 'src/chat.ts';
R(E, '  slashCommands: string[];\n  costUsd: number;', "  slashCommands: string[];\n  /** connectors (MCP servers) available in this session */\n  mcp: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; tools: number; error?: string }[];\n  costUsd: number;");
R(E, '      slashCommands: [],\n', '      slashCommands: [],\n      mcp: [],\n');
R(E, "          if (this.state.status === 'starting') this.state.status = 'idle';", "          if (this.state.status === 'starting') this.state.status = 'idle';\n          this.refreshMcp();");
R(
  E,
  '  /** Effort, fast mode and ultracode,',
  `  /** Connectors: refresh their status, turn one on or off, or reconnect a failed one. */
  async refreshMcp() {
    try {
      const list: any[] = (await this.q?.mcpServerStatus()) ?? [];
      this.state.mcp = list.map((s) => ({ name: s.name, status: s.status, tools: s.tools?.length ?? 0, error: s.error }));
      this.changed();
    } catch {
      /* older CLI */
    }
  }
  async toggleMcp(name: string, enabled: boolean) {
    await this.q?.toggleMcpServer(name, enabled);
    await this.refreshMcp();
  }
  async reconnectMcp(name: string) {
    await this.q?.reconnectMcpServer(name);
    await this.refreshMcp();
  }

  /** Effort, fast mode and ultracode,`,
);
R('webview/src/types.ts', 'slashCommands: string[]; costUsd: number;', "slashCommands: string[]; mcp: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; tools: number; error?: string }[]; costUsd: number;");

// ---- panel messages
const P = 'src/chatPanel.ts';
R(P, "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'toggleMcp'; name: string; enabled: boolean }\n  | { type: 'reconnectMcp'; name: string }\n  | { type: 'manageConnectors' }");
R(
  P,
  "      case 'interrupt':",
  `      case 'toggleMcp':
        return c.toggleMcp(m.name, m.enabled).catch((e) => vscode.window.showWarningMessage(\`Steerhouse: \${m.name}: \${e?.message ?? e}\`));
      case 'reconnectMcp':
        return c.reconnectMcp(m.name).catch((e) => vscode.window.showWarningMessage(\`Steerhouse: \${m.name}: \${e?.message ?? e}\`));
      case 'manageConnectors':
        return vscode.commands.executeCommand('steerhouse.manageConnectors', c.state.cwd);
      case 'interrupt':`,
);
R('webview/src/types.ts', "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'toggleMcp'; name: string; enabled: boolean }\n  | { type: 'reconnectMcp'; name: string }\n  | { type: 'manageConnectors' }");

// ---- extension: open (or create) the project's .mcp.json
const X = 'src/extension.ts';
R(
  X,
  "    vscode.commands.registerCommand('steerhouse.addProvider', async () => {",
  `    vscode.commands.registerCommand('steerhouse.manageConnectors', async (cwd?: string) => {
      const dir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!dir) return;
      const file = path.join(dir, '.mcp.json');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\\n');
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      vscode.window.showInformationMessage(vscode.l10n.t('Add MCP servers under "mcpServers" (shared with the team). Personal ones: run "claude mcp add" in a terminal. Start a new chat to load changes.'));
    }),
    vscode.commands.registerCommand('steerhouse.addProvider', async () => {`,
);
const b = JSON.parse(fs.readFileSync('l10n/bundle.l10n.pt-br.json', 'utf8'));
b['Add MCP servers under "mcpServers" (shared with the team). Personal ones: run "claude mcp add" in a terminal. Start a new chat to load changes.'] =
  'Adicione servidores MCP em "mcpServers" (compartilhado com o time). Pessoais: rode "claude mcp add" em um terminal. Abra um novo chat para carregar as mudanças.';
fs.writeFileSync('l10n/bundle.l10n.pt-br.json', JSON.stringify(b, null, 2) + '\n');

// ---- composer: + menu (files, slash commands, connectors) replaces the image button
const CP = 'webview/src/views/Composer.tsx';
R(
  CP,
  `        <label className="text-muted-foreground hover:text-foreground hover:bg-accent grid size-7 cursor-pointer place-items-center rounded-md" title={t('Add images (or paste / drop them)')}>
          <ImagePlus className="size-4" />
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles([...(e.target.files ?? [])])} />
        </label>`,
  `        <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles([...(e.target.files ?? [])])} />
        <PlusMenu chat={chat} onFiles={() => fileInput.current?.click()} onSlash={(c) => pickSlash(c)} />`,
);
R(CP, '  const input = useRef<RichInputHandle>(null);', '  const input = useRef<RichInputHandle>(null);\n  const fileInput = useRef<HTMLInputElement>(null);');
R(
  CP,
  'export function Composer({ chat }: { chat: ChatState }) {',
  `function PlusMenu({ chat, onFiles, onSlash }: { chat: ChatState; onFiles: () => void; onSlash: (c: string) => void }) {
  const dot = (s: string) => (s === 'connected' ? 'bg-recent' : s === 'failed' || s === 'needs-auth' ? 'bg-removed' : s === 'pending' ? 'bg-warn' : 'bg-muted-foreground/40');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent grid size-7 cursor-pointer place-items-center rounded-md" aria-label={t('Add')} title={t('Add files, commands, connectors')}>
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem onSelect={onFiles}>
          <Paperclip /> {t('Add images')}
        </DropdownMenuItem>
        {chat.slashCommands.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquareSlash /> {t('Slash commands')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              {chat.slashCommands.map((c) => (
                <DropdownMenuItem key={c} onSelect={() => onSlash(c)} className="font-mono">
                  /{c}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Blocks /> {t('Connectors')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <DropdownMenuItem onSelect={() => post({ type: 'manageConnectors' })}>
              <Settings2 /> {t('Manage connectors')}
            </DropdownMenuItem>
            {chat.mcp.length > 0 && <DropdownMenuSeparator />}
            {chat.mcp.length === 0 && <DropdownMenuLabel>{t('No connectors in this session yet')}</DropdownMenuLabel>}
            {chat.mcp.map((s) => (
              <DropdownMenuItem
                key={s.name}
                onSelect={(e) => {
                  e.preventDefault();
                  if (s.status === 'failed' || s.status === 'needs-auth') post({ type: 'reconnectMcp', name: s.name });
                  else post({ type: 'toggleMcp', name: s.name, enabled: s.status === 'disabled' });
                }}
                title={s.error ?? \`\${s.status} · \${s.tools} tools\`}
              >
                <span className={cn('size-2 shrink-0 rounded-full', dot(s.status))} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.status === 'failed' || s.status === 'needs-auth' ? (
                  <span className="text-removed text-[11px]">{t('Reconnect')}</span>
                ) : (
                  <Switch on={s.status !== 'disabled'} />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({ chat }: { chat: ChatState }) {`,
);
R(CP, "import { Bot, ImagePlus, ListOrdered, Navigation, Send, ShieldCheck, Sparkles, Square, Zap, Gauge, X } from 'lucide-react';", "import { Blocks, Bot, ListOrdered, Navigation, Paperclip, Plus, Send, Settings2, ShieldCheck, Sparkles, Square, SquareSlash, Zap, Gauge, X } from 'lucide-react';\nimport { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, Switch } from '@/components/ui/dropdown-menu';\nimport { Zoomable } from '@/components/Lightbox';");
R(CP, '              <img src={img.data} alt="" className="h-14 rounded-md border object-cover" />', '              <Zoomable src={img.data} className="h-14 rounded-md border object-cover" />');

// ---- chat: lightbox + clickable images; never render an empty answer block
const C = 'webview/src/views/Chat.tsx';
R(C, '                <img key={i} src={src} alt="" className="h-20 rounded-md border object-cover" />', '                <Zoomable key={i} src={src} className="h-20 rounded-md border object-cover" />');
R(C, "import { Composer, PRIORITY } from './Composer';", "import { Composer, PRIORITY } from './Composer';\nimport { LightboxProvider, Zoomable } from '@/components/Lightbox';");
R(C, "    case 'assistant':\n      return (", "    case 'assistant':\n      if (!it.text.trim() && !it.streaming) return null;\n      return (");
R(C, '    <div className="flex h-screen flex-col">', '    <LightboxProvider>\n    <div className="flex h-screen flex-col">');
{
  const s = fs.readFileSync(C, 'utf8');
  const i = s.lastIndexOf('    </div>\n  );\n}');
  if (i < 0) {
    console.error('MISSING ChatView end');
    process.exit(1);
  }
  fs.writeFileSync(C, s.slice(0, i) + '    </div>\n    </LightboxProvider>\n  );\n}' + s.slice(i + '    </div>\n  );\n}'.length));
}

// ---- translations
const I = 'webview/src/i18n.ts';
R(
  I,
  "  'Jump to latest': 'Ir para o fim',",
  "  'Jump to latest': 'Ir para o fim',\n  Add: 'Adicionar',\n  'Add files, commands, connectors': 'Adicionar arquivos, comandos, conectores',\n  'Add images': 'Adicionar imagens',\n  'Slash commands': 'Comandos de barra',\n  Connectors: 'Conectores',\n  'Manage connectors': 'Gerenciar conectores',\n  'No connectors in this session yet': 'Nenhum conector nesta sessão ainda',\n  Reconnect: 'Reconectar',",
);
console.log('ok');
