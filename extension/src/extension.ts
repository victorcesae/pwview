import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
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
import { addLink, briefing } from './links';
import { addAccount, listAccounts, preferredAccount, removeAccount, setPreferred, accountEnv, type Account } from './accounts';
import { Node, SessionsTree } from './tree';
import { ago, clip, runAgent } from './util';

const SCHEME = 'agentlens';

export function activate(ctx: vscode.ExtensionContext) {
  const engine = new Engine(() => listAccounts().map((a) => ({ account: a.id, dir: path.join(a.configDir, 'projects') })));
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
  const tree = new SessionsTree(() => sessions, () => hooks, () => attachedSessions());
  const treeView = vscode.window.createTreeView('agentlens.sessions', {
    treeDataProvider: tree,
    showCollapseAll: true,
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
      const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Project for the new agent session' });
      if (!pick) return;
      cwd = pick.uri.fsPath;
    }
    if (!cwd) return vscode.window.showWarningMessage('Open a folder first.');
    const prompt = await vscode.window.showInputBox({ prompt: 'What should the agent do?', placeHolder: 'Leave empty to just open a session' });
    if (prompt === undefined) return;
    const account = await pickAccount();
    if (!account) return;
    if (surface() === 'terminal') runAgent(`✦ ${clip(prompt || 'agent', 30)}`, cwd, prompt ? [prompt] : [], accountEnv(account));
    else chats.start({ cwd, prompt: prompt || undefined, account });
  }

  async function linkSession(id: string) {
    const s = find(id);
    if (!s) return;
    const pick = await vscode.window.showQuickPick(
      sessions.filter((x) => x.info.id !== id).map((x) => ({ label: x.info.title, description: `${x.info.state} · ${path.basename(x.info.project)}`, x })),
      { placeHolder: `Link which session to "${clip(s.info.title, 40)}"? Its agent will see what that session is doing.` },
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
    vscode.commands.registerCommand('agentlens.resumeSession', (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (!s) return;
      const account = accountOf(s.info.account);
      if (surface() === 'terminal') runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], accountEnv(account));
      else chats.start({ cwd: s.info.project, resume: s.info.id, title: s.info.title, account });
    }),
    vscode.commands.registerCommand('agentlens.resumeInTerminal', (x: unknown) => {
      const s = find(sessionArg(x) ?? '');
      if (s) runAgent(`✦ ${clip(s.info.title, 30)}`, s.info.project, ['--resume', s.info.id], accountEnv(accountOf(s.info.account)));
    }),
    vscode.commands.registerCommand('agentlens.newChat', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) return vscode.window.showWarningMessage('Open a folder first.');
      pickAccount().then((account) => account && chats.start({ cwd, account }));
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
        ],
        { placeHolder: vscode.l10n.t('Default Claude account for new sessions') },
      );
      if (!pick) return;
      if (!pick.a) return vscode.commands.executeCommand('agentlens.addAccount');
      const acc = pick.a;
      if (acc.id !== 'default') {
        const USE = vscode.l10n.t('Use by default');
        const LOGIN = vscode.l10n.t('Log in again');
        const REMOVE = vscode.l10n.t('Remove from AgentLens');
        const act = await vscode.window.showQuickPick([USE, LOGIN, REMOVE], { placeHolder: acc.name });
        if (act === LOGIN) return runAgent(`Claude login · ${acc.name}`, require('os').homedir(), [], accountEnv(acc));
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
      sessions = engine.scan(cfg().get<number>('days', 3));
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
