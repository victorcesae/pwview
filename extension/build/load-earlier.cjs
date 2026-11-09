// One-off codemod: resumed chats start with the latest page of history; earlier pages on request.
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
R(
  C,
  "      items: opts.history ? [...opts.history.items, { kind: 'system', id: uid(), text: 'Resumed: earlier conversation above' }] : [],",
  "      items: opts.history ? [...opts.history.items.slice(-HISTORY_PAGE), { kind: 'system', id: uid(), text: 'Resumed: earlier conversation above' }] : [],\n      earlier: Math.max(0, (opts.history?.items.length ?? 0) - HISTORY_PAGE),",
);
R(C, '  costUsd: number;\n  /** Which Claude account', '  costUsd: number;\n  /** history items not loaded yet (older than what is shown) */\n  earlier: number;\n  /** Which Claude account');
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
R('webview/src/types.ts', 'slashCommands: string[]; mcp:', 'earlier: number; slashCommands: string[]; mcp:');
R('src/chatPanel.ts', "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'loadEarlier'; all?: boolean }");
R('src/chatPanel.ts', "      case 'interrupt':", "      case 'loadEarlier':\n        return c.loadEarlier(m.all);\n      case 'interrupt':");
R('webview/src/types.ts', "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'loadEarlier'; all?: boolean }");
R('webview/src/mock.ts', "slashCommands: ['compact', 'review', 'init', 'cost', 'model'],", "slashCommands: ['compact', 'review', 'init', 'cost', 'model'], earlier: 0,");
R('webview/src/mock.ts', "  return { view: 'chat', linked: [], chat: { ...base, status: 'idle', activity: undefined, queue: [], items } };", "  return { view: 'chat', linked: [], chat: { ...base, status: 'idle', activity: undefined, queue: [], items, earlier: 1240 } };");
console.log('ok');
