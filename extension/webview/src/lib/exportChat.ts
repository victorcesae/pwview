// The conversation as Markdown: your messages, the answers, and one line per tool call.
import type { ChatItem, ChatState } from '@/types';

const oneLine = (s: string, max = 160) => {
  const l = s.replace(/\s+/g, ' ').trim();
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};
const quote = (s: string) => s.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

export function chatMarkdown(chat: Pick<ChatState, 'title' | 'cwd' | 'model' | 'items'>, labels: { you: string; assistant: string }): string {
  const out: string[] = [`# ${chat.title || 'Conversation'}`, '', `- ${chat.cwd}${chat.model ? `\n- ${chat.model}` : ''}`, ''];
  let tools: string[] = [];
  const flush = () => {
    if (tools.length) out.push(tools.join('\n'), '');
    tools = [];
  };
  for (const it of chat.items as ChatItem[]) {
    if ('parent' in it && it.parent) continue;
    switch (it.kind) {
      case 'user':
        flush();
        out.push(`## ${labels.you}`, '', quote(it.text || ''), '');
        break;
      case 'assistant':
        if (!it.text.trim()) break;
        flush();
        out.push(`## ${labels.assistant}`, '', it.text.trim(), '');
        break;
      case 'tool':
        tools.push(`- \`${it.name}\` ${oneLine(it.summary)}${it.status === 'error' ? ' (error)' : ''}`);
        break;
      case 'shell':
        tools.push(`- \`!\` ${oneLine(it.command)}`);
        break;
      case 'plan':
        flush();
        out.push(it.plan.trim(), '');
        break;
      case 'result':
        flush();
        out.push(`_${oneLine(it.text)}_`, '');
        break;
      case 'system':
        flush();
        out.push(`_${oneLine(it.text)}_`, '');
        break;
    }
  }
  flush();
  return out.join('\n').trimEnd() + '\n';
}
