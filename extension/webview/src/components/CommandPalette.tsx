// Ctrl/Cmd+K in a chat: one searchable list of everything the chat can do, with its shortcut.
import { Bot, Brain, ClipboardCopy, Eraser, FileDown, Gauge, MessageSquarePlus, Search, ShieldCheck, Sparkles, Square, SquareSlash, SquareTerminal, TextCursorInput } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { post as postAny } from '@/bridge';
import { StateDot } from '@/components/common';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatState, RecentChat, ToChat } from '@/types';
import { chatMarkdown } from '@/lib/exportChat';
import { toggleAllThinking } from '@/components/Thinking';
import { allCommands, composerApi, EFFORT_LABEL, EFFORTS, MODES } from '@/views/Composer';

const post = (m: ToChat) => postAny(m as never);
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** "Mod+Shift+N" → "Ctrl+Shift+N" or "⌘⇧N" */
export const keys = (k: string) => (isMac ? k.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : k.replace(/Mod\+/g, 'Ctrl+'));

type Action = { id: string; group: string; label: string; hint?: string; shortcut?: string; icon: React.ComponentType<{ className?: string }>; run: () => void; state?: RecentChat['state'] };

export function CommandPalette({ chat, onClose }: { chat: ChatState; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<RecentChat[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const working = chat.status === 'working' || chat.status === 'waiting';

  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'recentChats' && setRecent(e.data.chats ?? []);
    window.addEventListener('message', on);
    post({ type: 'recentChats' });
    inputRef.current?.focus();
    return () => window.removeEventListener('message', on);
  }, []);

  const chatRef = useRef(chat);
  chatRef.current = chat;
  const md = () => chatMarkdown(chatRef.current, { you: t('You'), assistant: t('Claude') });
  const actions = useMemo<Action[]>(() => {
    const g = { chat: t('Chat'), model: t('Model'), effort: t('Effort'), mode: t('Permission mode'), slash: t('Commands'), recent: t('Recent chats') };
    const list: Action[] = [
      { id: 'new', group: g.chat, label: t('New chat'), shortcut: keys('Mod+Shift+N'), icon: MessageSquarePlus, run: () => post({ type: 'newChat' }) },
      { id: 'focus', group: g.chat, label: t('Focus the message box'), shortcut: keys('Mod+L'), icon: TextCursorInput, run: () => composerApi.focus() },
      ...(working ? [{ id: 'stop', group: g.chat, label: t('Stop the agent'), shortcut: 'Esc Esc', icon: Square, run: () => post({ type: 'interrupt' }) }] : []),
      { id: 'clear', group: g.chat, label: t('Clear the conversation (/clear)'), icon: Eraser, run: () => post({ type: 'localCommand', name: 'clear' }) },
      { id: 'terminal', group: g.chat, label: t('Open terminal'), icon: SquareTerminal, run: () => post({ type: 'openTerminal' }) },
      { id: 'search', group: g.chat, label: t('Search this chat…'), shortcut: keys('Mod+F'), icon: Search, run: () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })) },
      { id: 'thinking', group: g.chat, label: t('Expand or collapse thinking'), shortcut: keys('Mod+O'), icon: Brain, run: toggleAllThinking },
      { id: 'copyMd', group: g.chat, label: t('Copy conversation as Markdown'), icon: ClipboardCopy, run: () => void navigator.clipboard?.writeText(md()) },
      { id: 'exportMd', group: g.chat, label: t('Export conversation to file…'), icon: FileDown, run: () => post({ type: 'exportChat', markdown: md() }) },
      ...chat.models.map((m) => ({ id: 'model:' + m.value, group: g.model, label: t('Model: {0}', m.displayName), hint: m.value === chat.model ? t('current') : undefined, icon: Sparkles, run: () => post({ type: 'setModel', model: m.value }) })),
      ...EFFORTS.map((e) => ({ id: 'effort:' + e, group: g.effort, label: t('Effort: {0}', t(EFFORT_LABEL[e])), hint: e === chat.effort ? t('current') : undefined, icon: Gauge, run: () => post({ type: 'setEffort', effort: e }) })),
      ...MODES.map((m) => ({ id: 'mode:' + m.value, group: g.mode, label: t(m.label), hint: m.value === chat.permissionMode ? t('current') : t(m.hint), icon: ShieldCheck, run: () => post({ type: 'setMode', mode: m.value }) })),
      ...allCommands(chat.slashCommands).map((c) => ({ id: 'slash:' + c, group: g.slash, label: '/' + c, icon: SquareSlash, run: () => composerApi.slash(c) })),
      ...recent.map((r) => ({ id: 'chat:' + r.id, group: g.recent, label: r.title, hint: r.project, icon: Bot, state: r.state, run: () => post({ type: 'openSession', id: r.id }) })),
    ];
    return list;
  }, [chat.models, chat.model, chat.effort, chat.permissionMode, chat.slashCommands, recent, working]);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return actions;
    return actions.filter((a) => {
      const hay = `${a.label} ${a.group} ${a.hint ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [actions, query]);
  const cur = Math.min(sel, Math.max(0, shown.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);

  const run = (a?: Action) => {
    if (!a) return;
    onClose();
    a.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose} data-palette>
      <div className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 flex max-h-[60vh] w-[min(36rem,92vw)] flex-col overflow-hidden rounded-xl border shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('Command palette')}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="text-muted-foreground size-4" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = shown.length || 1;
                setSel((cur + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[cur]);
              }
            }}
            placeholder={t('Type a command, model, mode or chat…')}
            className="flex-1 bg-transparent text-[13px] outline-none"
            aria-label={t('Command palette')}
          />
          <kbd className="bg-muted text-muted-foreground rounded px-1 text-[10px]">Esc</kbd>
        </div>
        <div ref={listRef} className="overflow-y-auto p-1" role="listbox">
          {!shown.length && <div className="text-muted-foreground px-3 py-6 text-center text-[12px]">{t('No matches')}</div>}
          {shown.map((a, i) => {
            const Icon = a.icon;
            return (
              <div key={a.id}>
                {(i === 0 || shown[i - 1].group !== a.group) && <div className="text-muted-foreground px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide uppercase">{a.group}</div>}
                <button
                  data-i={i}
                  role="option"
                  aria-selected={i === cur}
                  onMouseMove={() => i !== cur && setSel(i)}
                  onClick={() => run(a)}
                  className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px]', i === cur && 'bg-accent text-accent-foreground')}
                >
                  {a.state ? <StateDot state={a.state} className="size-2" /> : <Icon className="text-muted-foreground size-4 shrink-0" />}
                  <span className="min-w-0 truncate">{a.label}</span>
                  {a.hint && <span className="text-muted-foreground min-w-0 truncate text-[11px]">{a.hint}</span>}
                  {a.shortcut && <kbd className="bg-muted text-muted-foreground ml-auto shrink-0 rounded px-1.5 text-[10.5px]">{a.shortcut}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
