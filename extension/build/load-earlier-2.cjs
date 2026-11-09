// Finish load-earlier (first step already applied) + fix the never-ending "starting" state and ring.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
const C = 'src/chat.ts';
R(C, '  costUsd: number;\n  /** All tokens this chat used', '  costUsd: number;\n  /** history items not loaded yet (older than what is shown) */\n  earlier: number;\n  /** All tokens this chat used');
R(C, 'export interface ChatOptions {', '/** How many history items a resumed chat shows at first, and loads per "Load earlier". */\nexport const HISTORY_PAGE = 300;\n\nexport interface ChatOptions {');
R(
  C,
  '  /** Re-send the last thing the user asked (text + images). */',
  `  /** Load older history (one page, or everything with all=true, e.g. to search it). */
  loadEarlier(all = false) {
    const older = this.opts.history?.items ?? [];
    const n = this.state.earlier;
    if (!n) return;
    const take = all ? n : Math.min(HISTORY_PAGE, n);
    this.state.items.unshift(...older.slice(n - take, n));
    this.state.earlier = n - take;
    this.changed();
  }

  /** Re-send the last thing the user asked (text + images). */`,
);
// Claude Code reports "init" only after the first message: the chat is ready as soon as it runs.
R(
  C,
  '    this.q\n      .accountInfo()',
  `    // ready now (init only arrives with the first message); resumed chats get their context at once
    this.state.status = 'idle';
    if (this.opts.resume) this.q.getContextUsage({ detail: 'summary' }).then((u: any) => {
      this.state.context = { used: u.totalTokens, max: u.maxTokens, percentage: u.percentage, categories: toCategories(u) };
      this.changed();
    }).catch(() => {});
    this.q
      .accountInfo()`,
);
for (const f of ['src/chatPanel.ts', 'webview/src/types.ts']) R(f, "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'loadEarlier'; all?: boolean }");
R('src/chatPanel.ts', "      case 'interrupt':", "      case 'loadEarlier':\n        return c.loadEarlier(m.all);\n      case 'interrupt':");
R('webview/src/types.ts', 'slashCommands: string[]; mcp:', 'earlier: number; slashCommands: string[]; mcp:');
R('webview/src/mock.ts', "slashCommands: ['compact', 'review', 'init', 'cost', 'model'],", "slashCommands: ['compact', 'review', 'init', 'cost', 'model'], earlier: 0,");
R('webview/src/mock.ts', "  return { view: 'chat', linked: [], chat: { ...base, status: 'idle', activity: undefined, queue: [], items } };", "  return { view: 'chat', linked: [], chat: { ...base, status: 'idle', activity: undefined, queue: [], items, earlier: 1240 } };");

// ---- the ring never spins: empty circle until there is data
const CP = 'webview/src/views/Composer.tsx';
R(CP, "      <svg viewBox=\"0 0 20 20\" className={cn('size-5 -rotate-90', working && !c && 'animate-spin')}>", '      <svg viewBox="0 0 20 20" className="size-5 -rotate-90">');
R(CP, '        {(c || working) && (', '        {c && (');
R(CP, "            stroke={c ? color : 'var(--working)'}", '            stroke={color}');
R(CP, '            strokeDasharray={c ? `${(pct / 100) * C} ${C}` : `${C * 0.25} ${C}`}', '            strokeDasharray={`${(pct / 100) * C} ${C}`}');

// ---- one spinner: the tool-group summary no longer spins (the status line shows activity)
const CH = 'webview/src/views/Chat.tsx';
R(CH, '        {running && <Loader2 className="text-working size-3.5 animate-spin" />}\n', '        {running && <span className="bg-working size-1.5 shrink-0 animate-pulse rounded-full" aria-label={t(\'Working…\')} />}\n');
console.log('ok');
