import { Ban, Bot, MessageCircleQuestion, History, MessageSquare, Command, Globe, ChevronUp, Copy, SquareTerminal, Quote, Search, Trash2, Pencil, RotateCcw, UserRound, Check, ChevronDown, ChevronRight, CircleDashed, ClipboardList, FileDiff, ImagePlus, Link2, ListOrdered, Loader2, Navigation, Send, ShieldQuestion, Square, X, Zap } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { post as postAny } from '@/bridge';
import { StateDot, ToolIcon } from '@/components/common';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { base, cn } from '@/lib/utils';
import type { ChatData, ChatItem, ChatState, Effort, PermissionMode, Priority, Question, ToChat, Todo } from '@/types';
import { HunkView } from './Session';
import { Composer, PRIORITY } from './Composer';
import { GalleryRow, LightboxProvider, Zoomable } from '@/components/Lightbox';
import { MediaCards } from '@/components/MediaCards';
import { toolText } from '@/lib/mediaPaths';
import { groupTools, inp, isAgentCall, KIND, stat, summarizeTools, type ToolItem } from './toolSummary';
import { SideRail } from '@/components/SideRail';
import { TurnChip, turnEnds, turnsOf } from '@/components/ChangesPanel';
import { WorkFolders } from '@/components/WorkFolders';
import { HostMark, hostName, VendorMark, vendorName, vendorOf } from '@/components/VendorMark';
import { t } from '@/i18n';
import { PlanCard } from '@/components/PlanCard';
import { CommandPalette, keys } from '@/components/CommandPalette';
import { duration, Elapsed } from '@/components/Elapsed';
import { composerApi } from './Composer';
import { ThinkingRow, toggleAllThinking } from '@/components/Thinking';
import { Fold, JumpRail, usePromptKeys, type Prompt } from '@/components/MessageNav';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Timeline } from '@/components/Timeline';
import { VerifyBadge } from '@/components/VerifyBadge';
import { Clock, FileText, Hammer, Plug, Terminal, Wrench } from 'lucide-react';

const post = (m: ToChat) => postAny(m as never);

// ---------------------------------------------------------------- plan / todos

function TodoCard({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(true);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <Card className="gap-0">
      <button className="flex cursor-pointer items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        <ClipboardList className="text-muted-foreground size-4" />
        <span className="font-medium">{t('Plan')}</span>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {t('{0}/{1} done', done, todos.length)}
        </span>
        <div className="bg-muted ml-2 h-1 flex-1 overflow-hidden rounded-full">
          <div className="bg-recent h-full transition-all" style={{ width: `${(done / todos.length) * 100}%` }} />
        </div>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
      </button>
      {open && (
        <ol className="flex flex-col gap-1 px-3 pb-2.5">
          {todos.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px]">
              {t.status === 'completed' ? (
                <Check className="text-recent mt-0.5 size-3.5 shrink-0" />
              ) : t.status === 'in_progress' ? (
                <Loader2 className="text-working mt-0.5 size-3.5 shrink-0 animate-spin" />
              ) : (
                <CircleDashed className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
              )}
              <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through', t.status === 'in_progress' && 'font-medium')}>
                {t.status === 'in_progress' ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- transcript items

/** What a call returned: its text, and the pictures it read or took (click to enlarge). */
function ToolOutput({ it }: { it: ToolItem }) {
  if (!it.result && !it.images?.length) return null;
  return (
    <div className="border-t" data-tool-output>
      <div className="text-muted-foreground px-3 pt-1.5 text-[10.5px] font-medium tracking-wide uppercase">{t('Output')}</div>
      {!!it.images?.length && (
        <div className="flex flex-wrap gap-2 px-3 pt-1.5">
          {it.images.map((src, i) => (
            <Zoomable key={i} src={src} className="max-h-64 max-w-full rounded-md border object-contain" />
          ))}
        </div>
      )}
      {it.result && <pre className="text-foreground/85 max-h-72 overflow-auto px-3 pt-1 pb-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.result}</pre>}
    </div>
  );
}

/** Full details of one call: the command or input, the output, or the diff. */
function ToolDetails({ it, sessionId }: { it: ToolItem; sessionId?: string }) {
  if (it.patch && it.patch.length > 0)
    return (
      <>
        <HunkView hunks={it.patch} />
        <div className="flex justify-end gap-2 border-t px-2 py-1.5">
          {it.file && (
            <Button size="xs" variant="ghost" onClick={() => post({ type: 'openFile', path: it.file! })}>
              {t('Open file')}
            </Button>
          )}
          {sessionId && (
            <Button size="xs" variant="outline" onClick={() => post({ type: 'openChange', changeId: it.id })}>
              <FileDiff /> {t('Open diff')}
            </Button>
          )}
        </div>
      </>
    );
  return (
    <>
      <ToolInput it={it} />
      <ToolOutput it={it} />
    </>
  );
}

function CollapseBar({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-muted-foreground hover:text-foreground hover:bg-accent/50 flex w-full cursor-pointer items-center justify-center gap-1 border-t py-1 text-[11px]">
      <ChevronUp className="size-3.5" /> {t('Collapse')}
    </button>
  );
}

// ---------------------------------------------------------------- work steps (t3code-style rows)

/** The sub-agent items nested under each Agent call (by the call's id). */
const KidsCtx = createContext<Map<string, ChatItem[]>>(new Map());

/** One icon per kind of call: >_ for commands, a magnifier for searches, a pencil for edits… */
function StepIcon({ it, className }: { it: ToolItem; className?: string }) {
  const c = cn('size-3.5 shrink-0', className);
  if (it.status === 'running') return <Loader2 className={cn(c, 'text-working animate-spin')} />;
  const cls = cn(c, it.status === 'error' && 'text-removed');
  switch (KIND(it.name)) {
    case 'run':
      return <Terminal className={cls} />;
    case 'search':
      return <Search className={cls} />;
    case 'read':
      return <FileText className={cls} />;
    case 'edit':
      return <Pencil className={cls} />;
    case 'browser':
      return <Globe className={cls} />;
    case 'mcp':
      return <Plug className={cls} />;
    default:
      return <Wrench className={cls} />;
  }
}

const mcpName = (n: string) => n.replace(/^mcp__([^_]+)__/, '$1: ');

/** The one-line gist of a call: the command, the pattern, the path. */
function stepText(it: ToolItem): string {
  const i = inp(it);
  switch (KIND(it.name)) {
    case 'run':
      return String(i.command ?? it.summary);
    case 'search':
      return String(i.pattern ?? i.query ?? it.summary);
    case 'read':
    case 'edit':
      return it.file ?? String(i.file_path ?? i.notebook_path ?? it.summary);
    case 'browser':
      return String(i.url ?? '') || it.summary || mcpName(it.name);
    default:
      return it.summary ? `${mcpName(it.name)} ${it.summary}` : mcpName(it.name);
  }
}

/** How long a call took: the elapsed time Claude Code reported, when it did. */
const stepTime = (it: ToolItem) => (it.elapsed !== undefined && it.elapsed >= 1 ? duration(it.elapsed * 1000) : undefined);

/** One compact row per call; clicking it shows the input and output (or the diff) below. */
function ToolStep({ it, sessionId }: { it: ToolItem; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const { add, del } = stat(it);
  const time = stepTime(it);
  const text = stepText(it);
  return (
    <div data-step>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={cn('hover:bg-accent/40 text-muted-foreground hover:text-foreground flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-[12.5px]', open && 'bg-background sticky top-0 z-10')} title={text}>
        <StepIcon it={it} />
        <span className={cn('min-w-0 flex-1 truncate', KIND(it.name) === 'run' && 'font-mono text-[12px]')}>{text}</span>
        {(add > 0 || del > 0) && (
          <span className="shrink-0 font-mono text-[11.5px]">
            <span className="text-added">+{add}</span> <span className="text-removed">−{del}</span>
          </span>
        )}
        {time && <span className="shrink-0 text-[11px] tabular-nums opacity-70">{time}</span>}
        {open ? <ChevronDown className="size-3.5 shrink-0 opacity-70" /> : <ChevronRight className="size-3.5 shrink-0 opacity-70" />}
      </button>
      {open && (
        <div className="bg-muted/20 mt-0.5 mb-1 ml-7 overflow-hidden rounded-md border">
          <ToolDetails it={it} sessionId={sessionId} />
          <CollapseBar onClick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function ToolGroup({ items, sessionId }: { items: ToolItem[]; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // opening one at the bottom of the chat would leave its list below the message box
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'nearest' })));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  const running = items.some((i) => i.status === 'running');
  const failed = items.some((i) => i.status === 'error');
  const pics = items.flatMap((i) => i.images ?? []);
  // files the calls wrote, read or printed: only once every call is done
  const mediaText = useMemo(() => (running ? undefined : items.map((i) => (i.status === 'done' ? toolText(i.input, i.result) : '')).join('\n')), [items, running]);
  const total = items.reduce((a, i) => ({ add: a.add + stat(i).add, del: a.del + stat(i).del }), { add: 0, del: 0 });
  return (
    <div ref={box} data-tool-group>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={cn('text-muted-foreground hover:text-foreground flex h-7 w-full cursor-pointer items-center gap-2 px-1.5 text-left text-[13.5px]', open && 'bg-background sticky top-0 z-20')}>
        {running ? <Loader2 className="text-working size-3.5 shrink-0 animate-spin" aria-label={t('Working…')} /> : failed ? <X className="text-removed size-3.5 shrink-0" /> : <Hammer className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{summarizeTools(items)}</span>
        {(total.add > 0 || total.del > 0) && (
          <span className="shrink-0 font-mono text-[12px]">
            <span className="text-added">+{total.add}</span> <span className="text-removed">−{total.del}</span>
          </span>
        )}
        {open ? <ChevronDown className="ml-auto size-3.5 shrink-0" /> : <ChevronRight className="ml-auto size-3.5 shrink-0" />}
      </button>
      {/* screenshots and images the agent read show up right away, without opening the steps */}
      {!open && pics.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2" data-tool-images>
          {pics.map((src, i) => (
            <Zoomable key={i} src={src} className="max-h-56 max-w-full rounded-md border object-contain" />
          ))}
        </div>
      )}
      {open && (
        <div className="flex flex-col">
          {items.map((it) => (
            <ToolStep key={it.id} it={it} sessionId={sessionId} />
          ))}
        </div>
      )}
      <MediaCards text={mediaText} />
    </div>
  );
}

const tsOf = (s?: string) => (s ? Date.parse(s) : NaN);

/** When a sub-agent started, and (once done) when its last step happened. */
function agentSpan(it: ToolItem, kids: ChatItem[] | undefined): { start?: number; end?: number } {
  const start = tsOf(it.ts);
  if (!Number.isFinite(start)) return {};
  if (it.status === 'running') return { start };
  const times = (kids ?? []).map((k) => tsOf('ts' in k ? k.ts : undefined)).filter(Number.isFinite);
  const last = times.length ? Math.max(...times) : NaN;
  return { start, end: Number.isFinite(last) && last >= start ? last : undefined };
}

function AgentTime({ it, kids }: { it: ToolItem; kids?: ChatItem[] }) {
  const { start, end } = agentSpan(it, kids);
  if (it.status === 'running' && start) return <Elapsed since={start} />;
  if (start && end) return <span className="tabular-nums">{duration(end - start)}</span>;
  return null;
}

/** A sub-agent: its model's mark, what it was asked to do, Running / Done / Failed, its elapsed time; its steps nest below. */
function AgentRow({ it, sessionId }: { it: ToolItem; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const kids = useContext(KidsCtx).get(it.id);
  const { model } = useContext(AgentCtx);
  const sub = String(inp(it).model ?? '') || model;
  const title = String(inp(it).description ?? '') || it.summary || t('Sub-agent');
  // the sub-agent's own calls, without the TodoWrite noise
  const rows = useMemo(() => groupTools(kids ?? []).flatMap((g) => (Array.isArray(g) ? g : [g])), [kids]);
  const state = it.status === 'running' ? <span className="text-working">{t('Running')}</span> : it.status === 'error' ? <span className="text-removed">{t('Failed')}</span> : <span className="text-added">{t('Done')}</span>;
  return (
    <div data-agent-row>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className={cn('hover:bg-accent/40 flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-left', open && 'bg-background sticky top-0 z-10')} title={title}>
        <VendorMark vendor={vendorOf(sub)} className="size-6 rounded-md text-[9px]" title={sub} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-medium">{title}</span>
          <span className="text-[11.5px]">{state}</span>
        </span>
        <span className="text-muted-foreground shrink-0 text-[11.5px]">
          <AgentTime it={it} kids={kids} />
        </span>
        {open ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0" /> : <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />}
      </button>
      {open && (
        <div className="border-border/60 mt-0.5 ml-4 flex flex-col gap-0.5 border-l pl-2.5">
          {rows.map((c) => (
            <Item key={c.id} it={c} sessionId={sessionId} />
          ))}
          {it.result && (
            <div className="bg-muted/20 overflow-hidden rounded-md border">
              <ToolOutput it={it} />
            </div>
          )}
          {!rows.length && !it.result && <div className="text-muted-foreground px-1.5 py-1 text-[12px]">{t('Working…')}</div>}
        </div>
      )}
    </div>
  );
}

/** Several sub-agents running side by side: "3 subagents · 3 working", their marks stacked, total time; one row each. */
function AgentGroup({ items, sessionId }: { items: ToolItem[]; sessionId?: string }) {
  const kidsOf = useContext(KidsCtx);
  const { model } = useContext(AgentCtx);
  const working = items.filter((i) => i.status === 'running').length;
  const spans = items.map((i) => agentSpan(i, kidsOf.get(i.id)));
  const starts = spans.map((s) => s.start).filter((n): n is number => !!n);
  const start = starts.length ? Math.min(...starts) : undefined;
  const ends = spans.map((s) => s.end).filter((n): n is number => !!n);
  const end = !working && ends.length === items.length ? Math.max(...ends) : undefined;
  return (
    <div className="bg-card/40 rounded-lg border px-1.5 py-1" data-agent-group>
      <div className="flex h-8 items-center gap-2 px-1.5 text-[12.5px]">
        <span className="flex shrink-0">
          {items.slice(0, 4).map((i, n) => (
            <VendorMark key={i.id} vendor={vendorOf(String(inp(i).model ?? '') || model)} className={cn('ring-background size-5 rounded-md text-[8px] ring-2', n > 0 && '-ml-1.5')} />
          ))}
        </span>
        <span className="font-medium">{t('{0} subagents', items.length)}</span>
        {working > 0 && <span className="text-working">· {t('{0} working', working)}</span>}
        <span className="text-muted-foreground ml-auto text-[11.5px]">{working > 0 && start ? <Elapsed since={start} /> : start && end ? <span className="tabular-nums">{duration(end - start)}</span> : null}</span>
      </div>
      <div className="flex flex-col">
        {items.map((i) => (
          <AgentRow key={i.id} it={i} sessionId={sessionId} />
        ))}
      </div>
    </div>
  );
}

/** The full command / input of a tool call (the header only has room for a truncated summary). */
function ToolInput({ it }: { it: Extract<ChatItem, { kind: 'tool' }> }) {
  const input = (it.input ?? {}) as Record<string, unknown>;
  const shell = it.name === 'Bash' || it.name === 'PowerShell';
  const body = shell ? String(input.command ?? it.summary) : JSON.stringify(input, null, 2);
  if (!body || body === '{}') return null;
  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-2 px-3 pt-1.5 text-[10.5px] font-medium tracking-wide uppercase">
        {shell ? t('Command') : t('Input')}
        {shell && typeof input.description === 'string' && <span className="normal-case tracking-normal">· {input.description}</span>}
      </div>
      <pre className="max-h-60 overflow-auto px-3 pt-1 pb-2 font-mono text-[12px] whitespace-pre-wrap">
        {shell && <span className="text-muted-foreground select-none">$ </span>}
        {body}
      </pre>
    </div>
  );
}

/** A command the user ran with !. Its output stays visible: they asked to see it. */
function ShellRow({ it }: { it: Extract<ChatItem, { kind: 'shell' }> }) {
  const failed = it.status === 'error';
  return (
    <div className="bg-card overflow-hidden rounded-lg border" data-shell>
      <div className={cn('flex items-center gap-2 px-3 py-1.5 font-mono text-[12px]', (it.output || it.error) && 'border-b')}>
        <span className="text-muted-foreground select-none">$</span>
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{it.command}</span>
        {it.status === 'running' && (
          <>
            <Loader2 className="text-working size-3.5 shrink-0 animate-spin" />
            <Button size="xs" variant="ghost" onClick={() => post({ type: 'stopShell', id: it.id })} title={t('Stop')} aria-label={t('Stop')}>
              <Square />
            </Button>
          </>
        )}
        {failed && <span className="text-removed shrink-0 text-[11px]">{it.exitCode == null ? t('stopped') : t('exit {0}', it.exitCode)}</span>}
      </div>
      {(it.output || it.error) && <pre className="text-foreground/85 max-h-72 overflow-auto px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.output || it.error}</pre>}
    </div>
  );
}

function PermissionCard({ it }: { it: Extract<ChatItem, { kind: 'permission' }> }) {
  const [reason, setReason] = useState('');
  const pending = it.status === 'pending';
  return (
    <Card className={cn('gap-0', pending ? 'border-warn/50' : 'opacity-70')}>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2">
          <ShieldQuestion className="text-warn size-4" />
          <span className="font-medium">{pending ? t('Allow {0}?', it.tool) : `${it.tool}: ${it.status}`}</span>
        </div>
        <pre className="bg-muted max-h-40 overflow-auto rounded-md px-2.5 py-1.5 font-mono text-[12px] whitespace-pre-wrap">{it.summary}</pre>
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => post({ type: 'respond', id: it.id, decision: 'allow' })}>
              <Check /> {t('Allow')}
            </Button>
            {it.canAlways && (
              <Button size="sm" variant="secondary" onClick={() => post({ type: 'respond', id: it.id, decision: 'always' })}>
                {t('Always allow')}
              </Button>
            )}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('or tell it what to do instead…')}
              className="bg-input min-w-40 flex-1 rounded-md border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
            <Button size="sm" variant="outline" onClick={() => post({ type: 'respond', id: it.id, decision: 'deny', message: reason || undefined })}>
              <Ban /> {t('Deny')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuestionCard({ it }: { it: Extract<ChatItem, { kind: 'question' }> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const pending = it.status === 'pending';
  // single choice = radio: an option OR "Other", never both; multiple choice = checkboxes
  const toggle = (q: Question, label: string) => {
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: cur[0] === label ? [] : [label] };
      return { ...p, [q.question]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
    if (!q.multiSelect) setOther((o) => ({ ...o, [q.question]: '' }));
  };
  const typeOther = (q: Question, v: string) => {
    setOther((o) => ({ ...o, [q.question]: v }));
    if (!q.multiSelect && v) setPicked((p) => ({ ...p, [q.question]: [] }));
  };
  const answers = Object.fromEntries(
    it.questions.map((q) => {
      const chosen = [...(picked[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])];
      return [q.question, (q.multiSelect ? chosen : chosen.slice(0, 1)).join(', ')];
    }),
  );
  const ready = it.questions.every((q) => answers[q.question]);
  return (
    <Card className={cn('gap-0', pending && 'border-working/50')}>
      <CardContent className="flex flex-col gap-3 py-3">
        {it.questions.map((q) => (
          <div key={q.question} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{q.header}</Badge>
              <span className="font-medium">{q.question}</span>
            </div>
            {pending ? (
              <>
                <div className="text-muted-foreground text-[11px]">{q.multiSelect ? t('Choose one or more') : t('Choose one')}</div>
                <div className="flex flex-col gap-1" role={q.multiSelect ? 'group' : 'radiogroup'}>
                  {q.options.map((o) => {
                    const on = (picked[q.question] ?? []).includes(o.label);
                    return (
                      <button
                        key={o.label}
                        role={q.multiSelect ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        onClick={() => toggle(q, o.label)}
                        className={cn('flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors', on ? 'border-ring bg-accent' : 'hover:bg-accent')}
                      >
                        <span
                          className={cn(
                            'mt-0.5 grid size-3.5 shrink-0 place-items-center border',
                            q.multiSelect ? 'rounded-[3px]' : 'rounded-full',
                            on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60',
                          )}
                        >
                          {on && (q.multiSelect ? <Check className="size-2.5" /> : <span className="bg-primary-foreground size-1.5 rounded-full" />)}
                        </span>
                        <span>
                          <span className="font-medium">{o.label}</span>
                          {o.description && <span className="text-muted-foreground block text-[11px]">{o.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <input
                  value={other[q.question] ?? ''}
                  onChange={(e) => typeOther(q, e.target.value)}
                  placeholder={t('Other…')}
                  className="bg-input rounded-md border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                />
              </>
            ) : (
              <div className="text-muted-foreground text-[12px]">→ {it.answers?.[q.question] ?? '—'}</div>
            )}
          </div>
        ))}
        {pending && (
          <Button size="sm" className="self-start" disabled={!ready} onClick={() => post({ type: 'respond', id: it.id, decision: 'allow', answers })}>
            <Send /> {t('Answer')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Your message, with "Edit and run again" (forks the conversation at this point). */
function UserMessage({ it }: { it: Extract<ChatItem, { kind: 'user' }> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => (area.current?.focus(), area.current?.select()));
  }, [editing]);
  const submit = () => {
    if (!draft.trim()) return;
    setEditing(false);
    post({ type: 'editPrompt', id: it.id, text: draft });
  };
  return (
    <div className="group/msg flex flex-col items-end gap-1">
      {it.auto && (
        <span className="text-muted-foreground inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[10.5px]" title={t('Sent automatically by Steerhouse after verify failed')} data-auto-message>
          <RotateCcw className="size-3" /> {t('Automatic')}
        </span>
      )}
      {it.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {it.images.map((src, i) => (
            <Zoomable key={i} src={src} className="h-20 rounded-md border object-cover" />
          ))}
        </div>
      )}
      {editing ? (
        <div className="bg-muted flex w-full max-w-[85%] flex-col gap-1.5 rounded-2xl rounded-br-md p-2" data-editing>
          <textarea
            ref={area}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), submit());
              if (e.key === 'Escape') (setEditing(false), setDraft(it.text));
            }}
            rows={Math.min(10, Math.max(2, draft.split('\n').length))}
            className="w-full resize-y bg-transparent px-1.5 text-[13px] outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-muted-foreground mr-auto text-[11px]">{t('Runs the conversation again from here')}</span>
            <Button size="xs" variant="ghost" onClick={() => (setEditing(false), setDraft(it.text))}>
              {t('Cancel')}
            </Button>
            <Button size="xs" onClick={submit} disabled={!draft.trim()}>
              <RotateCcw /> {t('Run again')}
            </Button>
          </div>
        </div>
      ) : (
        it.text && (
          <Fold className="flex max-w-[85%] flex-col items-end">
            <Markdown text={it.text} className="bg-muted rounded-2xl rounded-br-md px-3.5 py-1.5" />
          </Fold>
        )
      )}
      <div className="flex items-center gap-1">
        {!editing && it.forkAt && (
          <Button size="xs" variant="ghost" className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(true)} title={t('Edit this message and run the conversation again from here')} data-edit-prompt>
            <Pencil /> {t('Edit')}
          </Button>
        )}
        {!editing && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" title={t('Restore the code or the conversation to this message')} data-restore>
                <History /> {t('Restore')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => post({ type: 'restore', id: it.id, what: 'code' })}>
                <FileDiff /> {t('Restore code to here')}
              </DropdownMenuItem>
              {it.forkAt && (
                <DropdownMenuItem onSelect={() => post({ type: 'restore', id: it.id, what: 'conversation' })}>
                  <MessageSquare /> {t('Restore conversation to here')}
                </DropdownMenuItem>
              )}
              {it.forkAt && (
                <DropdownMenuItem onSelect={() => post({ type: 'restore', id: it.id, what: 'both' })}>
                  <RotateCcw /> {t('Restore both')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {it.priority && it.priority !== 'later' && (
          <span className="text-muted-foreground opacity-60" title={`${PRIORITY[it.priority].label}: ${PRIORITY[it.priority].hint}`} aria-label={PRIORITY[it.priority].label}>
            {(() => {
              const I = PRIORITY[it.priority].icon;
              return <I className="size-3" />;
            })()}
          </span>
        )}
      </div>
    </div>
  );
}

/** A side question and its answer: off to the side, the agent doing the work never sees it. */
function AsideCard({ it }: { it: Extract<ChatItem, { kind: 'aside' }> }) {
  return (
    <div className="border-primary/30 bg-primary/5 flex flex-col gap-1 rounded-lg border border-dashed px-3 py-2 text-[12.5px]" data-aside>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        <MessageCircleQuestion className="size-3.5" />
        <span className="font-medium">{t('Side question')}</span>
        <span className="truncate">· {it.question}</span>
        <span className="ml-auto shrink-0 opacity-70">{t('not sent to the agent')}</span>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'dismissAside', id: it.id })} title={it.streaming ? t('Stop') : t('Dismiss')} aria-label={t('Dismiss')}>
          <X />
        </Button>
      </div>
      {it.error ? (
        <span className="text-error">{it.error}</span>
      ) : it.answer ? (
        <Fold live={it.streaming}>
          <Markdown text={it.answer} />
        </Fold>
      ) : (
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin" /> {t('Looking at the conversation…')}
        </span>
      )}
    </div>
  );
}

/** Auto mode refused a tool call without asking: say why, and offer the rule that allows it. */
function BlockedCard({ it }: { it: Extract<ChatItem, { kind: 'blocked' }> }) {
  return (
    <div className="border-warn/40 bg-warn/10 flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5">
        <ShieldQuestion className="text-warn size-3.5 shrink-0" />
        <span className="font-medium">{t('Auto mode blocked this')}</span>
        {it.reason && <span className="text-muted-foreground truncate">· {it.reason}</span>}
      </div>
      <code className="bg-muted/60 truncate rounded px-1.5 py-0.5 font-mono text-[11px]" title={it.command}>
        {it.command}
      </code>
      {it.rule &&
        (it.status === 'allowed' ? (
          <span className="text-added flex items-center gap-1">
            <Check className="size-3" /> {t('Allowed: {0}. Ask the agent to try again.', it.rule)}
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => post({ type: 'allowRule', id: it.id, rule: it.rule! } as never)}>
              {t('Always allow {0}', it.rule)}
            </Button>
            <span className="text-muted-foreground text-[11px]">{t('Saved for you in this project (.claude/settings.local.json)')}</span>
          </div>
        ))}
    </div>
  );
}

/** What a subagent sent back, or a background task ending: from the agent, not typed by the user. */
function AgentReport({ it }: { it: Extract<ChatItem, { kind: 'agentReport' }> }) {
  const [open, setOpen] = useState(false);
  if (!it.text) {
    const failed = it.status === 'failed' || it.status === 'stopped' || it.status === 'killed';
    return (
      <div className={cn('flex items-center justify-center gap-1.5 text-[11px]', failed ? 'text-removed' : 'text-muted-foreground')}>
        <Bot className="size-3" />
        {it.title || t('Background task {0}: {1}', it.from, it.status ?? '')}
      </div>
    );
  }
  return (
    <div className="bg-muted/30 rounded-lg border text-[12px]">
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Bot className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground">{t('Report from subagent')}</span>
        <span className="truncate font-medium">{it.title ?? it.from}</span>
      </button>
      {open && <Markdown text={it.text} className="border-t px-3 py-1" />}
    </div>
  );
}

function Item({ it, children, sessionId }: { it: ChatItem; children?: React.ReactNode; sessionId?: string }) {
  switch (it.kind) {
    case 'user':
      return <UserMessage it={it} />;
    case 'assistant':
      if (!it.text.trim() && !it.streaming) return null;
      return (
        <div className="group/answer flex gap-2.5">
          <div className="min-w-0 flex-1">
            <Fold live={it.streaming}>
              <Markdown text={it.text} />
            </Fold>
            {!it.streaming && <MediaCards text={it.text} />}
            {it.streaming && <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />}
            {!it.streaming && (
              <div className="mt-0.5 flex gap-1 opacity-0 transition-opacity group-hover/answer:opacity-100 focus-within:opacity-100">
                <Button size="xs" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('steerhouse:quote', { detail: it.text }))} title={t('Quote this answer in your next message')} data-quote>
                  <Quote /> {t('Quote')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => navigator.clipboard?.writeText(it.text)} title={t('Copy')} aria-label={t('Copy')} data-copy-answer>
                  <Copy />
                </Button>
              </div>
            )}
            {!it.streaming && it.durationMs !== undefined && (
              <div className="text-muted-foreground/70 -mt-5 flex justify-end text-[10.5px] tabular-nums" title={t('How long this turn took')} data-turn-duration>
                {t('Worked for {0}', duration(it.durationMs))}
              </div>
            )}
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingRow it={it} />;
    case 'tool':
      return isAgentCall(it) ? <AgentRow it={it} sessionId={sessionId} /> : <ToolStep it={it} sessionId={sessionId} />;
    case 'shell':
      return <ShellRow it={it} />;
    case 'permission':
      return <PermissionCard it={it} />;
    case 'plan':
      return <PlanCard it={it} />;
    case 'question':
      return <QuestionCard it={it} />;
    case 'result':
      return <div className="border-error/40 bg-error/10 text-error rounded-lg border px-3 py-2 text-[12px]">{t(it.text)}</div>;
    case 'agentReport':
      return <AgentReport it={it} />;
    case 'aside':
      return <AsideCard it={it} />;
    case 'blocked':
      return <BlockedCard it={it} />;
    case 'system':
      return (
        <div className="text-muted-foreground flex items-center justify-center gap-1.5 text-[11px]">
          <Link2 className="size-3" />
          {t(it.text)}
        </div>
      );
  }
}

/** A message waiting to be handed over: still editable, switchable and cancellable. */
function QueuedRow({ q }: { q: ChatState['queue'][number] }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.text);
  const active = useRef(false);
  const steer = q.priority === 'next';
  const Icon = steer ? Navigation : ListOrdered;
  const startEdit = () => {
    setText(q.text);
    setEditing(true);
    active.current = true;
    post({ type: 'holdQueued', id: q.id, hold: true });
  };
  const finish = (keep: boolean) => {
    if (!active.current) return; // Escape then blur: only the first counts
    active.current = false;
    if (keep && text.trim() && text !== q.text) post({ type: 'editQueued', id: q.id, text });
    if (!keep) setText(q.text);
    setEditing(false);
    post({ type: 'holdQueued', id: q.id, hold: false });
  };
  const save = () => finish(true);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1 text-[12px]">
      <span title={steer ? t('Steer: handed over when the agent starts its next step') : t('Queue: handed over when the turn ends')}>
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
      </span>
      {editing ? (
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), save());
            if (e.key === 'Escape') (e.preventDefault(), finish(false));
          }}
          onBlur={save}
          className="bg-input min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[12px] outline-none"
        />
      ) : (
        <button className="min-w-0 flex-1 cursor-text truncate text-left" title={t('Click to edit')} onClick={startEdit}>
          {q.text || t('{0} image(s)', q.images)}
        </button>
      )}
      <span className="text-muted-foreground shrink-0 text-[11px]">{steer ? t('next step') : t('turn end')}</span>
      <div className="flex shrink-0 gap-0.5">
        <Button size="xs" variant="ghost" onClick={startEdit} title={t('Edit')} aria-label={t('Edit')}>
          <Pencil />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'promote', id: q.id, priority: steer ? 'later' : 'next' })} title={steer ? t('Switch to Queue') : t('Switch to Steer')}>
          {steer ? <ListOrdered /> : <Navigation />}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'promote', id: q.id, priority: 'now' })} title={t('Send now')} aria-label={t('Send now')}>
          <Zap />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'cancelQueued', id: q.id })} title={t('Cancel')} aria-label={t('Cancel')}>
          <X />
        </Button>
      </div>
    </div>
  );
}

/** Searchable text of a transcript row. */
function rowText(g: ChatItem | ToolItem[]): string {
  if (Array.isArray(g)) return g.map((it) => `${it.name} ${it.summary} ${it.file ?? ''} ${it.result ?? ''}`).join(' ');
  switch (g.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'system':
    case 'result':
      return g.text;
    case 'agentReport':
      return `${g.title ?? ''} ${g.text ?? ''}`;
    case 'aside':
      return `${g.question} ${g.answer}`;
    case 'blocked':
      return `${g.command} ${g.reason}`;
    case 'shell':
      return `${g.command} ${g.output}`;
    case 'tool':
      return `${g.name} ${g.summary} ${g.result ?? ''}`;
    case 'permission':
      return `${g.tool} ${g.summary}`;
    case 'plan':
      return g.plan;
    case 'question':
      return g.questions.map((q) => q.question).join(' ');
  }
}

/** Which model and editor this chat runs on, for the answer avatars. */
const AgentCtx = createContext<{ model?: string; host?: string; hostIcon?: string }>({});

/** The model's mark (Claude, GPT, Llama…) with a small editor badge (Cursor, VS Code…). */
function AgentAvatar() {
  const { model, host, hostIcon } = useContext(AgentCtx);
  const vendor = vendorOf(model);
  return (
    <span className="relative mt-0.5 inline-flex h-5 shrink-0 self-start" title={`${vendorName(vendor)}${model ? ' · ' + model : ''}${host ? ' · ' + hostName(host) : ''}`}>
      <VendorMark vendor={vendor} className="size-5 rounded-md text-[9px]" />
    </span>
  );
}

// ---------------------------------------------------------------- page

export function ChatView({ data }: { data: ChatData }) {
  const { chat, linked } = data;
  // until Claude Code reports the model, a Claude account (no gateway) is Claude
  const shownModel = chat.model ?? (chat.account.gateway ? undefined : 'claude');
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const working = chat.status === 'working' || chat.status === 'waiting';

  // top-level items; sub-agent items are nested under their Agent tool row
  const { top, byParent } = useMemo(() => {
    const byParent = new Map<string, ChatItem[]>();
    const top: ChatItem[] = [];
    for (const it of chat.items) {
      const parent = 'parent' in it ? it.parent : undefined;
      if (parent) byParent.set(parent, [...(byParent.get(parent) ?? []), it]);
      else top.push(it);
    }
    return { top, byParent };
  }, [chat.items]);
  // sub-agents still running (the composer's status line names them)
  const waitingOn = useMemo(() => top.filter(isAgentCall).filter((i) => i.status === 'running').map((i) => String(inp(i).description ?? '') || t('Sub-agent')), [top]);

  // Long chats: only rows near the viewport are in the DOM; heights are measured as they render.
  const rows = useMemo(() => groupTools(top), [top]);
  const turnChips = useMemo(() => turnEnds(rows, turnsOf(chat.items, chat.cwd), working), [rows, chat.items, chat.cwd, working]);
  // the gallery's order: a row's place in the chat (-1 once it's gone)
  const rank = useMemo(() => {
    const at = new Map(rows.map((g, i) => [Array.isArray(g) ? 'g:' + g[0].id : g.id, i]));
    return (row: string) => at.get(row) ?? -1;
  }, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => {
      const g = rows[i];
      return Array.isArray(g) ? 'g:' + g[0].id : g.id;
    },
  });

  // ---- search (Ctrl+F)
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    return rows.flatMap((g, i) => (rowText(g).toLowerCase().includes(q) ? [i] : []));
  }, [rows, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current = matches.length ? matches[Math.min(cursor, matches.length - 1)] : -1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.select());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- command palette (Ctrl/Cmd+K) and keyboard shortcuts
  const [paletteOpen, setPaletteOpen] = useState(false);
  const workingRef = useRef(working);
  workingRef.current = working;
  useEffect(() => {
    let lastEsc = 0;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && !e.shiftKey && !e.altKey && k === 'o') {
        e.preventDefault();
        toggleAllThinking();
      } else if (mod && !e.shiftKey && !e.altKey && k === 'l') {
        e.preventDefault();
        composerApi.focus();
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        // twice in a row stops the agent (once is enough inside the message box)
        const now = Date.now();
        if (now - lastEsc < 600 && workingRef.current) post({ type: 'interrupt' });
        lastEsc = now;
      } else if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && k === 'c' && workingRef.current && composerApi.isEmpty() && !window.getSelection()?.toString()) {
        // Ctrl+C with nothing to copy and an empty box: stop, like in a terminal
        e.preventDefault();
        post({ type: 'interrupt' });
      }
    };
    const onMsg = (e: MessageEvent) => e.data?.type === 'openPalette' && setPaletteOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMsg);
    };
  }, []);
  useEffect(() => {
    if (current < 0) return;
    stick.current = false;
    setAtBottom(false);
    virtualizer.scrollToIndex(current, { align: 'center' });
  }, [current]);
  const step = (d: number) => matches.length && setCursor((c) => (c + d + matches.length) % matches.length);

  // ---- load earlier history, keeping your place
  const pendingEarlier = useRef<number | null>(null);
  useEffect(() => {
    if (pendingEarlier.current === null) return;
    const added = rows.length - pendingEarlier.current;
    pendingEarlier.current = null;
    if (added > 0) virtualizer.scrollToIndex(added, { align: 'start' });
  }, [rows.length]);

  // ---- getting around: your prompts, the row at the top of the view, jumping
  const prompts = useMemo<Prompt[]>(() => rows.flatMap((g, row) => (!Array.isArray(g) && g.kind === 'user' ? [{ row, text: g.text }] : [])), [rows]);
  const [topRow, setTopRow] = useState(0);
  const rowAtTop = () => {
    const el = scroller.current;
    if (!el) return 0;
    const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop + 8);
    return first?.index ?? 0;
  };
  const jumpTo = (row: number) => {
    stick.current = false;
    setAtBottom(row >= rows.length - 1);
    virtualizer.scrollToIndex(row, { align: 'start' });
    setTopRow(row);
  };
  usePromptKeys(prompts, rowAtTop, jumpTo);
  // ---- session timeline (scrubber above the transcript)
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [playRow, setPlayRow] = useState<number | undefined>();
  const release = () => {
    if (!stick.current) return;
    stick.current = false;
    setAtBottom(false);
  };
  // follow new output while you're at the bottom
  const lastText = chat.items.at(-1)?.kind === 'assistant' ? (chat.items.at(-1) as { text: string }).text.length : 0;
  useEffect(() => {
    if (!stick.current) return;
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [rows.length, lastText, chat.activity, chat.queue.length]);

  return (
    <LightboxProvider rank={rank}>
    <AgentCtx.Provider value={{ model: shownModel, host: chat.host, hostIcon: chat.hostIcon }}>
    <KidsCtx.Provider value={byParent}>
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-1 [&>*]:shrink-0">
        <StateDot state={working ? 'working' : chat.status === 'idle' ? 'recent' : 'idle'} />
        <span className="inline-flex items-center gap-0.5" title={`${hostName(chat.host)}${chat.host ? ' + ' : ''}${vendorName(vendorOf(shownModel))}${chat.model ? ' · ' + chat.model : ''}`}>
          <HostMark host={chat.host} icon={chat.hostIcon} />
          {chat.host && <span className="text-muted-foreground text-[10px]">+</span>}
          <VendorMark vendor={vendorOf(shownModel)} />
        </span>
        <h1 className="min-w-0 flex-1 !shrink truncate text-[13px] font-semibold" title={chat.title}>{chat.title}</h1>
        <WorkFolders chat={chat} />
        {chat.status === 'starting' && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11.5px]" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {t('Starting Claude Code…')}
          </span>
        )}
        <span
          className="text-muted-foreground hidden max-w-52 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px] min-[900px]:inline-flex"
          title={[chat.account.email, chat.account.organization, chat.account.plan, chat.account.provider].filter(Boolean).join(' · ')}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{chat.account.email ?? chat.account.name}</span>
          {chat.account.plan && <span className="opacity-70">· {chat.account.plan}</span>}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setPaletteOpen(true)} title={t('Command palette ({0})', keys('Mod+K'))} aria-label={t('Command palette')} data-open-palette>
          <Command />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => (setSearchOpen((o) => !o), requestAnimationFrame(() => searchInput.current?.focus()))} title={t('Search (Ctrl+F)')} aria-label={t('Search')}>
          <Search />
        </Button>
        <Button size="xs" variant={timelineOpen ? 'secondary' : 'ghost'} onClick={() => setTimelineOpen((o) => !o)} title={t('Show the session timeline')} aria-label={t('Timeline')} aria-pressed={timelineOpen} data-timeline-toggle>
          <Clock />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'openBrowser' })} title={t('Watch the browser this agent drives')} aria-label={t('Open live browser')}>
          <Globe />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'openTerminal' })} title={t('Open a terminal in this folder')} aria-label={t('Open terminal')} data-open-terminal>
          <SquareTerminal />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'link' })} title={t('Let this agent see what another session is doing')}>
          <Link2 /> {t('Link session')}
        </Button>
        {chat.sessionId && (
          <Button size="xs" variant="ghost" onClick={() => post({ type: 'deleteSession' })} title={t('Delete this session')} aria-label={t('Delete session')}>
            <Trash2 />
          </Button>
        )}
      </header>
      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5" role="search">
          <Search className="text-muted-foreground size-3.5" />
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') setSearchOpen(false);
            }}
            placeholder={t('Search this chat…')}
            className="min-w-40 flex-1 bg-transparent text-[12.5px] outline-none"
          />
          <span className="text-muted-foreground text-[11px] tabular-nums">{query.trim() ? (matches.length ? `${Math.min(cursor, matches.length - 1) + 1} / ${matches.length}` : t('No matches')) : ''}</span>
          <Button size="xs" variant="ghost" onClick={() => step(-1)} disabled={!matches.length} aria-label={t('Previous match')}>
            <ChevronUp />
          </Button>
          <Button size="xs" variant="ghost" onClick={() => step(1)} disabled={!matches.length} aria-label={t('Next match')}>
            <ChevronDown />
          </Button>
          {chat.earlier > 0 && (
            <Button size="xs" variant="outline" onClick={() => post({ type: 'loadEarlier', all: true })}>
              {t('Include {0} earlier', chat.earlier)}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setSearchOpen(false)} aria-label={t('Close search')}>
            <X />
          </Button>
        </div>
      )}
      {timelineOpen && <Timeline rows={rows} current={topRow} onJump={jumpTo} onPlayRow={setPlayRow} onClose={() => setTimelineOpen(false)} />}
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5">
          <span className="text-muted-foreground text-[11px]">{t('Linked:')}</span>
          {linked.map((l) => (
            <span key={l.id} className="group inline-flex items-center gap-1.5 rounded-md border py-0.5 pr-1 pl-2 text-[11px]">
              <StateDot state={l.state} className="size-2" />
              <button className="max-w-56 cursor-pointer truncate hover:underline" title={l.activity} onClick={() => post({ type: 'openSession', id: l.id })}>
                {l.title}
              </button>
              <button className="text-muted-foreground hover:text-foreground cursor-pointer opacity-0 group-hover:opacity-100" onClick={() => post({ type: 'unlink', id: l.id })} aria-label={t('Unlink')}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1">
      <div
        ref={scroller}
        className="min-w-0 flex-1 overflow-y-auto"
        // any move up by you stops following the output at once; following resumes only when you
        // come back to the very bottom (growing text must not pull you down while you read)
        onWheel={(e) => e.deltaY < 0 && release()}
        onTouchMove={() => release()}
        onKeyDown={(e) => ['PageUp', 'ArrowUp', 'Home'].includes(e.key) && release()}
        onMouseDown={(e) => e.target === e.currentTarget && release()}
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (gap < 24) stick.current = true;
          else if (gap > 200) stick.current = false;
          setAtBottom(stick.current);
          setTopRow(rowAtTop());
        }}
      >
        <div className="mx-auto flex w-full max-w-[min(72rem,100%)] flex-col gap-1.5 px-5 py-5">
          {!top.length && (
            <div className="text-muted-foreground py-16 text-center">
              <Bot className="mx-auto mb-3 size-8 opacity-60" />
              <div className="text-foreground text-[15px] font-medium">{t('What should we build?')}</div>
              <div className="mt-1 text-[12px]">{chat.cwd}</div>
            </div>
          )}
          {chat.earlier > 0 && (
            <div className="flex justify-center pb-3">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  pendingEarlier.current = rows.length;
                  post({ type: 'loadEarlier' });
                }}
              >
                <ChevronUp /> {t('Load earlier messages ({0} more)', chat.earlier)}
              </Button>
            </div>
          )}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {/* positioned with top, not transform: sticky titles ignore transforms, and would jump to the end of their group */}
            {virtualizer.getVirtualItems().map((v) => {
              const g = rows[v.index];
              return (
                <GalleryRow.Provider key={v.key} value={String(v.key)}>
                <div data-index={v.index} ref={virtualizer.measureElement} className={cn('absolute left-0 w-full pb-3', matchSet.has(v.index) && 'search-hit', v.index === current && 'search-current', v.index === playRow && 'timeline-current')} style={{ top: v.start }}>
                  {Array.isArray(g) ? (
                    isAgentCall(g[0]) ? <AgentGroup items={g} sessionId={chat.sessionId} /> : <ToolGroup items={g} sessionId={chat.sessionId} />
                  ) : (
                    <Item it={g} sessionId={chat.sessionId} />
                  )}
                  {turnChips.has(v.index) && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <TurnChip turn={turnChips.get(v.index)!} />
                      <VerifyBadge chat={chat} turn={turnChips.get(v.index)!.id} />
                    </div>
                  )}
                </div>
                </GalleryRow.Provider>
              );
            })}
          </div>
          {!working && top.some((i) => i.kind === 'user') && ['assistant', 'result', 'tool'].includes(top.at(-1)?.kind ?? '') && (
            <div className="-mt-1 flex justify-start">
              <Button size="xs" variant="ghost" onClick={() => post({ type: 'retry' })} title={t('Send your last message again')}>
                <RotateCcw /> {t('Try again')}
              </Button>
            </div>
          )}
          {chat.error && <div className="border-error/40 bg-error/10 text-error rounded-lg border px-3 py-2 text-[12px]">{chat.error}</div>}
          <div ref={end} />
        </div>
      </div>
      <JumpRail prompts={prompts} total={rows.length} current={topRow} onJump={jumpTo} />
      </div>
      <SideRail chat={chat} />
      </div>

      <div className="relative mx-auto flex w-full max-w-[min(72rem,100%)] flex-col gap-2 px-5 pt-1 pb-4">
        {!atBottom && (
          <button
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
              requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end' }));
            }}
            className="bg-popover text-popover-foreground hover-solid absolute -top-11 left-1/2 z-30 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-[11.5px] shadow-md"
            aria-label={t('Jump to latest')}
          >
            <ChevronDown className="size-3.5" /> {t('Jump to latest')}
          </button>
        )}
        <TodoCard todos={chat.todos} />
        {working && waitingOn.length > 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-[12px]" role="status" data-waiting-subagents>
            <Loader2 className="text-working size-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">
              {waitingOn.length === 1 ? t('Waiting on 1 subagent:') : t('Waiting on {0} subagents:', waitingOn.length)} <span className="text-foreground/80">{waitingOn.join(', ')}</span>
            </span>
            <button className="hover:text-foreground ml-auto shrink-0 cursor-pointer text-[11px] opacity-70" onClick={() => post({ type: 'interrupt' })}>
              · {t('Stop')}
            </button>
          </div>
        ) : working && chat.activity && (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-[12px]" role="status">
            <Loader2 className="text-working size-3.5 animate-spin" />
            <span className="truncate">{t(chat.activity)}</span>
            {chat.turnStarted && (
              <span className="shrink-0 opacity-80" data-elapsed>
                · <Elapsed since={chat.turnStarted} />
              </span>
            )}
            <span className="ml-auto shrink-0 text-[11px] opacity-70">{t('Esc to stop')}</span>
          </div>
        )}
        {!working && chat.verify?.running && (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-[12px]" role="status" data-verifying>
            <Loader2 className="size-3.5 animate-spin" />
            <span className="truncate">{t('Verifying with {0}…', chat.verify.command ?? '')}</span>
            <button className="hover:text-foreground ml-auto shrink-0 cursor-pointer text-[11px] opacity-70" onClick={() => post({ type: 'interrupt' })}>{t('Stop')}</button>
          </div>
        )}
        {chat.queue.length > 0 && (
          <div className="flex flex-col gap-1">
            {chat.queue.map((q) => (
              <QueuedRow key={q.id} q={q} />
            ))}
          </div>
        )}
        <Composer chat={chat} />
      </div>
      {paletteOpen && <CommandPalette chat={chat} onClose={() => setPaletteOpen(false)} />}
    </div>
    </KidsCtx.Provider>
    </AgentCtx.Provider>
    </LightboxProvider>
  );
}
