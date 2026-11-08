import { Ban, Bot, ChevronUp, RotateCcw, UserRound, Check, ChevronDown, ChevronRight, CircleDashed, ClipboardList, FileDiff, ImagePlus, Link2, ListOrdered, Loader2, Navigation, Send, ShieldQuestion, Square, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { post as postAny } from '@/bridge';
import { StateDot, ToolIcon } from '@/components/common';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { base, cn } from '@/lib/utils';
import type { ChatData, ChatItem, ChatState, Effort, PermissionMode, Priority, Question, ToChat, Todo } from '@/types';
import { HunkView } from './Session';
import { t } from '@/i18n';

const post = (m: ToChat) => postAny(m as never);

const PRIORITY: Record<Priority, { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = {
  later: { label: t('Queue'), icon: ListOrdered, hint: t('Sent when the current turn ends') },
  next: { label: t('Steer'), icon: Navigation, hint: t('Picked up at its next step, without stopping') },
  now: { label: t('Send now'), icon: Zap, hint: t('Sent immediately') },
};

const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: t('Ask before acting') },
  { value: 'acceptEdits', label: t('Accept edits') },
  { value: 'plan', label: t('Plan mode') },
  { value: 'auto', label: t('Auto') },
  { value: 'bypassPermissions', label: t('Bypass permissions') },
];

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
                    <pre className="text-muted-foreground max-h-72 overflow-auto px-3 pt-1 pb-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.result}</pre>
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

// ---------------------------------------------------------------- grouped tool calls ("Read and edited chat.ts, ran 1 command")

type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
const stat = (it: ToolItem) => {
  const lines = (it.patch ?? []).flatMap((h) => h.lines);
  return { add: lines.filter((l) => l[0] === '+').length, del: lines.filter((l) => l[0] === '-').length };
};
const fileOf = (it: ToolItem) => (it.file ? base(it.file) : '');
const inp = (it: ToolItem) => (it.input ?? {}) as Record<string, unknown>;
const KIND = (n: string) =>
  n === 'Read' ? 'read' : n === 'Edit' || n === 'MultiEdit' || n === 'Write' || n === 'NotebookEdit' ? 'edit' : n === 'Bash' || n === 'PowerShell' ? 'run' : n === 'Grep' || n === 'Glob' || n === 'WebSearch' ? 'search' : n === 'WebFetch' ? 'fetch' : 'other';

/** One sentence for a run of tool calls, e.g. "Read and edited chat.ts, ran 1 command". */
export function summarizeTools(items: ToolItem[]): string {
  const files = (k: string) => [...new Set(items.filter((i) => KIND(i.name) === k).map(fileOf).filter(Boolean))];
  const count = (k: string) => items.filter((i) => KIND(i.name) === k).length;
  const read = files('read');
  const edited = files('edit');
  const parts: string[] = [];
  const one = (list: string[], single: string, many: string) => (list.length === 1 ? t(single, list[0]) : t(many, list.length));
  if (read.length && edited.length && read.length === 1 && edited.length === 1 && read[0] === edited[0]) parts.push(t('read and edited {0}', read[0]));
  else {
    if (read.length) parts.push(one(read, 'read {0}', 'read {0} files'));
    if (edited.length) parts.push(one(edited, 'edited {0}', 'edited {0} files'));
  }
  const n = (k: string, s: string, p: string) => count(k) && parts.push(count(k) === 1 ? t(s) : t(p, count(k)));
  n('run', 'ran 1 command', 'ran {0} commands');
  n('search', 'searched once', 'searched {0} times');
  n('fetch', 'fetched 1 page', 'fetched {0} pages');
  n('other', 'used 1 tool', 'used {0} tools');
  const s = parts.join(', ');
  return s.charAt(0).toUpperCase() + s.slice(1);
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
          <pre className="text-muted-foreground max-h-72 overflow-auto px-3 pt-1 pb-2 font-mono text-[11.5px] whitespace-pre-wrap">{it.result}</pre>
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
  const running = items.some((i) => i.status === 'running');
  const failed = items.some((i) => i.status === 'error');
  const total = items.reduce((a, i) => ({ add: a.add + stat(i).add, del: a.del + stat(i).del }), { add: 0, del: 0 });
  return (
    <div>
      <button onClick={() => setOpen(!open)} className={cn('text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-left text-[13px]', open && 'bg-background sticky top-0 z-20 w-full py-1')}>
        {running && <Loader2 className="text-working size-3.5 animate-spin" />}
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

function Item({ it, children, sessionId }: { it: ChatItem; children?: React.ReactNode; sessionId?: string }) {
  switch (it.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1">
          {it.images.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {it.images.map((src, i) => (
                <img key={i} src={src} alt="" className="h-20 rounded-md border object-cover" />
              ))}
            </div>
          )}
          {it.text && <Markdown text={it.text} className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-1.5" />}
          {it.priority && it.priority !== 'later' && (
            <span className="text-muted-foreground opacity-60" title={`${PRIORITY[it.priority].label}: ${PRIORITY[it.priority].hint}`} aria-label={PRIORITY[it.priority].label}>
              {(() => {
                const I = PRIORITY[it.priority].icon;
                return <I className="size-3" />;
              })()}
            </span>
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="flex gap-2.5">
          <div className="bg-primary text-primary-foreground mt-0.5 grid size-5 shrink-0 place-items-center rounded-md">
            <Bot className="size-3" />
          </div>
          <div className="min-w-0 flex-1">
            <Markdown text={it.text} />
            {it.streaming && <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />}
          </div>
        </div>
      );
    case 'tool':
      return (
        <ToolRow it={it} sessionId={sessionId}>
          {children}
        </ToolRow>
      );
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

// ---------------------------------------------------------------- composer

type Img = { data: string; mime: string };
const readImage = (f: File) =>
  new Promise<Img>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ data: String(r.result), mime: f.type || 'image/png' });
    r.onerror = bad;
    r.readAsDataURL(f);
  });

function Composer({ chat }: { chat: ChatState }) {
  const working = chat.status === 'working' || chat.status === 'waiting';
  const [text, setText] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [priority, setPriority] = useState<Priority>('next'); // Steer by default
  const [over, setOver] = useState(false);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const slash = text.startsWith('/') && !text.includes(' ') ? chat.slashCommands.filter((c) => `/${c}`.startsWith(text)).slice(0, 8) : [];

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) {
      const read = await Promise.all(imgs.map(readImage));
      setImages((p) => [...p, ...read]);
    }
  };
  const send = (p: Priority = priority) => {
    if (!text.trim() && !images.length) return;
    post({ type: 'send', text, images, priority: working ? p : 'later' });
    setText('');
    setImages([]);
  };

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className={cn('bg-card focus-within:border-ring flex flex-col gap-2 rounded-xl border p-2.5 shadow-sm transition-colors', over && 'border-ring')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      {slash.length > 0 && (
        <div className="flex flex-col overflow-hidden rounded-md border">
          {slash.map((c, i) => (
            <button
              key={c}
              onMouseDown={(e) => {
                e.preventDefault();
                setText(`/${c} `);
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
              <img src={img.data} alt="" className="h-14 rounded-md border object-cover" />
              <button
                onClick={() => setImages(images.filter((_, j) => j !== i))}
                className="bg-background absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full border opacity-0 group-hover:opacity-100"
                aria-label="Remove image"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <Textarea
        ref={ref}
        value={text}
        rows={2}
        onChange={(e) => {
          setText(e.target.value);
          setSel(0);
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
          if (files.length) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (slash.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length);
          } else if (slash.length && e.key === 'Tab') {
            e.preventDefault();
            setText(`/${slash[sel]} `);
          } else if (e.key === 'Escape' && working) {
            e.preventDefault();
            post({ type: 'interrupt' });
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send(e.ctrlKey || e.metaKey ? 'now' : priority);
          }
        }}
        placeholder={working ? t('Message the agent while it works…  (Enter steers it, Ctrl+Enter sends now)') : t('Ask, plan, or give a task…  (/ for commands, paste or drop images)')}
        className="max-h-60 min-h-12 resize-none border-0 bg-transparent px-1 shadow-none outline-none focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-[11px]">
          <ImagePlus className="size-3.5" />
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles([...(e.target.files ?? [])])} />
          {t('Image')}
        </label>
        <select
          value={chat.permissionMode}
          onChange={(e) => post({ type: 'setMode', mode: e.target.value as PermissionMode })}
          className="bg-input text-muted-foreground h-6 cursor-pointer rounded-md border px-1.5 text-[11px] outline-none"
          aria-label="Permission mode"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        {chat.models.length > 0 && (
          <select
            value={chat.models.some((m) => m.value === chat.model) ? chat.model : ''}
            onChange={(e) => post({ type: 'setModel', model: e.target.value })}
            className="bg-input text-muted-foreground h-6 max-w-44 cursor-pointer rounded-md border px-1.5 text-[11px] outline-none"
            aria-label="Model"
          >
            {!chat.models.some((m) => m.value === chat.model) && <option value="">{chat.model ?? 'Default model'}</option>}
            {chat.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          </select>
        )}
        <select
          value={chat.effort ?? ''}
          onChange={(e) => post({ type: 'setEffort', effort: e.target.value as Effort })}
          className="bg-input text-muted-foreground h-6 cursor-pointer rounded-md border px-1.5 text-[11px] outline-none"
          aria-label="Effort"
          title="How hard the model thinks. Higher is slower and costs more."
        >
          {!chat.effort && <option value="">{t('Effort: default')}</option>}
          {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((e) => (
            <option key={e} value={e}>{t('Effort: {0}', e)}</option>
          ))}
        </select>
        <button
          onClick={() => post({ type: 'setFast', on: !chat.fastMode })}
          title="Fast mode: same model, faster output, premium pricing (supported models only)"
          className={cn('inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px]', chat.fastMode ? 'border-warn/60 bg-warn/10 text-warn' : 'text-muted-foreground hover:text-foreground')}
        >
          <Zap className="size-3" /> {t('Fast')}
        </button>
        <button
          onClick={() => post({ type: 'setUltracode', on: !chat.ultracode })}
          title="Ultracode: the agent orchestrates multi-agent workflows for big tasks (supported models only; uses more tokens)"
          className={cn('inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px]', chat.ultracode ? 'border-agent/60 bg-agent/10 text-agent' : 'text-muted-foreground hover:text-foreground')}
        >
          <Bot className="size-3" /> Ultracode
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          {working && (
            <div className="bg-muted inline-flex rounded-lg p-[3px]" role="radiogroup" aria-label="Delivery">
              {(Object.keys(PRIORITY) as Priority[]).map((p) => {
                const I = PRIORITY[p].icon;
                return (
                  <button
                    key={p}
                    role="radio"
                    aria-checked={priority === p}
                    title={PRIORITY[p].hint}
                    onClick={() => setPriority(p)}
                    className={cn(
                      'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium',
                      priority === p ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <I className="size-3" />
                    {PRIORITY[p].label}
                  </button>
                );
              })}
            </div>
          )}
          {working && (
            <Button size="sm" variant="outline" onClick={() => post({ type: 'interrupt' })} title="Stop (Esc)">
              <Square className="fill-current" /> {t('Stop')}
            </Button>
          )}
          <Button size="sm" onClick={() => send()} disabled={!text.trim() && !images.length}>
            {working ? (
              <>
                {(() => {
                  const I = PRIORITY[priority].icon;
                  return <I />;
                })()}
                {PRIORITY[priority].label}
              </>
            ) : (
              <>
                <Send /> {t('Send')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Consecutive plain tool calls become one group; sub-agents keep their own row (they nest their steps). */
export function groupTools(items: ChatItem[]): (ChatItem | ToolItem[])[] {
  const out: (ChatItem | ToolItem[])[] = [];
  for (const it of items) {
    const groupable = it.kind === 'tool' && it.name !== 'Agent' && it.name !== 'Task' && it.name !== 'TodoWrite';
    const last = out.at(-1);
    if (groupable && Array.isArray(last)) last.push(it as ToolItem);
    else if (groupable) out.push([it as ToolItem]);
    else if (!(it.kind === 'tool' && it.name === 'TodoWrite')) out.push(it); // the plan card already shows TodoWrite
  }
  return out;
}

// ---------------------------------------------------------------- page

export function ChatView({ data }: { data: ChatData }) {
  const { chat, linked } = data;
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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

  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: 'end' });
  }, [chat.items, chat.activity]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <StateDot state={working ? 'working' : chat.status === 'idle' ? 'recent' : 'idle'} />
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title}</h1>
        <span
          className="text-muted-foreground inline-flex max-w-64 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px]"
          title={[chat.account.email, chat.account.organization, chat.account.plan, chat.account.provider].filter(Boolean).join(' · ')}
        >
          <UserRound className="size-3 shrink-0" />
          <span className="truncate">{chat.account.email ?? chat.account.name}</span>
          {chat.account.plan && <span className="opacity-70">· {chat.account.plan}</span>}
        </span>
        {chat.costUsd > 0 && <span className="text-muted-foreground text-[11px] tabular-nums">${chat.costUsd.toFixed(2)}</span>}
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'link' })} title="Let this agent see what another session is doing">
          <Link2 /> {t('Link session')}
        </Button>
      </header>
      {linked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5">
          <span className="text-muted-foreground text-[11px]">{t('Linked:')}</span>
          {linked.map((l) => (
            <span key={l.id} className="group inline-flex items-center gap-1.5 rounded-md border py-0.5 pr-1 pl-2 text-[11px]">
              <StateDot state={l.state} className="size-2" />
              <button className="max-w-56 cursor-pointer truncate hover:underline" title={l.activity} onClick={() => post({ type: 'openSession', id: l.id })}>
                {l.title}
              </button>
              <button className="text-muted-foreground hover:text-foreground cursor-pointer opacity-0 group-hover:opacity-100" onClick={() => post({ type: 'unlink', id: l.id })} aria-label="Unlink">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-4 py-4">
          {!top.length && (
            <div className="text-muted-foreground py-16 text-center">
              <Bot className="mx-auto mb-3 size-8 opacity-60" />
              <div className="text-foreground text-[15px] font-medium">{t('What should we build?')}</div>
              <div className="mt-1 text-[12px]">{chat.cwd}</div>
            </div>
          )}
          {groupTools(top).map((g) =>
            Array.isArray(g) ? (
              <ToolGroup key={g[0].id} items={g} sessionId={chat.sessionId} />
            ) : (
              <Item key={g.id} it={g} sessionId={chat.sessionId}>
                {g.kind === 'tool' && byParent.get(g.id)?.map((c) => <Item key={c.id} it={c} sessionId={chat.sessionId} />)}
              </Item>
            ),
          )}
          {!working && top.some((i) => i.kind === 'user') && ['assistant', 'result', 'tool'].includes(top.at(-1)?.kind ?? '') && (
            <div className="-mt-1 flex justify-start pl-7">
              <Button size="xs" variant="ghost" onClick={() => post({ type: 'retry' })} title="Send your last message again">
                <RotateCcw /> {t('Try again')}
              </Button>
            </div>
          )}
          {chat.error && <div className="border-removed/40 bg-removed/10 text-removed rounded-lg border px-3 py-2 text-[12px]">{chat.error}</div>}
          <div ref={end} />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2 px-4 pt-1 pb-3">
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
              <div key={q.id} className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-[12px]">
                <ListOrdered className="text-muted-foreground size-3.5 shrink-0" />
                <span className="truncate">{q.text || `${q.images} image(s)`}</span>
                <span className="text-muted-foreground shrink-0 text-[11px]">{t('queued')}</span>
                <div className="ml-auto flex shrink-0 gap-1">
                  <Button size="xs" variant="ghost" onClick={() => post({ type: 'promote', id: q.id, priority: 'next' })} title={t('Steer')}>
                    <Navigation />
                  </Button>
                  <Button size="xs" variant="secondary" onClick={() => post({ type: 'promote', id: q.id, priority: 'now' })} title={t('Send now')}>
                    <Zap />
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => post({ type: 'cancelQueued', id: q.id })} aria-label="Remove from queue">
                    <X />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Composer chat={chat} />
      </div>
    </div>
  );
}
