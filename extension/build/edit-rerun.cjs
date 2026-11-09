// One-off codemod: edit an earlier prompt and run again from there (fork the session at that point,
// optionally undoing the agent's file changes since), suggested next prompt, prompt stash.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 90));
  fs.writeFileSync(f, s.split(a).join(b));
};
const C = 'src/chat.ts';
// user items know where the conversation can be forked
for (const f of [C, 'webview/src/types.ts'])
  R(f, `  | { kind: 'user'; id: string; text: string; images: string[]; priority?: Priority; ts: string }`, `  | { kind: 'user'; id: string; text: string; images: string[]; priority?: Priority; ts: string; /** transcript entry just before this message: fork here to run it again */ forkAt?: string }`);
R(C, `      if (texts.join('').trim() || images.length) items.push({ kind: 'user', id: rec.uuid ?? uid(), text: texts.join('\\n').trim(), images, ts: rec.timestamp ?? '' });`, `      if (texts.join('').trim() || images.length) items.push({ kind: 'user', id: rec.uuid ?? uid(), text: texts.join('\\n').trim(), images, ts: rec.timestamp ?? '', forkAt: rec.parentUuid ?? undefined });`);
R(C, `    this.state.items.push({ kind: 'user', id: uid(), text, images: images.map((i) => i.data), priority, ts: new Date().toISOString() });`, `    // the message's own uuid (so files can be rewound to it) and the entry before it (to fork there)
    const uuid = randomUUID();
    this.state.items.push({ kind: 'user', id: uuid, text, images: images.map((i) => i.data), priority, ts: new Date().toISOString(), forkAt: this.lastUuid });
    this.state.suggestion = undefined;`);
R(C, `    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority } as SDKUserMessage);
    this.changed();
  }`, `    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, priority, uuid } as SDKUserMessage);
    this.changed();
  }`);
// track the last transcript entry; suggestions
R(C, `  private handle(m: SDKMessage) {
    const parent = ('parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : null) ?? undefined;`, `  /** uuid of the last transcript entry (answer or tool result) of the main conversation */
  private lastUuid?: string;

  private handle(m: SDKMessage) {
    const parent = ('parent_tool_use_id' in m ? (m.parent_tool_use_id as string | null) : null) ?? undefined;
    if ((m.type === 'assistant' || m.type === 'user') && !parent && (m as any).uuid) this.lastUuid = (m as any).uuid;
    if ((m as any).type === 'prompt_suggestion') {
      this.state.suggestion = (m as any).suggestion || undefined;
      this.changed();
      return;
    }`);
R(C, `  /** history items not loaded yet (older than what is shown) */
  earlier: number;`, `  /** history items not loaded yet (older than what is shown) */
  earlier: number;
  /** Claude Code's guess at what you will ask next (after a turn) */
  suggestion?: string;
  /** prompts you put aside (shared by all chats) */
  stash?: string[];`);
R(C, `        settingSources: ['user', 'project', 'local'],`, `        settingSources: ['user', 'project', 'local'],
        promptSuggestions: true,
        // backups of files before the agent edits them, so "edit and run again" can undo them
        enableFileCheckpointing: true,
        ...(this.opts.fork ? { resumeSessionAt: this.opts.fork.at, forkSession: true } : {}),`);
R(C, `  /** settings saved from the last time this session was open (applied at start) */
  prefs?: ChatPrefs;`, `  /** settings saved from the last time this session was open (applied at start) */
  prefs?: ChatPrefs;
  /** run a copy of the resumed session cut at this transcript entry (edit an earlier prompt) */
  fork?: { at: string };`);
R(C, `  /** Load older history (one page`, `  /** Restores files the agent changed after this message (needs file checkpointing, on for AgentLens chats). */
  async rewindFilesTo(userUuid: string): Promise<{ ok: boolean; error?: string; files?: number }> {
    try {
      const r: any = await this.q?.rewindFiles(userUuid);
      if (!r) return { ok: false, error: 'chat not running' };
      return r.canRewind === false ? { ok: false, error: r.error ?? 'cannot rewind' } : { ok: true, files: r.filesChanged?.length ?? r.changedFiles?.length };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  /** Load older history (one page`);
let s = fs.readFileSync(C, 'utf8');
if (!/randomUUID/.test(s.split('\n').slice(0, 20).join('\n'))) s = s.replace(/^(import [^\n]+\n)/m, `import { randomUUID } from 'crypto';\n$1`);
fs.writeFileSync(C, s);

// ---- chat host: edit & run again, stash
const F = 'src/chatPanel.ts';
const types = "  | { type: 'editPrompt'; id: string; text: string }\n  | { type: 'stash'; text: string }\n  | { type: 'unstash'; index: number }";
for (const f of [F, 'webview/src/types.ts']) R(f, "  | { type: 'deleteSession' }\n", "  | { type: 'deleteSession' }\n" + types + '\n');
R(F, `      case 'deleteSession':`, `      case 'stash': {
        const list = [m.text, ...this.stash().filter((x) => x !== m.text)].slice(0, 30);
        await this.ctx.globalState.update('agentlens.stash', list);
        return this.refresh();
      }
      case 'unstash': {
        const list = this.stash().filter((_, i) => i !== m.index);
        await this.ctx.globalState.update('agentlens.stash', list);
        return this.refresh();
      }
      case 'editPrompt':
        return this.editAndRerun(o, m.id, m.text);
      case 'deleteSession':`);
R(F, `  /** Tells you when a chat you're not looking at finishes`, `  private stash(): string[] {
    return this.ctx.globalState.get<string[]>('agentlens.stash', []);
  }

  /**
   * Edit an earlier prompt and run the conversation again from there: the session is forked at the
   * entry before that prompt (the original stays in history), the tab switches to the fork, and the
   * edited text is sent. Optionally the files the agent changed since are restored first.
   */
  private async editAndRerun(o: Open, itemId: string, text: string) {
    const c = o.chat;
    const idx = c.state.items.findIndex((it) => it.id === itemId);
    const item = c.state.items[idx];
    if (!item || item.kind !== 'user' || !c.state.sessionId) return;
    if (!item.forkAt) return vscode.window.showWarningMessage(vscode.l10n.t('This message cannot be run again (it is the first one of a session started outside AgentLens).'));
    if (c.state.status === 'working' || c.state.status === 'waiting') await c.interrupt();
    const undo = vscode.l10n.t('Undo File Changes Too');
    const keep = vscode.l10n.t('Keep Files');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Run the conversation again from this message?'),
      { modal: true, detail: vscode.l10n.t('Everything after it is left out of the new run (the original session stays in your history). The agent may have changed files since: undo those changes too?') },
      undo,
      keep,
    );
    if (!pick) return;
    if (pick === undo) {
      const r = await c.rewindFilesTo(item.id);
      if (!r.ok) {
        const go = await vscode.window.showWarningMessage(vscode.l10n.t('The files could not be restored: {0}', r.error ?? ''), { modal: true }, vscode.l10n.t('Run Again Anyway'));
        if (!go) return;
      }
    }
    const history = { items: c.state.items.slice(0, idx).filter((it) => it.kind !== 'permission'), todos: [] };
    const fork = new ChatSession(
      {
        ...c.options,
        resume: c.state.sessionId,
        fork: { at: item.forkAt },
        history,
        prefs: { model: c.state.model, effort: c.state.effort, permissionMode: c.state.permissionMode, fastMode: c.state.fastMode, ultracode: c.state.ultracode },
      },
      () => this.schedule(o),
    );
    c.close();
    o.chat = fork;
    o.sent = undefined;
    o.prUrls = undefined;
    fork.start();
    fork.send(text, [], 'later');
    this.post(o);
  }

  /** Tells you when a chat you're not looking at finishes`);
// expose options + throttled repaint used by the fork
R(C, `export class ChatSession {
  readonly state: ChatState;`, `export class ChatSession {
  readonly state: ChatState;
  /** how this chat was started (to start a fork of it) */
  get options(): ChatOptions {
    return this.opts;
  }`);
console.log('ok');
