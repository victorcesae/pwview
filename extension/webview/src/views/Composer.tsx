// The prompt area: rich-text input, images, Steer/Queue/Send now, model / effort / mode pickers,
// a context-usage ring, and a neutral look that follows the editor theme.
import { SquareTerminal, CornerDownRight, Archive, ArchiveRestore, Blocks, Bot, ListOrdered, Navigation, Paperclip, Plus, Send, ShieldCheck, Sparkles, Square, SquareSlash, Zap, Gauge, X } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, Switch } from '@/components/ui/dropdown-menu';
import { Zoomable } from '@/components/Lightbox';
import { UsagePanel } from '@/components/UsagePanel';
import { prettyModel } from '@/views/toolSummary';
import { atQuery, droppedPaths, mention, shellCommand, withFile } from '@/views/completion';
import { useEffect, useRef, useState } from 'react';
import { post as postAny } from '@/bridge';
import { RichInput, type RichInputHandle } from '@/components/RichInput';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatState, Effort, PermissionMode, Priority, ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);
const MAX_UPLOAD = 100 * 1024 * 1024;

export const PRIORITY: Record<Priority, { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = {
  next: { label: 'Steer', icon: Navigation, hint: 'Picked up at its next step, without stopping' },
  later: { label: 'Queue', icon: ListOrdered, hint: 'Sent when the current turn ends' },
  now: { label: 'Send now', icon: Zap, hint: 'Sent immediately' },
};

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask before acting', hint: 'Asks before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits files freely, asks for commands' },
  { value: 'plan', label: 'Plan mode', hint: 'Plans first, changes nothing until you approve' },
  { value: 'auto', label: 'Auto', hint: 'A classifier approves safe actions' },
  { value: 'bypassPermissions', label: 'Bypass permissions', hint: 'Never asks. Use with care' },
];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

type Img = { data: string; mime: string };
const readImage = (f: File) =>
  new Promise<Img>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ data: String(r.result), mime: f.type || 'image/png' });
    r.onerror = bad;
    r.readAsDataURL(f);
  });

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Context window usage as a ring; spins while the agent works. */
export function ContextRing({ chat }: { chat: ChatState }) {
  const c = chat.context;
  const working = chat.status === 'working' || chat.status === 'waiting' || chat.status === 'starting';
  const pct = c ? Math.min(100, Math.max(0, c.percentage)) : 0;
  const R = 8;
  const C = 2 * Math.PI * R;
  const color = pct >= 85 ? 'var(--removed)' : pct >= 65 ? 'var(--warn)' : 'var(--working)';
  const title = c
    ? `${t('Context')}: ${fmt(c.used)} / ${fmt(c.max)} ${t('tokens')} (${Math.round(pct)}%)` +
      (c.categories?.length ? '\n' + c.categories.map((x) => `${x.name}: ${fmt(x.tokens)}`).join('\n') : '') +
      (pct >= 65 ? `\n${t('Long context: consider /compact')}` : '')
    : working
      ? t('Working…')
      : t('Context usage appears after the first answer');
  return (
    <span className="relative inline-grid size-6 place-items-center" title={title} aria-label={title} role="img">
      <svg viewBox="0 0 20 20" className="size-5 -rotate-90">
        <circle cx={10} cy={10} r={R} fill="none" stroke="var(--border)" strokeWidth={2.5} />
        {c && (
          <circle
            cx={10}
            cy={10}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * C} ${C}`}
            className="transition-[stroke-dasharray] duration-500"
          />
        )}
      </svg>
      {working && c && <span className="bg-working absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full" />}
    </span>
  );
}

function PlusMenu({ chat, onFiles, onSlash }: { chat: ChatState; onFiles: () => void; onSlash: (c: string) => void }) {
  const dot = (s: string) => (s === 'connected' ? 'bg-recent' : s === 'failed' || s === 'needs-auth' ? 'bg-removed' : s === 'pending' ? 'bg-warn' : 'bg-muted-foreground/40');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent grid size-7 cursor-pointer place-items-center rounded-md" aria-label={t('Add')} title={t('Add files, commands, connectors')}>
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem onSelect={onFiles}>
          <Paperclip /> {t('Attach files…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => post({ type: 'setTabCompletion', on: chat.tabCompletion === false })} title={t('Tab completes @files, /commands and the suggested prompt')}>
          <CornerDownRight /> {chat.tabCompletion === false ? t('Turn Tab completion on') : t('Turn Tab completion off')}
        </DropdownMenuItem>
        {chat.slashCommands.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquareSlash /> {t('Slash commands')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
              {chat.slashCommands.map((c) => (
                <DropdownMenuItem key={c} onSelect={() => onSlash(c)} className="font-mono">
                  /{c}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Blocks /> {t('Connectors')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            <DropdownMenuItem onSelect={() => post({ type: 'manageConnectors' })}>
              <Plus /> {t('Add MCP server…')}
            </DropdownMenuItem>
            {chat.mcp.length > 0 && <DropdownMenuSeparator />}
            {chat.mcp.length === 0 && <DropdownMenuLabel>{t('No connectors in this session yet')}</DropdownMenuLabel>}
            {chat.mcp.map((s) => (
              <DropdownMenuItem
                key={s.name}
                onSelect={(e) => {
                  e.preventDefault();
                  if (s.status === 'failed' || s.status === 'needs-auth') post({ type: 'reconnectMcp', name: s.name });
                  else post({ type: 'toggleMcp', name: s.name, enabled: s.status === 'disabled' });
                }}
                title={s.error ?? `${s.status} · ${s.tools} tools`}
              >
                <span className={cn('size-2 shrink-0 rounded-full', dot(s.status))} />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.status === 'failed' || s.status === 'needs-auth' ? (
                  <span className="text-removed text-[11px]">{t('Reconnect')}</span>
                ) : (
                  <Switch on={s.status !== 'disabled'} />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({ chat }: { chat: ChatState }) {
  const working = chat.status === 'working' || chat.status === 'waiting';
  const input = useRef<RichInputHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [priority, setPriority] = useState<Priority>('next'); // Steer by default
  const [over, setOver] = useState(false);
  const [sel, setSel] = useState(0);

  const slash = text.startsWith('/') && !/\s/.test(text) ? chat.slashCommands.filter((c) => `/${c}`.startsWith(text.trim())).slice(0, 8) : [];

  // ---- Tab completion (can be turned off): @ finds files in the chat's folder
  const tabOn = chat.tabCompletion !== false;
  const isShell = text.startsWith('!'); // backticks from completing a file would mean something else in a shell
  const query = tabOn && !isShell ? atQuery(text) : undefined;
  const [foundFiles, setFoundFiles] = useState<{ query: string; files: string[] }>({ query: '', files: [] });
  const files = query !== undefined && foundFiles.query === query ? foundFiles.files : [];
  useEffect(() => {
    if (query === undefined) return;
    const timer = setTimeout(() => post({ type: 'completeFiles', query }), 120);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'fileCompletions' && setFoundFiles({ query: e.data.query, files: e.data.files });
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  const pickFile = (file: string) => {
    const next = withFile(text, file);
    input.current?.setMarkdown(next);
    setText(next);
    input.current?.focus();
  };

  const addPaths = (paths: string[]) => input.current?.insertText(paths.map((p) => mention(p, chat.cwd)).join(' ') + ' ');
  const addPathsRef = useRef(addPaths);
  addPathsRef.current = addPaths;
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'insertPaths' && addPathsRef.current(e.data.paths);
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  const [dropNote, setDropNote] = useState('');
  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    // anything else from this computer: the agent can't open a path here, so the content is copied over
    setDropNote('');
    for (const f of files.filter((x) => !x.type.startsWith('image/'))) {
      if (f.size > MAX_UPLOAD) {
        setDropNote(t('{0} is too large to add (over 100 MB).', f.name));
        continue;
      }
      // a dropped folder can't be read like this
      const data = await f.arrayBuffer().catch(() => undefined);
      if (data) post({ type: 'uploadFile', name: f.name, data: new Uint8Array(data) });
      else setDropNote(t('{0} could not be read. Folders can\'t be added this way: add the files inside.', f.name));
    }
    if (imgs.length) {
      const read = await Promise.all(imgs.map(readImage));
      setImages((p) => [...p, ...read]);
    }
  };
  const send = (p: Priority = priority) => {
    // ! runs in the user's shell, from the text as typed (Markdown would escape my_file and *.ts)
    const command = shellCommand(input.current?.getText() ?? '');
    if (command) {
      post({ type: 'shell', command });
      input.current?.clear();
      setText('');
      return;
    }
    const md = input.current?.getMarkdown() ?? '';
    if (!md.trim() && !images.length) return;
    post({ type: 'send', text: md, images, priority: working ? p : 'later' });
    input.current?.clear();
    setText('');
    setImages([]);
  };
  const pickSlash = (c: string) => {
    input.current?.setMarkdown(`/${c} `);
    setText(`/${c} `);
    input.current?.focus();
  };

  useEffect(() => {
    input.current?.focus();
  }, []);

  // ---- Up / Down: walk through the prompts you sent in this chat (when the box is empty or showing one)
  const sent = chat.items.flatMap((it) => (it.kind === 'user' && it.text.trim() ? [it.text] : it.kind === 'shell' ? [`!${it.command}`] : []));
  const recall = useRef<{ i: number; shown: string } | null>(null);
  const showRecalled = (i: number) => {
    const v = sent[i];
    recall.current = { i, shown: v };
    input.current?.setMarkdown(v);
    setText(v);
    input.current?.focus();
  };
  const recallKey = (e: KeyboardEvent): boolean => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
    const cur = input.current?.getMarkdown() ?? '';
    const browsing = recall.current && cur === recall.current.shown.trim();
    if (!browsing && cur) return false; // a draft: arrows move the cursor as usual
    if (!sent.length) return false;
    if (e.key === 'ArrowUp') {
      const i = browsing ? Math.max(0, recall.current!.i - 1) : sent.length - 1;
      showRecalled(i);
      return true;
    }
    if (!browsing) return false;
    if (recall.current!.i >= sent.length - 1) {
      recall.current = null;
      input.current?.clear();
      setText('');
      return true;
    }
    showRecalled(recall.current!.i + 1);
    return true;
  };

  // ---- quote an answer into the box ("> " lines), from the Quote button on answers
  useEffect(() => {
    const onQuote = (e: Event) => {
      const q = String((e as CustomEvent).detail ?? '')
        .trim()
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n');
      const cur = input.current?.getMarkdown() ?? '';
      const next = `${cur ? cur + '\n\n' : ''}${q}\n\n`;
      input.current?.setMarkdown(next);
      setText(next);
      input.current?.focus();
    };
    window.addEventListener('steerhouse:quote', onQuote);
    return () => window.removeEventListener('steerhouse:quote', onQuote);
  }, []);

  // ---- suggested next prompt (from Claude Code, after a turn): Tab or a click puts it in the box
  const useSuggestion = () => {
    if (!chat.suggestion) return;
    input.current?.setMarkdown(chat.suggestion);
    setText(chat.suggestion);
    input.current?.focus();
  };
  const showSuggestion = !!chat.suggestion && !text.trim() && !working;

  // ---- stash: put the current prompt aside, bring it back later (shared by all chats)
  const stashNow = () => {
    const md = input.current?.getMarkdown() ?? '';
    if (!md.trim()) return;
    post({ type: 'stash', text: md });
    input.current?.clear();
    setText('');
  };
  const unstash = (i: number) => {
    const v = chat.stash?.[i];
    if (v === undefined) return;
    const cur = input.current?.getMarkdown() ?? '';
    const next = cur ? `${cur}\n\n${v}` : v;
    input.current?.setMarkdown(next);
    setText(next);
    post({ type: 'unstash', index: i });
    input.current?.focus();
  };

  const model = chat.models.some((m) => m.value === chat.model) ? chat.model : undefined;
  const P = PRIORITY[priority];

  return (
    <div
      className={cn('bg-card flex flex-col gap-1.5 rounded-xl border px-3 pt-2.5 pb-2 shadow-sm transition-colors', over && 'border-dashed')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const paths = droppedPaths((type) => e.dataTransfer.getData(type));
        if (paths.length) return addPaths(paths);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {dropNote && <div className="text-muted-foreground px-1 text-[11.5px]">{dropNote}</div>}
      {isShell && (
        <div className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11.5px]">
          <SquareTerminal className="size-3.5 shrink-0" />
          {t('Runs now in your shell, in {0}. The agent sees the output with your next message.', chat.cwd.split(/[\\/]/).pop() || chat.cwd)}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-md border">
          {files.map((f, i) => (
            <button
              key={f}
              onMouseDown={(e) => {
                e.preventDefault();
                pickFile(f);
              }}
              className={cn('cursor-pointer truncate px-2.5 py-1 text-left font-mono text-[12px]', i === sel ? 'bg-accent' : 'hover:bg-accent')}
            >
              {f}
            </button>
          ))}
        </div>
      )}
      {slash.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-md border">
          {slash.map((c, i) => (
            <button
              key={c}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(c);
              }}
              className={cn('cursor-pointer px-2.5 py-1 text-left font-mono text-[12px]', i === sel ? 'bg-accent' : 'hover:bg-accent')}
            >
              /{c}
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              <Zoomable src={img.data} className="h-14 rounded-md border object-cover" />
              <button
                onClick={() => setImages(images.filter((_, j) => j !== i))}
                className="bg-background absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full border opacity-0 group-hover:opacity-100"
                aria-label={t('Remove image')}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {showSuggestion && (
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent -mb-0.5 flex max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-left text-[12px]" onClick={useSuggestion} title={t('Use this suggestion (Tab)')} data-suggestion>
          <Sparkles className="size-3.5 shrink-0" />
          <span className="truncate">{chat.suggestion}</span>
          {tabOn && <kbd className="bg-muted rounded px-1 text-[10px]">Tab</kbd>}
        </button>
      )}
      <RichInput
        ref={input}
        placeholder={working ? t('Message the agent while it works…') : t('Ask, plan, or give a task…  (/ commands, ! shell, Shift+drag files here)')}
        onChange={(m) => {
          setText(m);
          setSel(0);
        }}
        onFiles={addFiles}
        onEscape={() => working && post({ type: 'interrupt' })}
        onSubmit={({ ctrl }) => send(ctrl ? 'now' : priority)}
        onKey={(e) => {
          if (tabOn && showSuggestion && e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            useSuggestion();
            return true;
          }
          if (files.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : files.length - 1)) % files.length);
              return true;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault();
              pickFile(files[Math.min(sel, files.length - 1)]);
              return true;
            }
          }
          if (!slash.length) return recallKey(e);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length);
            return true;
          }
          if ((tabOn && e.key === 'Tab') || (e.key === 'Enter' && !e.shiftKey)) {
            pickSlash(slash[sel]);
            return true;
          }
          return false;
        }}
      />

      <div className="flex flex-wrap items-center gap-0.5 border-t pt-1.5">
        <input ref={fileInput} type="file" multiple className="hidden" data-attach onChange={(e) => {
          addFiles([...(e.target.files ?? [])]);
          e.target.value = ''; // the same file can be added again
        }} />
        <PlusMenu chat={chat} onFiles={() => fileInput.current?.click()} onSlash={(c) => pickSlash(c)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent relative grid size-7 cursor-pointer place-items-center rounded-md" aria-label={t('Prompt stash')} title={t('Prompt stash: put a prompt aside, bring it back later')} data-stash>
              <Archive className="size-4" />
              {!!chat.stash?.length && <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-0.5 text-center text-[9px] leading-3.5">{chat.stash.length}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-w-96">
            <DropdownMenuItem onSelect={stashNow} disabled={!text.trim()}>
              <ArchiveRestore className="rotate-180" /> {t('Stash this prompt')}
            </DropdownMenuItem>
            {!!chat.stash?.length && <DropdownMenuSeparator />}
            {!!chat.stash?.length && <DropdownMenuLabel>{t('Stashed prompts')}</DropdownMenuLabel>}
            {(chat.stash ?? []).map((p, i) => (
              <DropdownMenuItem key={i} onSelect={() => unstash(i)} title={p} data-stashed>
                <span className="truncate">{p.split('\n')[0]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Select value={chat.permissionMode} onValueChange={(v) => post({ type: 'setMode', mode: v as PermissionMode })}>
          <SelectTrigger aria-label={t('Permission mode')} title={t('Permission mode')}>
            <ShieldCheck />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectLabel>{t('Permission mode')}</SelectLabel>
            {MODES.map((m) => (
              <SelectItem key={m.value} value={m.value} hint={t(m.hint)}>
                {t(m.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {chat.models.length > 0 && (
          <Select value={model ?? '__current'} onValueChange={(v) => v !== '__current' && post({ type: 'setModel', model: v })}>
            <SelectTrigger aria-label={t('Model')} title={t('Model')}>
              <Sparkles />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectLabel>{t('Model')}</SelectLabel>
              {!model && <SelectItem value="__current">{prettyModel(chat.model) ?? t('Default model')}</SelectItem>}
              {chat.models.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={chat.effort ?? '__default'} onValueChange={(v) => v !== '__default' && post({ type: 'setEffort', effort: v as Effort })}>
          <SelectTrigger aria-label={t('Effort')} title={t('How hard the model thinks. Higher is slower and costs more.')}>
            <Gauge />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectLabel>{t('Effort')}</SelectLabel>
            {!chat.effort && <SelectItem value="__default">{t('Default')}</SelectItem>}
            {EFFORTS.map((e) => (
              <SelectItem key={e} value={e}>
                {t(EFFORT_LABEL[e])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          onClick={() => post({ type: 'setFast', on: !chat.fastMode })}
          title={t('Fast mode: same model, faster output, premium pricing (supported models only)')}
          className={cn('grid size-7 cursor-pointer place-items-center rounded-md', chat.fastMode ? 'text-warn bg-warn/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}
          aria-pressed={chat.fastMode}
          aria-label="Fast"
        >
          <Zap className="size-4" />
        </button>
        <button
          onClick={() => post({ type: 'setUltracode', on: !chat.ultracode })}
          title={t('Ultracode: the agent orchestrates multi-agent workflows for big tasks (supported models only; uses more tokens)')}
          className={cn('grid size-7 cursor-pointer place-items-center rounded-md', chat.ultracode ? 'text-agent bg-agent/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent')}
          aria-pressed={chat.ultracode}
          aria-label="Ultracode"
        >
          <Bot className="size-4" />
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <UsagePanel chat={chat} />
          {working && (
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger aria-label={t('Delivery')} title={P.hint}>
                <P.icon />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                  <SelectItem key={p} value={p} hint={t(PRIORITY[p].hint)}>
                    {PRIORITY[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {working && (
            <Button size="icon" variant="ghost" onClick={() => post({ type: 'interrupt' })} title={t('Stop (Esc)')} aria-label={t('Stop')}>
              <Square className="fill-current" />
            </Button>
          )}
          <Button size="icon" className="rounded-lg" onClick={() => send()} title={working ? `${P.label} (Enter) · Send now (Ctrl+Enter)` : t('Send (Enter)')} aria-label={t('Send')}>
            {working ? <P.icon /> : <Send />}
          </Button>
        </div>
      </div>
    </div>
  );
}
