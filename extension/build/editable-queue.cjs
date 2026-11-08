// One-off codemod: Steer + Queue messages wait in an editable queue until they're handed over.
const fs = require('fs');
const f = 'src/chat.ts';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) {
    console.error('MISSING: ' + a.slice(0, 80));
    process.exit(1);
  }
  s = s.split(a).join(b);
};
R('  queue: { id: string; text: string; images: number }[];', "  queue: { id: string; text: string; images: number; priority: 'later' | 'next' }[];");
R('  private queued: { id: string; text: string; images: Img[] }[] = [];', "  private queued: { id: string; text: string; images: Img[]; priority: 'later' | 'next' }[] = [];");
R('    this.state.queue = this.queued.map((m) => ({ id: m.id, text: m.text, images: m.images.length }));', '    this.state.queue = this.queued.map((m) => ({ id: m.id, text: m.text, images: m.images.length, priority: m.priority }));');
R(
  `  /**
   * later: queued until the current turn ends (kept here, so it can still be edited,
   *        cancelled or promoted); next: steer, picked up between steps; now: send now.
   */
  send(text: string, images: Img[], priority: Priority) {
    if (!text.trim() && !images.length) return;
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    if (priority === 'later' && working) {
      this.queued.push({ id: uid(), text, images });
      this.changed();
      return;
    }
    this.push(text, images, working ? priority : 'later');
  }`,
  `  /**
   * While the agent works, Steer (next) and Queue (later) messages wait here, where they can still
   * be edited, cancelled or switched. Steer is handed over when the agent starts its next step,
   * Queue when the turn ends. Send now (now) goes in immediately.
   */
  send(text: string, images: Img[], priority: Priority) {
    if (!text.trim() && !images.length) return;
    const working = this.state.status === 'working' || this.state.status === 'waiting';
    if (working && priority !== 'now') {
      this.queued.push({ id: uid(), text, images, priority });
      this.changed();
      return;
    }
    this.push(text, images, working ? priority : 'later');
  }

  /** Edit a message that hasn't been handed over yet. */
  editQueued(id: string, text: string) {
    const m = this.queued.find((x) => x.id === id);
    if (!m || !text.trim()) return;
    m.text = text;
    this.changed();
  }

  /** Steer messages go in as the agent starts its next step (it picks them up right after it). */
  private flushSteers() {
    const steers = this.queued.filter((m) => m.priority === 'next');
    if (!steers.length) return;
    this.queued = this.queued.filter((m) => m.priority !== 'next');
    for (const m of steers) this.push(m.text, m.images, 'next');
  }`,
);
R(
  `  promote(id: string, priority: Priority = 'now') {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return;
    const [m] = this.queued.splice(i, 1);
    this.push(m.text, m.images, priority);
  }`,
  `  /** Send a waiting message now, or switch it between Steer and Queue. */
  promote(id: string, priority: Priority = 'now') {
    const i = this.queued.findIndex((m) => m.id === id);
    if (i < 0) return;
    if (priority !== 'now') {
      this.queued[i].priority = priority;
      this.changed();
      return;
    }
    const [m] = this.queued.splice(i, 1);
    this.push(m.text, m.images, 'now');
  }`,
);
R(
  "            if (!parent || c.name === 'Agent') this.state.activity = describe(c.name, c.input);\n          }\n        });",
  "            if (!parent || c.name === 'Agent') this.state.activity = describe(c.name, c.input);\n            if (!parent) startedStep = true;\n          }\n        });\n        if (startedStep) this.flushSteers();",
);
R("      case 'assistant': {\n        const key = parent ?? '';", "      case 'assistant': {\n        let startedStep = false;\n        const key = parent ?? '';");
R(
  `        // the turn ended: hand over the next queued message
        const next = this.queued.shift();
        if (next) this.push(next.text, next.images, 'later');`,
  `        // the turn ended: steers that never found a next step go first, then the next queued message
        const steers = this.queued.filter((q) => q.priority === 'next');
        const handover = steers.length ? steers : this.queued.slice(0, 1);
        this.queued = this.queued.filter((q) => !handover.includes(q));
        for (const q of handover) this.push(q.text, q.images, 'later');`,
);
fs.writeFileSync(f, s);
console.log('ok');
