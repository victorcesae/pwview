import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { editRules, openRules } from './rules';
import { modelLabel } from './pricing';
import { installedAgents, runCliAgent } from './agents';
import { addWorktree, removeWorktree, repoRoot, slug, validBranch, worktreeInfo } from './worktree';
import { lanAddress, RemoteServer } from './remote';
import { migrateFromAgentLens } from './migrate';
import { registerFileActions } from './fileActions';
import { followCommand } from './bgtasks';
import { claudeDir } from './paths';
import { MCP_PRESETS, mcpAddArgs, runClaude, sdkConfig, splitCommand, validName, type McpPreset, type McpScope, type McpServer } from './mcp';
import { addComment, cancelComment, editComment, loadComments, Mode } from './comments';
import { changeDetail, Engine, Session } from './engine';
import { hooksStatus, installHooks, installHookScript } from './hooks';
import { EXT, registerImagePaste, saveImage } from './imagePaste';
import { registerLibrary } from './library';
import { Dashboard, FromWebview } from './panel';
import { norm } from './paths';
import { registerSkills } from './skills';
import { registerDoctor, syncSetupContext } from './doctor';
import { attachedSessions, resolveTerminals, terminalFor, typeInto } from './terminals';
import { Chats } from './chatPanel';
import { usageReport } from './usage';
import { addLink, briefing, sameConnection } from './links';
import { PRESETS, listModels, secretKey, vendorOf } from './providers';
import { addAccount, addProvider, listAccounts, preferredAccount, removeAccount, setPreferred, accountEnv, type Account } from './accounts';
import { Node, SessionsTree, setMediaRoot } from './tree';
import { agentExecutable, ago, clip, runAgent } from './util';

const SCHEME = 'steerhouse';

/** Sessions that ran inside the system temp folder (scratch runs, tests) are hidden by default. */
const tempRoots = (() => {
  const os = require('os') as typeof import('os');
  const roots = [os.tmpdir()];
  try {
    roots.push(fs.realpathSync.native(os.tmpdir()));
  } catch {
    /* ignore */
  }
  return [...new Set(roots.map((r) => norm(r)))];
})();
const isTempProject = (p: string) => tempRoots.some((r) => norm(p) === r || norm(p).startsWith(r + '/'));

/**
 * Test-only (env vars, used by test/editor/restore.cjs): open a chat then close the window
 * normally, or report which chat tabs came back after a relaunch.
 */
function restoreTestHooks(chats: { describe(): unknown; testSend(text: string): void }) {
  const open = process.env.STEERHOUSE_TEST_OPEN_CHAT;
  const report = process.env.STEERHOUSE_TEST_REPORT;
  if (open)
    setTimeout(async () => {
      // "resume:<session id>" resumes that session in a chat; otherwise a new chat in that folder
      // "legacy:<folder>": a tab saved by AgentLens (the old name), as it is left after the rename
      if (open.startsWith('legacy:')) {
        const p = vscode.window.createWebviewPanel('agentlens.chat', 'Old AgentLens chat', vscode.ViewColumn.Active, { enableScripts: true });
        p.webview.html = `<script>acquireVsCodeApi().setState(${JSON.stringify({ cwd: open.slice(7), title: 'Old AgentLens chat' })});</script>old`;
        setTimeout(() => vscode.commands.executeCommand('workbench.action.closeWindow'), 4000);
        return;
      }
      if (open.startsWith('resume:')) await vscode.commands.executeCommand('steerhouse.resumeSession', open.slice(7));
      else await vscode.commands.executeCommand('steerhouse.newChatHere', { kind: 'project', path: open });
      // optionally leave the chat busy (mid-turn) when the window closes
      const prompt = process.env.STEERHOUSE_TEST_PROMPT;
      if (prompt) setTimeout(() => chats.testSend(prompt), 1500);
      setTimeout(() => vscode.commands.executeCommand('workbench.action.closeWindow'), Number(process.env.STEERHOUSE_TEST_CLOSE_MS ?? 4000));
    }, 2000);
  if (report)
    setTimeout(() => {
      require('fs').writeFileSync(report, JSON.stringify({ tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => ({ label: t.label, viewType: (t.input as any)?.viewType })), chats: chats.describe() }));
      vscode.commands.executeCommand('workbench.action.closeWindow');
    }, Number(process.env.STEERHOUSE_TEST_REPORT_MS ?? 8000));
}

export function activate(ctx: vscode.ExtensionContext) {
  // Steerhouse used to be AgentLens: carry over its data folder, hook entries and settings (once)
  const migrated = migrateFromAgentLens({
    claudeDir: claudeDir(),
    settingKeys: Object.keys((ctx.extension.packageJSON as any).contributes?.configuration?.properties ?? {}).map((k) => k.replace(/^steerhouse\./, '')),
    accountSettings: [...new Set(listAccounts().map((a) => path.join(a.configDir, 'settings.json')))],
  }).then((done) => done.length && vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Steerhouse: carried over from AgentLens: {0}', done.join(', ')), 8000), () => undefined);
  void migrated;
  const engine = new Engine(() => {
    const seen = new Set<string>();
    return listAccounts()
      .filter((a) => !a.provider && !seen.has(a.configDir) && !!seen.add(a.configDir))
      .map((a) => ({ account: a.id, dir: path.join(a.configDir, 'projects') }));
  });
  /** Env for an account, with a provider's API key read from VS Code's secure storage. */
  const envFor = async (a: Account) => accountEnv(a, a.provider?.hasKey ? await ctx.secrets.get(secretKey(a.provider.id)) : undefined);
  const accountOf = (id: string) => listAccounts().find((a) => a.id === id) ?? listAccounts()[0];

  /**
   * New chat: which agent and account. Claude accounts and model providers run in the Steerhouse
   * chat; other agents installed here (Cursor Agent, Codex…) open in a terminal. Asked whenever
   * there is more than one choice; the last one used comes first.
   */
  async function pickAgent(cwd: string): Promise<Account | undefined> {
    const all = listAccounts();
    const clis = installedAgents();
    if (all.length === 1 && !clis.length) return all[0];
    const last = ctx.globalState.get<string>('steerhouse.lastAgent') ?? preferredAccount().id;
    type Item = vscode.QuickPickItem & { a?: Account; cli?: (typeof clis)[number]; add?: string };
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'vendors');
    const items: Item[] = [
      ...all.map((a): Item => ({
        label: a.provider ? `${a.name}` : `Claude · ${a.name}`,
        description: a.provider ? `${a.provider.model ?? ''} · ${a.provider.baseUrl}` : vscode.l10n.t('Steerhouse chat'),
        iconPath: vscode.Uri.joinPath(media, `${a.provider ? vendorOf(a.provider.model) : 'anthropic'}.svg`),
        a,
      })),
      ...clis.map((c): Item => ({ label: c.name, description: vscode.l10n.t('opens in a terminal'), detail: c.exe, iconPath: vscode.Uri.joinPath(media, `${c.vendor}.svg`), cli: c })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) ' + vscode.l10n.t('Add a Claude account…'), add: 'steerhouse.addAccount' },
      { label: '$(server) ' + vscode.l10n.t('Add a model provider (Ollama, OpenRouter…)…'), add: 'steerhouse.addProvider' },
    ];
    const key = (i: Item) => i.a?.id ?? (i.cli ? 'cli:' + i.cli.id : '');
    items.sort((x, y) => Number(key(y) === last) - Number(key(x) === last));
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('New chat in {0}', path.basename(cwd)), placeHolder: vscode.l10n.t('Which agent should work here?') });
    if (!pick) return undefined;
    if (pick.add) {
      await vscode.commands.executeCommand(pick.add);
      return undefined;
    }
    ctx.globalState.update('steerhouse.lastAgent', key(pick));
    if (pick.cli) {
      runCliAgent(pick.cli, cwd, vscode.Uri.joinPath(ctx.extensionUri, 'media'));
      return undefined;
    }
    setPreferred(pick.a!.id);
    return pick.a;
  }
  const cfg = () => vscode.workspace.getConfiguration('steerhouse');
  let sessions: Session[] = [];
  let hooks = hooksStatus();
  const hooksOk = () => hooks === 'all';
  const find = (id: string) => sessions.find((s) => s.info.id === id);

  try {
    installHookScript(path.join(ctx.extensionPath, 'dist', 'hook.js'));
  } catch (e) {
    console.error('Steerhouse: could not copy hook script', e);
  }

  // ------------------------------------------------------------ views
  setMediaRoot(vscode.Uri.joinPath(ctx.extensionUri, 'media'));
  let remoteServer: RemoteServer | undefined;
  const remoteItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  remoteItem.command = 'steerhouse.remoteAccess';
  ctx.subscriptions.push(remoteItem, { dispose: () => void remoteServer?.stop() });
  const marks = () => ({ pinned: ctx.globalState.get<string[]>('steerhouse.pinned', []), archived: ctx.globalState.get<string[]>('steerhouse.archived', []) });
  const tree = new SessionsTree(() => sessions, () => hooks, () => attachedSessions(), marks);
  /** Adds or removes a project in a pinned / archived list, then repaints the tree. */
  const mark = async (list: 'pinned' | 'archived', p: string | undefined, on: boolean) => {
    if (!p) return;
    const key = `steerhouse.${list}`;
    const cur = ctx.globalState.get<string[]>(key, []).filter((x) => x !== p);
    await ctx.globalState.update(key, on ? [...cur, p] : cur);
    tree.refresh();
  };
  const treeView = vscode.window.createTreeView('steerhouse.sessions', {
    treeDataProvider: tree,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: {
      dropMimeTypes: ['files', 'text/uri-list'],
      dragMimeTypes: [],
      handleDrop: (target, data) => dropOnSession(target, data),
    },
  });
  const dashboard = new Dashboard(ctx, () => sessions, hooksOk, () => attachedSessions(), (m) => onWebview(m), (days) => usageReport(engine.scan(Math.max(days, cfg().get<number>('days', 3))), days));
  const chats = new Chats(ctx, () => sessions, (id) => dashboard.show(id));
  const surface = () => cfg().get<string>('defaultSurface', 'chat');
  registerLibrary(ctx);
  registerSkills(ctx);
  registerDoctor(ctx);
  ctx.subscriptions.push(vscode.commands.registerCommand('steerhouse.walkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'victorcesae.steerhouse#steerhouse.start', false)));
  registerImagePaste(ctx);

  // ------------------------------------------------------------ before/after documents for native diffs
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent(uri) {
        const q = new URLSearchParams(uri.query);
        const s = find(q.get('session') ?? '');
        const file = s && Engine.transcriptPath(s, q.get('agent') || undefined);
        const d = file ? changeDetail(file, q.get('change') ?? '') : undefined;
        return (q.get('side') === 'before' ? d?.original : d?.after) ?? '';
      },
    }),
  );

  function changeUri(s: Session, changeId: string, side: 'before' | 'after') {
    const c = Engine.allChanges(s).find((x) => x.id === changeId)!;
    const query = new URLSearchParams({ session: s.info.id, agent: c.agentId ?? '', change: c.id, side }).toString();
    return vscode.Uri.file(c.file).with({ scheme: SCHEME, query });
  }

  async function openChange(sessionId: string, changeId: string) {
    const s = find(sessionId);
    const c = s && Engine.allChanges(s).find((x) => x.id === changeId);
    if (!s || !c) return;
    const who = c.agentId ? s.info.agents.find((a) => a.id === c.agentId)?.description ?? 'sub-agent' : clip(s.info.title, 40);
    await vscode.commands.executeCommand(
      'vscode.diff',
      changeUri(s, c.id, 'before'),
      changeUri(s, c.id, 'after'),
      `${path.basename(c.file)} · ${clip(who, 40)} · ${ago(c.timestamp)}`,
      { preview: true },
    );
  }

  // ------------------------------------------------------------ sending: steer / queue / send now
  type Extra = { agentId?: string; changeId?: string; file?: string; line?: number; snippet?: string };

  const working = (s: Session) => s.info.state === 'working';
  const defaultMode = (_s: Session): Mode => 'steer';

  /** Text the agent receives: message plus where it applies and attached image paths. */
  function compose(text: string, extra: Extra, images: string[]) {
    let out = text.trim();
    if (extra.file) out = `[${extra.file}${extra.line !== undefined ? `:${extra.line + 1}` : ''}] ${out}`;
    if (images.length) out += `\n\n${images.join(' ')}`;
    return out;
  }

  /**
   * Deliver a message. Returns what actually happened, for the UI.
   * - now:   interrupt (if working) and type into the session's terminal
   * - steer: next step via the PostToolUse hook; if the agent is idle, it's just a new prompt
   * - queue: after the current turn via the Stop hook; if idle, it's just a new prompt
   * Without an attached terminal, idle messages wait for the next prompt; "now" falls back to steer.
   */
  async function send(sessionId: string, text: string, mode: Mode, extra: Extra = {}, images: string[] = []): Promise<string> {
    const s = find(sessionId);
    if (!s || (!text.trim() && !images.length)) return 'nothing sent';
    if (!text.trim()) text = images.length > 1 ? 'Look at these images.' : 'Look at this image.';
    const chat = chats.find(sessionId);
    if (chat && !extra.agentId) {
      chat.chat.send(compose(text, extra, []), [], mode === 'now' ? 'now' : mode === 'steer' ? 'next' : 'later');
      chat.panel.reveal(undefined, true);
      return mode === 'now' ? 'sent now (chat)' : mode === 'steer' ? 'steering (chat)' : 'queued (chat)';
    }
    const term = terminalFor(sessionId);
    const subAgent = !!extra.agentId;

    if (term && !subAgent && (mode === 'now' || !working(s))) {
      await typeInto(term, compose(text, extra, images), mode === 'now' && working(s));
      addComment({ sessionId, text, mode, ...extra, status: 'delivered', deliveredAt: new Date().toISOString(), deliveredVia: 'terminal' });
      refresh(true);
      return mode === 'now' && working(s) ? 'interrupted and sent' : 'sent to its terminal';
    }

    const effective: Mode = mode === 'now' ? 'steer' : mode;
    const body = images.length ? `${text}\n\nAttached image(s), open them with the Read tool: ${images.join(' ')}` : text;
    addComment({ sessionId, text: body, mode: effective, ...extra });
    if (!hooksOk()) offerHooks();
    refresh(true);
    if (mode === 'now') return 'no VS Code terminal runs this session, so it will steer at the next step';
    if (!working(s)) return 'session is idle: delivered with your next prompt in it';
    return effective === 'steer' ? 'steering: delivered at its next step' : 'queued: delivered when this turn ends';
  }

  const MODES: { mode: Mode; label: string; detail: string }[] = [
    { mode: 'steer', label: '$(debug-step-into) Steer', detail: 'The agent gets it at its next step, without stopping.' },
    { mode: 'queue', label: '$(list-ordered) Queue', detail: 'Delivered when the current turn ends; the agent then works on it.' },
    { mode: 'now', label: '$(zap) Send now', detail: 'Interrupts the agent (Esc) and sends it as your next prompt, in its terminal.' },
  ];

  async function pickMode(s: Session): Promise<Mode | undefined> {
    const def = defaultMode(s);
    const items = [...MODES].sort((a, b) => Number(b.mode === def) - Number(a.mode === def));
    const hasTerm = !!terminalFor(s.info.id);
    const pick = await vscode.window.showQuickPick(
      items.map((m) => ({ ...m, description: m.mode === 'now' && !hasTerm ? '(no terminal: will steer)' : m.mode === def ? 'recommended' : '' })),
      { placeHolder: `How should "${clip(s.info.title, 50)}" get it?  (${working(s) ? 'working' : 'idle'})` },
    );
    return pick?.mode;
  }

  async function askAndSend(id: string, forced?: Mode, images: string[] = []) {
    const s = find(id);
    if (!s) return;
    const mode = forced ?? (await pickMode(s));
    if (!mode) return;
    const text = await vscode.window.showInputBox({
      prompt: `${MODES.find((m) => m.mode === mode)!.label.replace(/\$\([^)]+\)\s*/, '')} → "${clip(s.info.title, 50)}"${images.length ? ` · ${images.length} image(s) attached` : ''}`,
      placeHolder: MODES.find((m) => m.mode === mode)!.detail,
    });
    if (text === undefined) return;
    const result = await send(id, text, mode, {}, images);
    vscode.window.setStatusBarMessage(`$(check) Steerhouse: ${result}`, 5000);
  }

  // Drop image files onto a session in the tree. DataTransferFile gives the bytes even over SSH.
  async function dropOnSession(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const s = target && 's' in target ? target.s : undefined;
    if (!s) return;
    const saved: string[] = [];
    for (const [mime, item] of data) {
      const f = item.asFile();
      if (!f) continue;
      const ext = path.extname(f.name).slice(1).toLowerCase();
      const type = Object.keys(EXT).find((k) => EXT[k] === ext || (ext === 'jpeg' && k === 'image/jpeg')) ?? (mime.startsWith('image/') ? mime : undefined);
      if (!type) continue;
      const bytes = await f.data();
      saved.push(saveImage(`data:${type};base64,${Buffer.from(bytes).toString('base64')}`, type));
    }
    if (!saved.length) {
      vscode.window.showWarningMessage('Steerhouse: drop image files (png, jpg, gif, webp) onto a session.');
      return;
    }
    await askAndSend(s.info.id, undefined, saved);
  }

  // ------------------------------------------------------------ line comments on diffs and files → agent
  const controller = vscode.comments.createCommentController('steerhouse', 'Steerhouse · comments to agents');
  controller.options = { prompt: 'Comment for the agent…', placeHolder: 'Tell the agent what to change here, then Steer / Queue / Send now' };
  controller.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      const ok = (doc.uri.scheme === SCHEME && new URLSearchParams(doc.uri.query).get('side') === 'after') || doc.uri.scheme === 'file';
      return ok ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : [];
    },
  };
  ctx.subscriptions.push(controller);
  const sent = new Map<string, { thread: vscode.CommentThread; index: number }>();

  async function targetFor(uri: vscode.Uri): Promise<{ s: Session; changeId?: string; agentId?: string } | undefined> {
    if (uri.scheme === SCHEME) {
      const q = new URLSearchParams(uri.query);
      const s = find(q.get('session') ?? '');
      return s && { s, changeId: q.get('change') ?? undefined, agentId: q.get('agent') || undefined };
    }
    const key = norm(uri.fsPath);
    let candidates = sessions.filter((s) => s.info.files.some((f) => norm(f) === key));
    if (!candidates.length) candidates = sessions.filter((s) => key.startsWith(norm(s.info.project) + '/'));
    if (candidates.length <= 1) return candidates[0] && { s: candidates[0] };
    const pick = await vscode.window.showQuickPick(
      candidates.map((s) => ({ label: s.info.title, description: `${s.info.state} · ${ago(s.info.updated)}`, s })),
      { placeHolder: 'Which agent session should get this comment?' },
    );
    return pick && { s: pick.s };
  }

  const statusLabel = (c?: { status: string; mode?: Mode; deliveredAt?: string; deliveredVia?: string }) => {
    if (!c) return '';
    if (c.status === 'cancelled') return '✕ cancelled';
    if (c.status === 'delivered') return `✓ delivered ${c.deliveredVia === 'step' ? 'mid-task' : c.deliveredVia === 'terminal' ? 'to the terminal' : ''} ${ago(c.deliveredAt)}`;
    return c.mode === 'steer' ? '⏳ steering: at the next step' : '⏳ queued: when the turn ends';
  };

  async function sendComment(reply: vscode.CommentReply, forced?: Mode) {
    const { thread, text } = reply;
    if (!text.trim()) return;
    const target = await targetFor(thread.uri);
    if (!target) {
      vscode.window.showWarningMessage('Steerhouse: no agent session is working on this file.');
      return;
    }
    const line = thread.range?.start.line;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    const extra: Extra = {
      agentId: target.agentId,
      changeId: target.changeId,
      file: thread.uri.fsPath,
      line,
      snippet: line !== undefined && doc ? doc.lineAt(line).text : undefined,
    };
    const mode = forced ?? defaultMode(target.s);
    const result = await send(target.s.info.id, text, mode, extra);
    const latest = loadComments().filter((c) => c.sessionId === target.s.info.id).pop();
    thread.comments = [
      ...thread.comments,
      {
        body: new vscode.MarkdownString(text),
        mode: vscode.CommentMode.Preview,
        author: { name: `You → ${clip(target.s.info.title, 40)}` },
        label: latest ? statusLabel(latest) : result,
      },
    ];
    thread.label = `Agent: ${clip(target.s.info.title, 50)}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    if (latest) sent.set(latest.id, { thread, index: thread.comments.length - 1 });
    vscode.window.setStatusBarMessage(`$(check) Steerhouse: ${result}`, 5000);
  }

  function syncCommentLabels() {
    if (!sent.size) return;
    const byId = new Map(loadComments().map((c) => [c.id, c]));
    for (const [id, { thread, index }] of sent) {
      const want = statusLabel(byId.get(id));
      const comments = [...thread.comments];
      if (comments[index] && want && comments[index].label !== want) {
        comments[index] = { ...comments[index], label: want };
        thread.comments = comments;
      }
    }
  }

  let offered = false;
  async function offerHooks() {
    if (offered) return;
    offered = true;
    const pick = await vscode.window.showInformationMessage(
      hooks === 'some'
        ? 'Steerhouse needs updated Claude Code hooks for steering and "send now". Update ~/.claude/settings.json? A backup is kept.'
        : 'Steerhouse needs Claude Code hooks to hand your messages to agents (steer, queue, send now). Install them in ~/.claude/settings.json? A backup is kept.',
      'Install hooks',
      'Not now',
    );
    if (pick === 'Install hooks') vscode.commands.executeCommand('steerhouse.installHooks');
  }

  // ------------------------------------------------------------ commands
  async function newSession() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let cwd = folders[0]?.uri.fsPath;
    if (folders.length > 1) {
      const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Project for the new agent session') });
      if (!pick) return;
      cwd = pick.uri.fsPath;
    }
    if (!cwd) return vscode.window.showWarningMessage('Open a folder first.');
    const prompt = await vscode.window.showInputBox({ prompt: vscode.l10n.t('What should the agent do?'), placeHolder: vscode.l10n.t('Leave empty to just open a session') });
    if (prompt === undefined) return;
    const account = await pickAgent(cwd);
    if (!account) return;
    if (surface() === 'terminal') runAgent(`${clip(prompt || 'agent', 30)}`, cwd, prompt ? [prompt] : [], await envFor(account));
    else chats.start({ cwd, prompt: prompt || undefined, account, env: await envFor(account) });
  }

  async function linkSession(id: string) {
    const s = find(id);
    if (!s) return;
    // only sessions on the same account, with the same kind of model (Claude, or the same provider model)
    const others = sessions.filter((x) => x.info.id !== id);
    const same = others.filter((x) => sameConnection(x.info, s.info));
    const hidden = others.length - same.length;
    if (!same.length) {
      vscode.window.showInformationMessage(hidden ? vscode.l10n.t('No other session uses the same account and model provider ({0} on other accounts).', hidden) : vscode.l10n.t('No other session to link.'));
      return;
    }
    const pick = await vscode.window.showQuickPick(
      same.map((x) => ({ label: x.info.title, description: `${x.info.state} · ${path.basename(x.info.project)}${x.info.model ? ' · ' + modelLabel(x.info.model) : ''}`, x })),
      {
        placeHolder: vscode.l10n.t('Link which session to "{0}"? Its agent will see what that session is doing.', clip(s.info.title, 40)),
        title: hidden ? vscode.l10n.t('Same account only · {0} sessions on other accounts hidden', hidden) : undefined,
      },
    );
    if (!pick) return;
    if (!chats.linkInto(id, pick.x)) {
      addLink(id, pick.x.info.id);
      const result = await send(id, briefing(pick.x), 'queue');
      vscode.window.setStatusBarMessage(`$(link) Steerhouse: linked · ${result}`, 5000);
    }
    refresh(true);
  }

  async function onWebview(m: FromWebview) {
    switch (m.type) {
      case 'openChange':
        return openChange(m.sessionId, m.changeId);
      case 'openFile':
        return fs.existsSync(m.path) && vscode.window.showTextDocument(vscode.Uri.file(m.path));
      case 'resume':
        return vscode.commands.executeCommand('steerhouse.resumeSession', m.id);
      case 'message': {
        const images = (m.images ?? []).map((i) => saveImage(i.data, i.mime));
        const result = await send(m.id, m.text, m.mode ?? 'queue', {}, images);
        vscode.window.setStatusBarMessage(`$(check) Steerhouse: ${result}`, 5000);
        dashboard.toast(result);
        return;
      }
      case 'cancelComment':
        cancelComment(m.commentId);
        return refresh(true);
      case 'editComment':
        editComment(m.commentId, m.text);
        return refresh(true);
      case 'usage':
        return dashboard.showUsage(m.days);
      case 'promoteComment': {
        const c = loadComments().find((x) => x.id === m.commentId && x.status === 'pending');
        if (!c) return;
        cancelComment(c.id);
        const result = await send(c.sessionId, c.text, 'now', { agentId: c.agentId, changeId: c.changeId, file: c.file, line: c.line, snippet: c.snippet });
        dashboard.toast(result);
        return;
      }
      case 'linkSession':
        return linkSession(m.id);
      case 'newSession':
        return newSession();
      case 'installHooks':
        return vscode.commands.executeCommand('steerhouse.installHooks');
      case 'savePrompt':
        return vscode.commands.executeCommand('steerhouse.savePrompt', m.text);
    }
  }

  const sessionArg = (x: unknown): string | undefined => (typeof x === 'string' ? x : (x as { s?: Session } | undefined)?.s?.info.id);

  // Reload Window: reopen the chats that were open, in their tabs, with their settings
  const chatSerializer: vscode.WebviewPanelSerializer = {
    async deserializeWebviewPanel(panel, state: { sessionId?: string; cwd?: string; title?: string; account?: string } | undefined) {
      try {
        if (!state?.cwd) return panel.dispose();
        if (!state.sessionId) {
          // a chat that had no message yet: open it again, fresh, in the same folder
          const account = listAccounts().find((a) => a.name === state.account) ?? listAccounts()[0];
          return chats.start({ cwd: state.cwd, account, env: await envFor(account), panel });
        }
        if (!sessions.length) await refresh(true);
        const s = find(state.sessionId);
        const account = s ? accountOf(s.info.account) : (listAccounts().find((a) => a.name === state.account) ?? listAccounts()[0]);
        chats.start({ cwd: s?.info.project ?? state.cwd, resume: state.sessionId, title: s?.info.title ?? state.title, account, env: await envFor(account), panel });
      } catch (e: any) {
        // never leave the tab loading forever
        panel.webview.html = `<body style="font-family:sans-serif;padding:16px">Steerhouse could not reopen this chat: ${String(e?.message ?? e).replace(/</g, '&lt;')}. Close the tab and open the session again.</body>`;
      }
    },
  };
  ctx.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('steerhouse.refresh', () => refresh(true)),
    vscode.commands.registerCommand('steerhouse.dashboard', () => dashboard.show()),
    vscode.commands.registerCommand('steerhouse.openRules', (file: string, scope: 'user' | 'project') => openRules(file, scope).then(() => tree.refresh())),
    vscode.commands.registerCommand('steerhouse.editUserRules', () => editRules('user').then(() => tree.refresh())),
    vscode.commands.registerCommand('steerhouse.editProjectRules', (n?: { root?: string }) => editRules('project', n?.root).then(() => tree.refresh())),
    vscode.commands.registerCommand('steerhouse.openSession', (id: string, agentId?: string) => dashboard.show(id, agentId)),
    vscode.commands.registerCommand('steerhouse.openChange', openChange),
    vscode.commands.registerCommand('steerhouse.newSession', newSession),
    vscode.commands.registerCommand('steerhouse.messageSession', (x: unknown) => {
      const id = sessionArg(x);
      if (id) askAndSend(id);
    }),
    vscode.commands.registerCommand('steerhouse.steer', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'steer')),
    vscode.commands.registerCommand('steerhouse.queue', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'queue')),
    vscode.commands.registerCommand('steerhouse.sendNow', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'now')),
    vscode.commands.registerCommand('steerhouse.comment.send', (r: vscode.CommentReply) => sendComment(r)),
    vscode.commands.registerCommand('steerhouse.comment.queue', (r: vscode.CommentReply) => sendComment(r, 'queue')),
    vscode.commands.registerCommand('steerhouse.comment.now', (r: vscode.CommentReply) => sendComment(r, 'now')),
    // Reload Window: reopen the chats that were open, in their tabs, with their settings
    vscode.window.registerWebviewPanelSerializer('steerhouse.chat', chatSerializer),
    // tabs saved by AgentLens (the old name): without this VS Code waits for them forever
    vscode.window.registerWebviewPanelSerializer('agentlens.chat', chatSerializer),
    vscode.window.registerWebviewPanelSerializer('agentlens.dashboard', { deserializeWebviewPanel: async (panel) => panel.dispose() }),
    vscode.commands.registerCommand('steerhouse.pinProject', (n?: { path?: string }) => mark('pinned', n?.path, true)),
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
        value: `steerhouse/${slug(task || new Date().toISOString().slice(0, 16))}`,
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
    // Your sessions on your phone: a small web page with a secret key in its link
    vscode.commands.registerCommand('steerhouse.remoteAccess', async () => {
      const remote = (remoteServer ??= new RemoteServer({ sessions: () => sessions, send: (id, text, mode) => send(id, text, mode) }));
      const link = async () => {
        const base = remote.host === '0.0.0.0' ? vscode.Uri.parse(`http://${lanAddress() ?? '127.0.0.1'}:${remote.port}/`) : await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${remote.port}/`));
        return base.with({ query: `k=${remote.key}` }).toString(true);
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
    // Delete sessions (several when selected together): confirm, then move the conversation and its
    // sub-agents to the system trash, so it can be recovered.
    vscode.commands.registerCommand('steerhouse.deleteSession', async (x: unknown, selected?: unknown[]) => {
      const ids = [...new Set((selected?.length ? selected : [x]).map(sessionArg).filter((v): v is string => !!v))];
      const list = ids.map(find).filter((s): s is Session => !!s);
      if (!list.length) return;
      const what = list.length === 1 ? `"${clip(list[0].info.title, 60)}"` : vscode.l10n.t('{0} sessions', list.length);
      const working = list.filter((s) => s.info.state === 'working').length;
      const ok = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete {0}?', what),
        { modal: true, detail: vscode.l10n.t('The conversation, its sub-agents and its change history move to the trash (Recycle Bin), where you can restore them.') + (working ? '\n\n' + vscode.l10n.t('{0} of them is still working: its chat is closed first.', working) : '') },
        vscode.l10n.t('Move to Trash'),
      );
      if (!ok) return;
      for (const s of list) {
        chats.closeSession(s.info.id);
        const dir = s.path.replace(/\.jsonl$/, '');
        for (const p of [s.path, dir])
          if (fs.existsSync(p)) await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true }).then(undefined, (e) => vscode.window.showErrorMessage(String(e?.message ?? e)));
      }
      vscode.window.setStatusBarMessage(vscode.l10n.t('$(trash) Steerhouse: moved {0} to the trash', what), 5000);
      refresh(true);
    }),
    vscode.commands.registerCommand('steerhouse.resumeSession', async (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (!s) return;
      const account = accountOf(s.info.account);
      if (surface() === 'terminal') runAgent(`${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], await envFor(account));
      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account, env: await envFor(account) });
    }),
    vscode.commands.registerCommand('steerhouse.resumeInTerminal', async (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (s) runAgent(`${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], await envFor(accountOf(s.info.account)));
    }),
    // "New chat here" on a project or folder in the Sessions tree (or a folder in the Explorer)
    // Your default shell in that folder (from a chat, a project or a folder in the tree)
    // Watch a background command's output in a terminal, as it is written (like tail -f)
    vscode.commands.registerCommand('steerhouse.followTask', (x?: { outputFile?: string; command?: string; description?: string } | { task?: { outputFile?: string; command?: string; description?: string } }) => {
      const t = x && 'task' in x ? x.task : (x as { outputFile?: string; command?: string; description?: string } | undefined);
      if (!t?.outputFile) return vscode.window.showWarningMessage(vscode.l10n.t('This command has no output file.'));
      const f = followCommand(t.outputFile);
      vscode.window
        .createTerminal({ name: '▶ ' + clip(t.description || t.command || 'output', 30), shellPath: f.shell, shellArgs: f.args, iconPath: new vscode.ThemeIcon('debug-console') })
        .show();
    }),
    vscode.commands.registerCommand('steerhouse.openTaskFile', (x?: { task?: { outputFile?: string } }) => x?.task?.outputFile && vscode.window.showTextDocument(vscode.Uri.file(x.task.outputFile), { preview: true })),
    vscode.commands.registerCommand('steerhouse.openTerminalHere', (n?: { path?: string } | vscode.Uri | string) => {
      const dir = typeof n === 'string' ? n : n instanceof vscode.Uri ? n.fsPath : (n?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (!dir) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      const cwd = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : path.dirname(dir);
      vscode.window.createTerminal({ name: path.basename(cwd), cwd }).show();
    }),
    vscode.commands.registerCommand('steerhouse.newChatHere', (n?: { kind?: string; path?: string } | vscode.Uri) => {
      const cwd = n instanceof vscode.Uri ? n.fsPath : n?.path;
      if (!cwd) return vscode.commands.executeCommand('steerhouse.newChat');
      pickAgent(cwd).then(async (account) => account && chats.start({ cwd, account, env: await envFor(account) }));
    }),
    vscode.commands.registerCommand('steerhouse.newChat', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      pickAgent(cwd).then(async (account) => account && chats.start({ cwd, account, env: await envFor(account) }));
    }),
    // Connectors: add an MCP server (popular or your own) for the team, just you here, or everywhere
    vscode.commands.registerCommand('steerhouse.manageConnectors', async (cwd?: string) => {
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
    vscode.commands.registerCommand('steerhouse.addProvider', async () => {
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
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name for this provider'), value: `${preset.label.replace(/ \(.*\)$/, '')} · ${model}` });
      if (!name) return;
      const acc = addProvider({ name, preset: preset.id, baseUrl, model, hasKey: !!key });
      if (key) await ctx.secrets.store(secretKey(acc.provider!.id), key);
      const start = vscode.l10n.t('Start a chat with it');
      if ((await vscode.window.showInformationMessage(vscode.l10n.t('Provider "{0}" added.', name), start)) === start) {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (cwd) chats.start({ cwd, account: acc, env: await envFor(acc) });
      }
    }),
    vscode.commands.registerCommand('steerhouse.addAccount', async () => {
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name for the new Claude account'), placeHolder: vscode.l10n.t('Work, Personal, Client X…') });
      if (!name?.trim()) return;
      const a = addAccount(name);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      runAgent(`Claude login · ${a.name}`, cwd, [], accountEnv(a));
      vscode.window.showInformationMessage(vscode.l10n.t('Account "{0}" created. In its terminal type /login and sign in with that account.', a.name));
      refresh(true);
    }),
    vscode.commands.registerCommand('steerhouse.accounts', async () => {
      const pref = preferredAccount();
      const pick = await vscode.window.showQuickPick(
        [
          ...listAccounts().map((a) => ({ label: (a.id === pref.id ? '$(check) ' : '') + a.name, description: a.configDir, a: a as Account | undefined })),
          { label: '$(add) ' + vscode.l10n.t('Add account…'), description: '', a: undefined as Account | undefined },
          { label: '$(server-process) ' + vscode.l10n.t('Add model provider (Ollama, OpenRouter, LiteLLM…)'), description: '', a: { id: '__provider' } as Account },
        ],
        { placeHolder: vscode.l10n.t('Default Claude account for new sessions') },
      );
      if (!pick) return;
      if (!pick.a) return vscode.commands.executeCommand('steerhouse.addAccount');
      if (pick.a.id === '__provider') return vscode.commands.executeCommand('steerhouse.addProvider');
      const acc = pick.a;
      if (acc.id !== 'default') {
        const USE = vscode.l10n.t('Use by default');
        const LOGIN = vscode.l10n.t('Log in again');
        const REMOVE = vscode.l10n.t('Remove from Steerhouse');
        const act = await vscode.window.showQuickPick([USE, LOGIN, REMOVE], { placeHolder: acc.name });
        if (act === LOGIN) return runAgent(`Claude login · ${acc.name}`, require('os').homedir(), [], await envFor(acc));
        if (act === REMOVE) {
          removeAccount(acc.id);
          return refresh(true);
        }
        if (!act) return;
      }
      setPreferred(acc.id);
    }),
    vscode.commands.registerCommand('steerhouse.linkSession', (x: unknown) => sessionArg(x) && linkSession(sessionArg(x)!)),
    vscode.commands.registerCommand('steerhouse.installHooks', () => {
      try {
        // every account has its own settings.json
        const added = listAccounts().reduce((n, a) => n + installHooks(path.join(a.configDir, 'settings.json')), 0);
        hooks = hooksStatus();
        syncSetupContext().catch(() => {});
        vscode.window.showInformationMessage(
          added
            ? 'Steerhouse: hooks installed. Steering, queue and send now work for sessions started from now on (restart running sessions to pick them up).'
            : 'Steerhouse: hooks were already installed.',
        );
        refresh(true);
      } catch (e) {
        vscode.window.showErrorMessage(`Steerhouse: could not update ~/.claude/settings.json: ${e}`);
      }
    }),
  );

  // ------------------------------------------------------------ live refresh
  let signature = '';
  let busy = false;
  async function refresh(force = false) {
    if (busy && !force) return;
    busy = true;
    try {
      sessions = engine.scan(cfg().get<number>('days', 3)).filter((s) => !cfg().get<boolean>('hideTempSessions', true) || !isTempProject(s.info.project));
      await resolveTerminals();
    } catch (e) {
      console.error('Steerhouse scan failed', e);
      return;
    } finally {
      busy = false;
    }
    hooks = hooksStatus();
    const attached = [...attachedSessions()].sort().join(',');
    const sig = sessions.map((s) => `${s.info.id}:${s.info.updated}:${s.info.state}:${s.info.pendingComments}`).join('|') + hooks + attached;
    syncCommentLabels();
    if (!force && sig === signature) return;
    signature = sig;
    tree.refresh();
    dashboard.update();
    chats.refresh();
    const n = sessions.filter((s) => s.info.state === 'working').length;
    treeView.badge = n ? { value: n, tooltip: `${n} agent session(s) working` } : undefined;
  }
  refresh(true);
  restoreTestHooks(chats);
  registerFileActions(ctx, () => tree.refresh());
  let timer = setInterval(refresh, cfg().get<number>('pollSeconds', 3) * 1000);
  ctx.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidOpenTerminal(() => refresh(true)),
    vscode.window.onDidCloseTerminal(() => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('steerhouse')) return;
      clearInterval(timer);
      timer = setInterval(refresh, cfg().get<number>('pollSeconds', 3) * 1000);
      refresh(true);
    }),
  );
}

export function deactivate() {}
