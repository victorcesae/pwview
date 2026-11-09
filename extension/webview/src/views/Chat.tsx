import { Ban, Bot, Globe, ChevronUp, Copy, SquareTerminal, Quote, Search, Trash2, Pencil, RotateCcw, UserRound, Check, ChevronDown, ChevronRight, CircleDashed, ClipboardList, FileDiff, ImagePlus, Link2, ListOrdered, Loader2, Navigation, Send, ShieldQuestion, Square, X, Zap } from 'lucide-react';
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
import { LightboxProvider, Zoomable } from '@/components/Lightbox';
import { fileOf, groupTools, inp, KIND, stat, summarizeTools, type ToolItem } from './toolSummary';
import { SideRail } from '@/components/SideRail';
import { WorkFolders } from '@/components/WorkFolders';
import { HostMark, hostName, VendorMark, vendorName, vendorOf } from '@/components/VendorMark';
import { t } from '@/i18n';

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

function ToolRow({ it, sessionId, children }: { it: Extract<ChatItem, { kind: 'tool' }>; sessionId?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const isAgent = it.name === 'Agent' || it.name === 'Task';
  const expandable = !!(it.result || it.patch?.length || children);
  return (
    <div className={cn('rounded-lg border', isAgent && 'border-agent/30')}>
      <button disabled={!expandable} onClick={() => setOpen(!open)} className={cn('flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default', open && 'bg-card sticky top-0 z-10 rounded-t-lg border-b')}>
        {it.status === 'running' ? (
          <Loader2 className="text-working size-3.5 shrink-0 animate-spin" />
        ) : it.status === 'error' ? (
          <X className="text-removed size-3.5 shrink-0" />
        ) : (
          <ToolIcon kind="tool" tool={it.name} className={cn('size-3.5 shrink-0', isAgent ? 'text-agent' : 'text-muted-foreground')} />
        )}
        <span className={cn('shrink-0 text-[12px] font-medium', isAgent && 'text-agent')}>{isAgent ? t('Sub-agent') : it.name}</span>
        <span className="text-muted-foreground truncate font-mono text-[12px]">{it.file ? base(it.file) : it.summary}</span>
        {it.elapsed !== undefined && it.status === 'running' && <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">{Math.round(it.elapsed)}s</span>}
        {it.patch && it.patch.length > 0 && (
          <span className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[11px]">
              <span className="text-added">+{it.patch.flatMap((h) => h.lines).filter((l) => l[0] === '+').length}</span>{' '}
              <span className="text-removed">−{it.patch.flatMap((h) => h.lines).filter((l) => l[0] === '-').length}</span>
            </span>
          </span>
        )}
        {expandable && (open ? <ChevronDown className="text-muted-foreground size-3.5 shrink-0" /> : <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />)}
      </button>
      {open && (
        <div>
          {children && <div className="flex flex-col gap-1.5 p-2 pl-4">{children}</div>}
          {it.patch && it.patch.length > 0 ? (
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
          ) : (
            !children && (
              <>
                <ToolInput it={it} />
                {it.result && (
                  <div className="border-t">
                    <div className="text-muted-foreground px-3 pt-1.5 text-[10.5px] font-medium tracking-wide uppercase">{t('Output')}</div>
                    <pre className="text-foreground/85 max-h-72 overflow-auto px-3 pt-1 pb-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.result}</pre>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
}

function StepLabel({ it }: { it: ToolItem }) {
  const i = inp(it);
  const strong = (s: string) => <span className="text-foreground font-medium">{s}</span>;
  switch (KIND(it.name)) {
    case 'read': {
      const off = Number(i.offset ?? 0);
      const lim = Number(i.limit ?? 0);
      return (
        <>
          {t('Read')} {strong(fileOf(it))} {off > 0 && lim > 0 && <span className="opacity-70">({off}–{off + lim})</span>}
        </>
      );
    }
    case 'edit':
      return (
        <>
          {it.name === 'Write' ? t('Wrote') : t('Edited')} {strong(fileOf(it))}
        </>
      );
    case 'run':
      return <span className="truncate">{String(i.description ?? '') || <span className="font-mono">{String(i.command ?? it.summary)}</span>}</span>;
    case 'search':
      return (
        <>
          {t('Searched')} <span className="font-mono">{it.summary}</span>
        </>
      );
    case 'fetch':
      return (
        <>
          {t('Fetched')} <span className="font-mono">{it.summary}</span>
        </>
      );
    default:
      return (
        <>
          {it.name} <span className="font-mono opacity-80">{it.summary}</span>
        </>
      );
  }
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
      {it.result && (
        <div className="border-t">
          <div className="text-muted-foreground px-3 pt-1.5 text-[10.5px] font-medium tracking-wide uppercase">{t('Output')}</div>
          <pre className="text-foreground/85 max-h-72 overflow-auto px-3 pt-1 pb-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.result}</pre>
        </div>
      )}
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

function ToolStep({ it, sessionId }: { it: ToolItem; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const { add, del } = stat(it);
  return (
    <div className="border-b last:border-b-0">
      <button onClick={() => setOpen(!open)} className={cn('hover:bg-accent/50 text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-[12.5px]', open && 'bg-card sticky top-0 z-10 border-b')}>
        {it.status === 'running' && <Loader2 className="text-working size-3 shrink-0 animate-spin" />}
        {it.status === 'error' && <X className="text-removed size-3 shrink-0" />}
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <StepLabel it={it} />
        </span>
        {(add > 0 || del > 0) && (
          <span className="font-mono text-[11.5px]">
            <span className="text-added">+{add}</span> <span className="text-removed">−{del}</span>
          </span>
        )}
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
      </button>
      {open && (
        <div className="bg-background/40">
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
  const total = items.reduce((a, i) => ({ add: a.add + stat(i).add, del: a.del + stat(i).del }), { add: 0, del: 0 });
  return (
    <div ref={box}>
      <button onClick={() => setOpen(!open)} className={cn('text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-left text-[13px]', open && 'bg-background sticky top-0 z-20 w-full py-1')}>
        {running && <span className="bg-working size-1.5 shrink-0 animate-pulse rounded-full" aria-label={t('Working…')} />}
        {failed && !running && <X className="text-removed size-3.5" />}
        <span>{summarizeTools(items)}</span>
        {(total.add > 0 || total.del > 0) && (
          <span className="font-mono text-[12px]">
            <span className="text-added">+{total.add}</span> <span className="text-removed">−{total.del}</span>
          </span>
        )}
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      {open && (
        <div className="bg-card mt-1.5 overflow-hidden rounded-lg border">
          {items.map((it) => (
            <ToolStep key={it.id} it={it} sessionId={sessionId} />
          ))}
        </div>
      )}
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

function PlanCard({ it }: { it: Extract<ChatItem, { kind: 'plan' }> }) {
  const [feedback, setFeedback] = useState('');
  const pending = it.status === 'pending';
  return (
    <Card className={cn('gap-0', pending && 'border-working/50')}>
      <CardContent className="flex flex-col gap-2 py-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="text-working size-4" />
          <span className="font-medium">{t('Proposed plan')}</span>
          {!pending && <Badge variant={it.status === 'approved' ? 'recent' : 'outline'}>{it.status}</Badge>}
        </div>
        <Markdown text={it.plan} className="bg-muted/40 rounded-md border px-3 py-1" />
        {pending && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => post({ type: 'respond', id: it.id, decision: 'allow' })}>
              <Check /> {t('Approve and start')}
            </Button>
            <input
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={t('What should change in the plan?')}
              className="bg-input min-w-48 flex-1 rounded-md border px-2.5 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            />
            <Button size="sm" variant="outline" onClick={() => post({ type: 'respond', id: it.id, decision: 'deny', message: feedback || 'Keep planning.' })}>
              {t('Keep planning')}
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
        it.text && <Markdown text={it.text} className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-1.5" />
      )}
      <div className="flex items-center gap-1">
        {!editing && it.forkAt && (
          <Button size="xs" variant="ghost" className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(true)} title={t('Edit this message and run the conversation again from here')} data-edit-prompt>
            <Pencil /> {t('Edit')}
          </Button>
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

function Item({ it, children, sessionId }: { it: ChatItem; children?: React.ReactNode; sessionId?: string }) {
  switch (it.kind) {
    case 'user':
      return <UserMessage it={it} />;
    case 'assistant':
      if (!it.text.trim() && !it.streaming) return null;
      return (
        <div className="group/answer flex gap-2.5">
          <AgentAvatar />
          <div className="min-w-0 flex-1">
            <Markdown text={it.text} />
            {it.streaming && <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />}
            {!it.streaming && (
              <div className="mt-0.5 flex gap-1 opacity-0 transition-opacity group-hover/answer:opacity-100 focus-within:opacity-100">
                <Button size="xs" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('steerhouse:quote', { detail: it.text }))} title={t('Quote this answer in your next message')} data-quote>
                  <Quote /> {t('Quote')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => navigator.clipboard?.writeText(it.text)} title={t('Copy')} aria-label={t('Copy')}>
                  <Copy />
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    case 'tool':
      return (
        <ToolRow it={it} sessionId={sessionId}>
          {children}
        </ToolRow>
      );
    case 'shell':
      return <ShellRow it={it} />;
    case 'permission':
      return <PermissionCard it={it} />;
    case 'plan':
      return <PlanCard it={it} />;
    case 'question':
      return <QuestionCard it={it} />;
    case 'result':
      return <div className="border-removed/40 bg-removed/10 text-removed rounded-lg border px-3 py-2 text-[12px]">{it.text}</div>;
    case 'system':
      return (
        <div className="text-muted-foreground flex items-center justify-center gap-1.5 text-[11px]">
          <Link2 className="size-3" />
          {it.text}
        </div>
      );
  }
}

/** A message waiting to be handed over: still editable, switchable and cancellable. */
function QueuedRow({ q }: { q: ChatState['queue'][number] }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q.text);
  const steer = q.priority === 'next';
  const Icon = steer ? Navigation : ListOrdered;
  const startEdit = () => {
    setText(q.text);
    setEditing(true);
  };
  const save = () => {
    if (text.trim() && text !== q.text) post({ type: 'editQueued', id: q.id, text });
    setEditing(false);
  };
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
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setText(q.text);
              setEditing(false);
            }
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
    case 'system':
    case 'result':
      return g.text;
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

  // Long chats: only rows near the viewport are in the DOM; heights are measured as they render.
  const rows = useMemo(() => groupTools(top), [top]);
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
    <LightboxProvider>
    <AgentCtx.Provider value={{ model: shownModel, host: chat.host, hostIcon: chat.hostIcon }}>
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <StateDot state={working ? 'working' : chat.status === 'idle' ? 'recent' : 'idle'} />
        <span className="inline-flex items-center gap-0.5" title={`${hostName(chat.host)}${chat.host ? ' + ' : ''}${vendorName(vendorOf(shownModel))}${chat.model ? ' · ' + chat.model : ''}`}>
          <HostMark host={chat.host} icon={chat.hostIcon} />
          {chat.host && <span className="text-muted-foreground text-[10px]">+</span>}
          <VendorMark vendor={vendorOf(shownModel)} />
        </span>
        <h1 className="min-w-0 truncate text-[14px] font-semibold">{chat.title}</h1>
        <WorkFolders chat={chat} />
        <span className="flex-1" />
        {chat.status === 'starting' && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11.5px]" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {t('Starting Claude Code…')}
          </span>
        )}
        <span
          className="text-muted-foreground inline-flex max-w-64 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px]"
          title={[chat.account.email, chat.account.organization, chat.account.plan, chat.account.provider].filter(Boolean).join(' · ')}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{chat.account.email ?? chat.account.name}</span>
          {chat.account.plan && <span className="opacity-70">· {chat.account.plan}</span>}
        </span>
        {chat.costUsd > 0 && (
          <span className="text-muted-foreground text-[11px] tabular-nums" title={t('Tokens and API-equivalent cost of this chat')}>
            {chat.tokens ? `${chat.tokens >= 1e6 ? (chat.tokens / 1e6).toFixed(1) + 'M' : (chat.tokens / 1e3).toFixed(1) + 'k'} ${t('tokens')} · ` : ''}${chat.costUsd.toFixed(2)}
          </span>
        )}
        <Button size="xs" variant="ghost" onClick={() => (setSearchOpen((o) => !o), requestAnimationFrame(() => searchInput.current?.focus()))} title={t('Search (Ctrl+F)')} aria-label={t('Search')}>
          <Search />
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
      <div
        ref={scroller}
        className="min-w-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          setAtBottom(stick.current);
        }}
      >
        <div className="mx-auto flex max-w-[860px] flex-col gap-1 px-4 py-4">
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
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={cn('absolute left-0 w-full pb-3', matchSet.has(v.index) && 'search-hit', v.index === current && 'search-current')} style={{ top: v.start }}>
                  {Array.isArray(g) ? (
                    <ToolGroup items={g} sessionId={chat.sessionId} />
                  ) : (
                    <Item it={g} sessionId={chat.sessionId}>
                      {g.kind === 'tool' && byParent.get(g.id)?.map((c) => <Item key={c.id} it={c} sessionId={chat.sessionId} />)}
                    </Item>
                  )}
                </div>
              );
            })}
          </div>
          {!working && top.some((i) => i.kind === 'user') && ['assistant', 'result', 'tool'].includes(top.at(-1)?.kind ?? '') && (
            <div className="-mt-1 flex justify-start pl-7">
              <Button size="xs" variant="ghost" onClick={() => post({ type: 'retry' })} title={t('Send your last message again')}>
                <RotateCcw /> {t('Try again')}
              </Button>
            </div>
          )}
          {chat.error && <div className="border-removed/40 bg-removed/10 text-removed rounded-lg border px-3 py-2 text-[12px]">{chat.error}</div>}
          <div ref={end} />
        </div>
      </div>
      <SideRail chat={chat} />
      </div>

      <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-2 px-4 pt-1 pb-3">
        {!atBottom && (
          <button
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
              requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end' }));
            }}
            className="bg-popover text-popover-foreground hover:bg-accent absolute -top-11 left-1/2 z-30 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-[11.5px] shadow-md"
            aria-label={t('Jump to latest')}
          >
            <ChevronDown className="size-3.5" /> {t('Jump to latest')}
          </button>
        )}
        <TodoCard todos={chat.todos} />
        {working && chat.activity && (
          <div className="text-muted-foreground flex items-center gap-2 px-1 text-[12px]" role="status">
            <Loader2 className="text-working size-3.5 animate-spin" />
            <span className="truncate">{chat.activity}</span>
            <span className="ml-auto text-[11px] opacity-70">{t('Esc to stop')}</span>
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
    </div>
    </AgentCtx.Provider>
    </LightboxProvider>
  );
}
