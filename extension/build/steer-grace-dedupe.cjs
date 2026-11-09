// One-off codemod: Steer = short undo window then immediate hand-over (measured: reliable);
// match final assistant text to the streamed item by message id + order (no duplicates).
const fs = require('fs');
const f = 'src/chat.ts';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) {
    console.error('MISSING: ' + a.slice(0, 90));
    process.exit(1);
  }
  s = s.split(a).join(b);
};

// ---- types
R("  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; parent?: string }", "  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; parent?: string; msg?: string }");

// ---- steer: undo window, then in at once
R(
  `    if (working && priority !== 'now') {
      this.queued.push({ id: uid(), text, images, priority });
      this.changed();
      return;
    }`,
  `    if (working && priority !== 'now') {
      const id = uid();
      this.queued.push({ id, text, images, priority });
      if (priority === 'next') this.armSteer(id);
      this.changed();
      return;
    }`,
);
R(
  `  /** Steer messages go in as the agent starts its next step (it picks them up right after it). */
  private flushSteers() {`,
  `  /**
   * A steer waits only a short undo window (edit / cancel / switch), then goes in at once.
   * Measured against the real CLI: handing it over immediately is what makes the agent follow
   * it within the running turn; waiting for a step boundary often arrives too late.
   */
  steerGraceMs = 3000;
  private steerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private armSteer(id: string) {
    clearTimeout(this.steerTimers.get(id));
    this.steerTimers.set(
      id,
      setTimeout(() => {
        this.steerTimers.delete(id);
        const i = this.queued.findIndex((m) => m.id === id && m.priority === 'next');
        if (i < 0) return;
        const [m] = this.queued.splice(i, 1);
        this.push(m.text, m.images, 'next');
      }, this.steerGraceMs),
    );
  }
  private disarm(id: string) {
    clearTimeout(this.steerTimers.get(id));
    this.steerTimers.delete(id);
  }

  private flushSteers() {
    for (const m of this.queued) if (m.priority === 'next') this.disarm(m.id);`,
);
// switching / sending now / cancelling manage the timer
R(
  `    if (priority !== 'now') {
      this.queued[i].priority = priority;
      this.changed();
      return;
    }
    const [m] = this.queued.splice(i, 1);`,
  `    if (priority !== 'now') {
      this.queued[i].priority = priority;
      if (priority === 'next') this.armSteer(id);
      else this.disarm(id);
      this.changed();
      return;
    }
    this.disarm(id);
    const [m] = this.queued.splice(i, 1);`,
);
R('  cancelQueued(id: string) {\n', '  cancelQueued(id: string) {\n    this.disarm(id);\n');
// no more step-boundary hand-overs
R('        if (startedStep) this.flushSteers();\n', '');
R("        let startedStep = false;\n", '');
R("            if (!parent) startedStep = true;\n", '');
s = s.replace(/\n\s*\/\/ a step just finished: the agent is about to decide what to do next, so a waiting\n\s*\/\/ steer goes in now \(main agent only; sub-agent results don't end a main step\)\n\s*if \(!parent && content\.some\(\(c: any\) => c\?\.type === 'tool_result'\)\) this\.flushSteers\(\);/, '');
if (s.includes("this.flushSteers();\n      }\n      case 'tool_progress'")) console.error('boundary flush still present');

// ---- streaming: remember the message id on streamed text items
R(
  "          this.state.items.push({ kind: 'assistant', id, text: '', streaming: true, parent });",
  "          this.state.items.push({ kind: 'assistant', id, text: '', streaming: true, parent, msg: this.currentMsg.get(key) });",
);
// ---- final message: match by id + order, never add the same text twice
R(
  `        (m.message.content as any[]).forEach((c, index) => {
          if (c.type === 'text') {
            const id = this.streaming.get(\`\${key}:\${msgId}:\${index}\`);
            const it = id && this.state.items.find((x) => x.id === id);
            if (it && it.kind === 'assistant') {
              it.text = c.text;
              it.streaming = false;
            } else if (c.text.trim()) this.state.items.push({ kind: 'assistant', id: uid(), text: c.text, parent });`,
  `        // The CLI can send one reply as several assistant messages (one per block) whose block
        // indexes differ from the stream's, so match streamed text by message id and order.
        const streamed = this.state.items.filter((x): x is Extract<ChatItem, { kind: 'assistant' }> => x.kind === 'assistant' && x.msg === msgId && x.parent === parent);
        const claimed = this.claimed.get(msgId) ?? 0;
        let next = claimed;
        (m.message.content as any[]).forEach((c, index) => {
          if (c.type === 'text') {
            const byIndex = this.streaming.get(\`\${key}:\${msgId}:\${index}\`);
            const it = (byIndex && this.state.items.find((x) => x.id === byIndex && x.kind === 'assistant' && x.streaming)) || streamed[next];
            if (it && it.kind === 'assistant') {
              it.text = c.text;
              it.streaming = false;
              if (it === streamed[next]) next++;
            } else if (c.text.trim()) {
              const last = [...this.state.items].reverse().find((x) => x.kind === 'assistant' && x.parent === parent);
              if (!(last && last.kind === 'assistant' && last.text.trim() === c.text.trim()))
                this.state.items.push({ kind: 'assistant', id: uid(), text: c.text, parent, msg: msgId });
            }`,
);
R(
  "        });\n        break;\n      }\n      case 'user': {",
  "        });\n        this.claimed.set(msgId, next);\n        break;\n      }\n      case 'user': {",
);
R('  private abort = new AbortController();', '  private abort = new AbortController();\n  /** per streamed message: how many of its text blocks the final messages already matched */\n  private claimed = new Map<string, number>();');
fs.writeFileSync(f, s);
console.log('ok');
