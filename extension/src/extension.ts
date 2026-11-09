import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { editRules, openRules } from './rules';
import { modelLabel } from './pricing';
import { installedAgents, runCliAgent } from './agents';
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
import { ago, clip, runAgent } from './util';

const SCHEME = 'agentlens';

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
function restoreTestHooks(chats: { describe(): unknown }) {
  const open = process.env.AGENTLENS_TEST_OPEN_CHAT;
  const report = process.env.AGENTLENS_TEST_REPORT;
  if (open)
    setTimeout(async () => {
      // "resume:<session id>" resumes that session in a chat; otherwise a new chat in that folder
      if (open.startsWith('resume:')) await vscode.commands.executeCommand('agentlens.resumeSession', open.slice(7));
      else await vscode.commands.executeCommand('agentlens.newChatHere', { kind: 'project', path: open });
      setTimeout(() => vscode.commands.executeCommand('workbench.action.closeWindow'), 4000);
    }, 2000);
  if (report)
    setTimeout(() => {
      require('fs').writeFileSync(report, JSON.stringify({ tabs: vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => ({ label: t.label, viewType: (t.input as any)?.viewType })), chats: chats.describe() }));
      vscode.commands.executeCommand('workbench.action.closeWindow');
    }, 8000);
}

export function activate(ctx: vscode.ExtensionContext) {
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
   * New chat: which agent and account. Claude accounts and model providers run in the AgentLens
   * chat; other agents installed here (Cursor Agent, Codex…) open in a terminal. Asked whenever
   * there is more than one choice; the last one used comes first.
   */
  async function pickAgent(cwd: string): Promise<Account | undefined> {
    const all = listAccounts();
    const clis = installedAgents();
    if (all.length === 1 && !clis.length) return all[0];
    const last = ctx.globalState.get<string>('agentlens.lastAgent') ?? preferredAccount().id;
    type Item = vscode.QuickPickItem & { a?: Account; cli?: (typeof clis)[number]; add?: string };
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'vendors');
    const items: Item[] = [
      ...all.map((a): Item => ({
        label: a.provider ? `${a.name}` : `Claude · ${a.name}`,
        description: a.provider ? `${a.provider.model ?? ''} · ${a.provider.baseUrl}` : vscode.l10n.t('AgentLens chat'),
        iconPath: vscode.Uri.joinPath(media, `${a.provider ? vendorOf(a.provider.model) : 'anthropic'}.svg`),
        a,
      })),
      ...clis.map((c): Item => ({ label: c.name, description: vscode.l10n.t('opens in a terminal'), detail: c.exe, iconPath: vscode.Uri.joinPath(media, `${c.vendor}.svg`), cli: c })),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(add) ' + vscode.l10n.t('Add a Claude account…'), add: 'agentlens.addAccount' },
      { label: '$(server) ' + vscode.l10n.t('Add a model provider (Ollama, OpenRouter…)…'), add: 'agentlens.addProvider' },
    ];
    const key = (i: Item) => i.a?.id ?? (i.cli ? 'cli:' + i.cli.id : '');
    items.sort((x, y) => Number(key(y) === last) - Number(key(x) === last));
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('New chat in {0}', path.basename(cwd)), placeHolder: vscode.l10n.t('Which agent should work here?') });
    if (!pick) return undefined;
    if (pick.add) {
      await vscode.commands.executeCommand(pick.add);
      return undefined;
    }
    ctx.globalState.update('agentlens.lastAgent', key(pick));
    if (pick.cli) {
      runCliAgent(pick.cli, cwd, vscode.Uri.joinPath(ctx.extensionUri, 'media'));
      return undefined;
    }
    setPreferred(pick.a!.id);
    return pick.a;
  }
  const cfg = () => vscode.workspace.getConfiguration('agentlens');
  let sessions: Session[] = [];
  let hooks = hooksStatus();
  const hooksOk = () => hooks === 'all';
  const find = (id: string) => sessions.find((s) => s.info.id === id);

  try {
    installHookScript(path.join(ctx.extensionPath, 'dist', 'hook.js'));
  } catch (e) {
    console.error('AgentLens: could not copy hook script', e);
  }

  // ------------------------------------------------------------ views
  setMediaRoot(vscode.Uri.joinPath(ctx.extensionUri, 'media'));
  const tree = new SessionsTree(() => sessions, () => hooks, () => attachedSessions());
  const treeView = vscode.window.createTreeView('agentlens.sessions', {
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
  ctx.subscriptions.push(vscode.commands.registerCommand('agentlens.walkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', 'victorcesae.agentlens#agentlens.start', false)));
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
    vscode.window.setStatusBarMessage(`$(check) AgentLens: ${result}`, 5000);
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
      vscode.window.showWarningMessage('AgentLens: drop image files (png, jpg, gif, webp) onto a session.');
      return;
    }
    await askAndSend(s.info.id, undefined, saved);
  }

  // ------------------------------------------------------------ line comments on diffs and files → agent
  const controller = vscode.comments.createCommentController('agentlens', 'AgentLens · comments to agents');
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
      vscode.window.showWarningMessage('AgentLens: no agent session is working on this file.');
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
    vscode.window.setStatusBarMessage(`$(check) AgentLens: ${result}`, 5000);
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
        ? 'AgentLens needs updated Claude Code hooks for steering and "send now". Update ~/.claude/settings.json? A backup is kept.'
        : 'AgentLens needs Claude Code hooks to hand your messages to agents (steer, queue, send now). Install them in ~/.claude/settings.json? A backup is kept.',
      'Install hooks',
      'Not now',
    );
    if (pick === 'Install hooks') vscode.commands.executeCommand('agentlens.installHooks');
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
      vscode.window.setStatusBarMessage(`$(link) AgentLens: linked · ${result}`, 5000);
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
        return vscode.commands.executeCommand('agentlens.resumeSession', m.id);
      case 'message': {
        const images = (m.images ?? []).map((i) => saveImage(i.data, i.mime));
        const result = await send(m.id, m.text, m.mode ?? 'queue', {}, images);
        vscode.window.setStatusBarMessage(`$(check) AgentLens: ${result}`, 5000);
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
        return vscode.commands.executeCommand('agentlens.installHooks');
      case 'savePrompt':
        return vscode.commands.executeCommand('agentlens.savePrompt', m.text);
    }
  }

  const sessionArg = (x: unknown): string | undefined => (typeof x === 'string' ? x : (x as { s?: Session } | undefined)?.s?.info.id);

  ctx.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('agentlens.refresh', () => refresh(true)),
    vscode.commands.registerCommand('agentlens.dashboard', () => dashboard.show()),
    vscode.commands.registerCommand('agentlens.openRules', (file: string, scope: 'user' | 'project') => openRules(file, scope).then(() => tree.refresh())),
    vscode.commands.registerCommand('agentlens.editUserRules', () => editRules('user').then(() => tree.refresh())),
    vscode.commands.registerCommand('agentlens.editProjectRules', (n?: { root?: string }) => editRules('project', n?.root).then(() => tree.refresh())),
    vscode.commands.registerCommand('agentlens.openSession', (id: string, agentId?: string) => dashboard.show(id, agentId)),
    vscode.commands.registerCommand('agentlens.openChange', openChange),
    vscode.commands.registerCommand('agentlens.newSession', newSession),
    vscode.commands.registerCommand('agentlens.messageSession', (x: unknown) => {
      const id = sessionArg(x);
      if (id) askAndSend(id);
    }),
    vscode.commands.registerCommand('agentlens.steer', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'steer')),
    vscode.commands.registerCommand('agentlens.queue', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'queue')),
    vscode.commands.registerCommand('agentlens.sendNow', (x: unknown) => sessionArg(x) && askAndSend(sessionArg(x)!, 'now')),
    vscode.commands.registerCommand('agentlens.comment.send', (r: vscode.CommentReply) => sendComment(r)),
    vscode.commands.registerCommand('agentlens.comment.queue', (r: vscode.CommentReply) => sendComment(r, 'queue')),
    vscode.commands.registerCommand('agentlens.comment.now', (r: vscode.CommentReply) => sendComment(r, 'now')),
    // Reload Window: reopen the chats that were open, in their tabs, with their settings
    vscode.window.registerWebviewPanelSerializer('agentlens.chat', {
      async deserializeWebviewPanel(panel, state: { sessionId?: string; cwd?: string; title?: string; account?: string } | undefined) {
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
      },
    }),
    // Delete sessions (several when selected together): confirm, then move the conversation and its
    // sub-agents to the system trash, so it can be recovered.
    vscode.commands.registerCommand('agentlens.deleteSession', async (x: unknown, selected?: unknown[]) => {
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
      vscode.window.setStatusBarMessage(vscode.l10n.t('$(trash) AgentLens: moved {0} to the trash', what), 5000);
      refresh(true);
    }),
    vscode.commands.registerCommand('agentlens.resumeSession', async (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (!s) return;
      const account = accountOf(s.info.account);
      if (surface() === 'terminal') runAgent(`${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], await envFor(account));
      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account, env: await envFor(account) });
    }),
    vscode.commands.registerCommand('agentlens.resumeInTerminal', async (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (s) runAgent(`${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], await envFor(accountOf(s.info.account)));
    }),
    // "New chat here" on a project or folder in the Sessions tree (or a folder in the Explorer)
    vscode.commands.registerCommand('agentlens.newChatHere', (n?: { kind?: string; path?: string } | vscode.Uri) => {
      const cwd = n instanceof vscode.Uri ? n.fsPath : n?.path;
      if (!cwd) return vscode.commands.executeCommand('agentlens.newChat');
      pickAgent(cwd).then(async (account) => account && chats.start({ cwd, account, env: await envFor(account) }));
    }),
    vscode.commands.registerCommand('agentlens.newChat', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) return vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      pickAgent(cwd).then(async (account) => account && chats.start({ cwd, account, env: await envFor(account) }));
    }),
    vscode.commands.registerCommand('agentlens.manageConnectors', async (cwd?: string) => {
      const dir = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!dir) return;
      const file = path.join(dir, '.mcp.json');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      vscode.window.showInformationMessage(vscode.l10n.t('Add MCP servers under "mcpServers" (shared with the team). Personal ones: run "claude mcp add" in a terminal. Start a new chat to load changes.'));
    }),
    vscode.commands.registerCommand('agentlens.addProvider', async () => {
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
    vscode.commands.registerCommand('agentlens.addAccount', async () => {
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name for the new Claude account'), placeHolder: vscode.l10n.t('Work, Personal, Client X…') });
      if (!name?.trim()) return;
      const a = addAccount(name);
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      runAgent(`Claude login · ${a.name}`, cwd, [], accountEnv(a));
      vscode.window.showInformationMessage(vscode.l10n.t('Account "{0}" created. In its terminal type /login and sign in with that account.', a.name));
      refresh(true);
    }),
    vscode.commands.registerCommand('agentlens.accounts', async () => {
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
      if (!pick.a) return vscode.commands.executeCommand('agentlens.addAccount');
      if (pick.a.id === '__provider') return vscode.commands.executeCommand('agentlens.addProvider');
      const acc = pick.a;
      if (acc.id !== 'default') {
        const USE = vscode.l10n.t('Use by default');
        const LOGIN = vscode.l10n.t('Log in again');
        const REMOVE = vscode.l10n.t('Remove from AgentLens');
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
    vscode.commands.registerCommand('agentlens.linkSession', (x: unknown) => sessionArg(x) && linkSession(sessionArg(x)!)),
    vscode.commands.registerCommand('agentlens.installHooks', () => {
      try {
        // every account has its own settings.json
        const added = listAccounts().reduce((n, a) => n + installHooks(path.join(a.configDir, 'settings.json')), 0);
        hooks = hooksStatus();
        syncSetupContext().catch(() => {});
        vscode.window.showInformationMessage(
          added
            ? 'AgentLens: hooks installed. Steering, queue and send now work for sessions started from now on (restart running sessions to pick them up).'
            : 'AgentLens: hooks were already installed.',
        );
        refresh(true);
      } catch (e) {
        vscode.window.showErrorMessage(`AgentLens: could not update ~/.claude/settings.json: ${e}`);
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
      console.error('AgentLens scan failed', e);
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
  let timer = setInterval(refresh, cfg().get<number>('pollSeconds', 3) * 1000);
  ctx.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    vscode.window.onDidOpenTerminal(() => refresh(true)),
    vscode.window.onDidCloseTerminal(() => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('agentlens')) return;
      clearInterval(timer);
      timer = setInterval(refresh, cfg().get<number>('pollSeconds', 3) * 1000);
      refresh(true);
    }),
  );
}

export function deactivate() {}
