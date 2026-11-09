// One-off codemod: background commands in the chat (history + live SDK task events + Stop).
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) throw new Error('MISSING ' + f + ': ' + a.slice(0, 90));
  fs.writeFileSync(f, s.split(a).join(b));
};
// textsOf moves to bgtasks (shared by the engine and the chat)
const E = 'src/engine.ts';
let e = fs.readFileSync(E, 'utf8');
const a = e.indexOf('/** Every string inside a record value');
const b = e.indexOf('export function parse(', a);
e = e.slice(0, a) + e.slice(b);
e = e.replace("import { BgTaskTracker, type BgTask } from './bgtasks';", "import { BgTaskTracker, textsOf, type BgTask } from './bgtasks';");
fs.writeFileSync(E, e);
fs.appendFileSync(
  'src/bgtasks.ts',
  `
/** Every string inside a record value, joined (to find task notifications wherever they are). */
export function textsOf(x: unknown, depth = 0): string {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object' || depth > 6) return '';
  return (Array.isArray(x) ? x : Object.values(x)).map((v) => textsOf(v, depth + 1)).filter(Boolean).join('\\n');
}

/** SDK task status words → ours. */
export function sdkStatus(s?: string): BgStatus | undefined {
  if (!s) return undefined;
  if (s === 'running' || s === 'pending' || s === 'paused') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'killed' || s === 'stopped') return 'stopped';
  return undefined;
}
`,
);

const C = 'src/chat.ts';
// history: background commands of a resumed session
R(C, `export function historyFromTranscript(file: string): { items: ChatItem[]; todos: Todo[]; title?: string; model?: string } {`, `export function historyFromTranscript(file: string): { items: ChatItem[]; todos: Todo[]; title?: string; model?: string; tasks?: BgTask[] } {
  const bg = new BgTaskTracker();`);
R(C, `    const content = rec.message?.content;
    if (rec.type === 'user') {`, `    const content = rec.message?.content;
    if (rec.type === 'user' || rec.type === 'attachment' || rec.type === 'queue-operation') bg.text(textsOf(content ?? rec.attachment ?? rec.content), rec.timestamp);
    if (rec.type === 'user') {`);
R(C, `        else if (c.type === 'tool_result') {
          const t = tools.get(c.tool_use_id);
          if (!t) continue;`, `        else if (c.type === 'tool_result') {
          bg.toolResult(c.tool_use_id, textsOf(c.content), rec.timestamp);
          const t = tools.get(c.tool_use_id);
          if (!t) continue;`);
R(C, `        else if (c.type === 'tool_use' && !tools.has(c.id)) {
          if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) todos = c.input.todos;`, `        else if (c.type === 'tool_use' && !tools.has(c.id)) {
          bg.toolUse(c.id, c.name, c.input, rec.timestamp);
          if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) todos = c.input.todos;`);
R(C, `  return { items, todos, title, model };`, `  return { items, todos, title, model, tasks: bg.tasks };`);
R(C, `  history?: { items: ChatItem[]; todos: Todo[]; model?: string };`, `  history?: { items: ChatItem[]; todos: Todo[]; model?: string; tasks?: BgTask[] };`);
// state
R(C, `  /** prompts you put aside (shared by all chats) */
  stash?: string[];`, `  /** prompts you put aside (shared by all chats) */
  stash?: string[];
  /** commands the agent left running in the background (dev servers, watchers…) */
  tasks: BgTask[];`);
R(C, `      earlier: Math.max(0, (opts.history?.items.length ?? 0) - HISTORY_PAGE),`, `      earlier: Math.max(0, (opts.history?.items.length ?? 0) - HISTORY_PAGE),
      // from an earlier run of this session: still running only if its output is still being written
      tasks: (opts.history?.tasks ?? []).map((t) => ({ ...t, status: guessStatus(t, false) })),`);
// live: tool calls and results
R(C, `          } else if (c.type === 'tool_use') {
            if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) this.state.todos = c.input.todos;`, `          } else if (c.type === 'tool_use') {
            this.bg.toolUse(c.id, c.name, c.input, new Date().toISOString(), parent);
            if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) this.state.todos = c.input.todos;`);
R(C, `          if (c?.type !== 'tool_result') continue;
          const t = this.tool(c.tool_use_id);`, `          if (c?.type !== 'tool_result') continue;
          this.bg.toolResult(c.tool_use_id, textsOf(c.content), new Date().toISOString());
          this.syncTasks();
          const t = this.tool(c.tool_use_id);`);
// live: SDK task events
R(C, `        } else if (m.subtype === 'status') {`, `        } else if ((m.subtype as string) === 'task_started' || (m.subtype as string) === 'task_updated' || (m.subtype as string) === 'task_notification') {
          this.onTaskEvent(m as any);
        } else if (m.subtype === 'status') {`);
R(C, `  private limitsAt = 0;`, `  /** background commands seen in this run (merged into state.tasks) */
  private bg = new BgTaskTracker();

  private syncTasks() {
    for (const t of this.bg.tasks) if (!this.state.tasks.some((x) => x.id === t.id)) this.state.tasks.push({ ...t });
  }

  /** task_started / task_updated / task_notification: exact status for shell tasks of this run. */
  private onTaskEvent(m: any) {
    let t = this.state.tasks.find((x) => x.id === m.task_id);
    if (m.subtype === 'task_started') {
      if (m.task_type && m.task_type !== 'local_bash') return; // sub-agents are shown elsewhere
      if (!t) {
        const call = m.tool_use_id ? this.tool(m.tool_use_id) : undefined;
        this.state.tasks.push((t = { id: m.task_id, toolUseId: m.tool_use_id, command: String((call?.input as any)?.command ?? m.description ?? ''), description: m.description, status: 'running', started: new Date().toISOString() }));
      }
    }
    if (!t) return;
    const st = m.subtype === 'task_updated' ? sdkStatus(m.patch?.status) : m.subtype === 'task_notification' ? sdkStatus(m.status) : undefined;
    if (st) {
      t.status = st;
      if (st !== 'running') t.ended = new Date().toISOString();
    }
    if (m.output_file) t.outputFile = m.output_file;
    this.changed();
  }

  /** Stops a background command the agent started in this chat. */
  async stopTask(id: string) {
    await this.q?.stopTask(id);
  }

  private limitsAt = 0;`);
let c = fs.readFileSync(C, 'utf8');
c = c.replace(/^(import [^\n]+\n)/m, `import { BgTaskTracker, guessStatus, sdkStatus, textsOf, type BgTask } from './bgtasks';\n$1`);
fs.writeFileSync(C, c);
console.log('ok');
