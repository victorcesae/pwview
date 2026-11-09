// One-off codemod: full context categories + on-demand detail; chat panel sends only what changed.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 90));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};

// ---------- context categories (like Claude's /context)
const CTX_TYPE = "{ used: number; max: number; percentage: number; detailed?: boolean; categories?: { id?: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[] }";
R('src/chat.ts', '  context?: { used: number; max: number; percentage: number; categories?: { name: string; tokens: number }[] };', `  context?: ${CTX_TYPE};`);
R('webview/src/types.ts', 'context?: { used: number; max: number; percentage: number; categories?: { name: string; tokens: number }[] };', `context?: ${CTX_TYPE};`);
R(
  'src/chat.ts',
  "              categories: (u.categories ?? []).filter((c: any) => c.kind === 'used' && c.tokens > 0).map((c: any) => ({ name: c.name, tokens: c.tokens })),",
  '              categories: toCategories(u),',
);
R(
  'src/chat.ts',
  'export interface ChatOptions {',
  `const toCategories = (u: any) => (u.categories ?? []).filter((c: any) => c.tokens > 0).map((c: any) => ({ id: c.id, name: c.name, tokens: c.tokens, kind: c.kind }));

export interface ChatOptions {`,
);
R(
  'src/chat.ts',
  '  /** Connectors: refresh their status,',
  `  /** Exact per-category context breakdown (counts with the token API), for the context panel. */
  async contextDetail() {
    const u: any = await this.q?.getContextUsage({ detail: 'full' });
    if (!u) return;
    this.state.context = { used: u.totalTokens, max: u.maxTokens, percentage: u.percentage, detailed: true, categories: toCategories(u) };
    this.changed();
  }

  /** Connectors: refresh their status,`,
);
R('src/chatPanel.ts', "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'contextDetail' }");
R('src/chatPanel.ts', "      case 'interrupt':", "      case 'contextDetail':\n        return c.contextDetail().catch(() => {});\n      case 'interrupt':");
R('webview/src/types.ts', "  | { type: 'interrupt' }", "  | { type: 'interrupt' }\n  | { type: 'contextDetail' }");

// ---------- send only what changed
const P = 'src/chatPanel.ts';
R(P, 'interface Open {\n  chat: ChatSession;\n  panel: vscode.WebviewPanel;\n}', 'interface Open {\n  chat: ChatSession;\n  panel: vscode.WebviewPanel;\n  /** what the webview already has: item id -> serialized item, and the item order */\n  sent?: { items: Map<string, string>; order: string[] };\n}');
R(P, "      case 'ready':\n        return this.post(o);", "      case 'ready':\n        o.sent = undefined; // (re)load: send everything\n        return this.post(o);");
{
  const s = fs.readFileSync(P, 'utf8');
  const a = s.indexOf('    o.panel.webview.postMessage({\n      type: \'data\',');
  const b = s.indexOf('    });\n  }', a);
  if (a < 0 || b < 0) {
    console.error('MISSING post body');
    process.exit(1);
  }
  const replacement = `    const linkedInfo = linked.map((id) => {
      const x = all.find((y) => y.info.id === id);
      return { id, title: x?.info.title ?? id.slice(0, 8), state: x?.info.state ?? 'idle', activity: x?.t.events.at(-1)?.text?.slice(0, 120) };
    });
    const { items, ...rest } = s;
    if (!o.sent) {
      // first paint: the whole conversation once
      o.sent = { items: new Map(items.map((it) => [it.id, JSON.stringify(it)])), order: items.map((it) => it.id) };
      o.panel.webview.postMessage({ type: 'data', data: { view: 'chat', chat: s, linked: linkedInfo } });
      return;
    }
    // afterwards only items that are new or changed. Old finished items don't change, so only the
    // recent tail and anything still live is compared: cheap even for very long chats.
    const live = new Set(['running', 'pending', 'waiting']);
    const tail = Math.max(0, items.length - 60);
    const upserts = items.filter((it, i) => {
      const prev = o.sent!.items.get(it.id);
      if (prev !== undefined && i < tail && !(it as any).streaming && !live.has((it as any).status)) return false;
      const json = JSON.stringify(it);
      if (json === prev) return false;
      o.sent!.items.set(it.id, json);
      return true;
    });
    const order = items.map((it) => it.id);
    const orderChanged = order.length !== o.sent.order.length || order.some((id, i) => id !== o.sent!.order[i]);
    if (orderChanged) o.sent.order = order;
    o.panel.webview.postMessage({ type: 'chatPatch', chat: rest, upserts, order: orderChanged ? order : undefined, linked: linkedInfo });`;
  fs.writeFileSync(P, s.slice(0, a) + replacement + s.slice(b + '    });\n'.length));
}
console.log('ok');
