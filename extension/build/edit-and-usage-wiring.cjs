// One-off codemod: edit queued/pending messages; chat token totals; usage view plumbing.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
// chat panel: editQueued
R('src/chatPanel.ts', "  | { type: 'cancelQueued'; id: string }", "  | { type: 'cancelQueued'; id: string }\n  | { type: 'editQueued'; id: string; text: string }");
R('src/chatPanel.ts', "      case 'cancelQueued':", "      case 'editQueued':\n        return c.editQueued(m.id, m.text);\n      case 'cancelQueued':");
R('webview/src/types.ts', "  | { type: 'cancelQueued'; id: string }", "  | { type: 'cancelQueued'; id: string }\n  | { type: 'editQueued'; id: string; text: string }");
R('webview/src/types.ts', "queue: { id: string; text: string; images: number }[];", "queue: { id: string; text: string; images: number; priority: 'later' | 'next' }[]; tokens?: number;");
// chat: token totals from each turn's usage
R('src/chat.ts', '  costUsd: number;\n', '  costUsd: number;\n  /** All tokens this chat used (input + output + cache), from each turn\'s usage. */\n  tokens?: number;\n');
R('src/chat.ts', "        this.state.costUsd += r.total_cost_usd ?? 0;", "        this.state.costUsd += r.total_cost_usd ?? 0;\n        const u = r.usage ?? {};\n        this.state.tokens = (this.state.tokens ?? 0) + (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);");
// terminal sessions: edit a pending message
R('src/comments.ts', 'export function cancelComment(id: string) {', `export function editComment(id: string, text: string) {
  const all = loadComments();
  const c = all.find((x) => x.id === id && x.status === 'pending');
  if (c && text.trim()) {
    c.text = text;
    saveComments(all);
  }
}

export function cancelComment(id: string) {`);
R('src/extension.ts', "import { addComment, cancelComment, loadComments, Mode } from './comments';", "import { addComment, cancelComment, editComment, loadComments, Mode } from './comments';");
R('src/extension.ts', "      case 'cancelComment':\n        cancelComment(m.commentId);\n        return refresh(true);", "      case 'cancelComment':\n        cancelComment(m.commentId);\n        return refresh(true);\n      case 'editComment':\n        editComment(m.commentId, m.text);\n        return refresh(true);\n      case 'usage':\n        return dashboard.showUsage(m.days);");
for (const f of ['src/panel.ts', 'webview/src/types.ts'])
  R(f, "  | { type: 'cancelComment'; commentId: string }", "  | { type: 'cancelComment'; commentId: string }\n  | { type: 'editComment'; commentId: string; text: string }\n  | { type: 'usage'; days: number }");
console.log('ok');
