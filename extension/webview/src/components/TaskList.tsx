// Commands the agent left running (dev servers, watchers, long tests): status, live output while
// open, the local URLs a dev server printed, and Stop / Follow in terminal / Open output.
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleHelp, ExternalLink, Loader2, Square, SquareTerminal, TerminalSquare, X } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { BgTaskView } from '@/types';

const LOOK: Record<BgTaskView['status'], { icon: typeof Check; color: string; label: string; spin?: boolean }> = {
  running: { icon: Loader2, color: 'var(--working)', label: 'running', spin: true },
  completed: { icon: Check, color: 'var(--recent)', label: 'done' },
  failed: { icon: X, color: 'var(--removed)', label: 'failed' },
  stopped: { icon: Square, color: 'var(--muted-foreground)', label: 'stopped' },
  unknown: { icon: CircleHelp, color: 'var(--muted-foreground)', label: 'maybe stopped' },
};

const ago = (iso?: string) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 1 ? t('now') : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** Output of one task, asked from the extension every 1.5 s while it is open and running. */
function useOutput(id: string, open: boolean, running: boolean) {
  const [out, setOut] = useState<{ text: string; size: number; urls: string[]; missing?: boolean }>();
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'taskOutputResult' && e.data.id === id && setOut({ text: e.data.text, size: e.data.size, urls: e.data.urls ?? [], missing: e.data.missing });
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [id]);
  useEffect(() => {
    if (!open) return;
    post({ type: 'taskOutput', id });
    if (!running) return;
    const timer = setInterval(() => post({ type: 'taskOutput', id }), 1500);
    return () => clearInterval(timer);
  }, [open, running, id]);
  return out;
}

function TaskRow({ task, canStop }: { task: BgTaskView; canStop: boolean }) {
  const running = task.status === 'running';
  const [open, setOpen] = useState(running);
  const out = useOutput(task.id, open, running);
  const pre = useRef<HTMLPreElement>(null);
  // keep following the end of the output, like a terminal
  useEffect(() => {
    const el = pre.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [out?.text]);
  const L = LOOK[task.status];
  // a finished command's temporary output file gets cleaned up; a running one may not have written yet
  const gone = !running && !!out?.missing;
  return (
    <li className="border-b last:border-b-0" data-task={task.id} data-status={task.status}>
      <button className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-left text-[12px]" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight className={cn('text-muted-foreground size-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <L.icon className={cn('size-3.5 shrink-0', L.spin && 'animate-spin')} style={{ color: L.color }} aria-label={t(L.label)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{task.description || task.command}</span>
          {task.description && <span className="text-muted-foreground block truncate font-mono text-[11px]">{task.command}</span>}
        </span>
        <span className="text-muted-foreground shrink-0 text-[11px]">
          {t(L.label)}
          {task.started ? ` · ${ago(task.started)}` : ''}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 px-1.5 pb-2 pl-6">
          {!!out?.urls.length && (
            <div className="flex flex-wrap gap-1">
              {out.urls.slice(-3).map((u) => (
                <a key={u} href={u} className="bg-accent hover:bg-accent/70 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]" data-task-url>
                  <ExternalLink className="size-3" /> {u}
                </a>
              ))}
            </div>
          )}
          <pre ref={pre} className="bg-muted max-h-56 overflow-auto rounded-md p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap" data-task-output>
            {gone ? t('The output is no longer available: its temporary file was removed.') : out ? out.text || t('No output yet.') : t('Loading…')}
          </pre>
          <div className="flex flex-wrap items-center gap-1">
            {running && canStop && (
              <button className="text-removed hover:bg-removed/10 inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]" onClick={() => post({ type: 'stopTask', id: task.id })} data-task-stop>
                <Square className="size-3" /> {t('Stop')}
              </button>
            )}
            {!gone && (
              <>
            <button className="hover:bg-accent inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]" onClick={() => post({ type: 'followTask', id: task.id })} title={t('Watch the output in a terminal as it is written')} data-task-follow>
              <TerminalSquare className="size-3" /> {t('Follow in terminal')}
            </button>
            <button className="hover:bg-accent inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px]" onClick={() => post({ type: 'openTaskFile', id: task.id })}>
              {t('Open output')}
            </button>
              </>
            )}
            {out && <span className="text-muted-foreground ml-auto text-[10.5px] tabular-nums">{out.size >= 1024 ? `${Math.round(out.size / 1024)} KB` : `${out.size} B`}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

export function TaskList({ tasks, canStop }: { tasks: BgTaskView[]; canStop: boolean }) {
  const sorted = [...tasks].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.started ?? '').localeCompare(a.started ?? ''));
  return <ul className="flex flex-col">{sorted.map((task) => <TaskRow key={task.id} task={task} canStop={canStop} />)}</ul>;
}

export function TaskRailIcon({ running }: { running: number }) {
  return <SquareTerminal className="size-4" style={running ? { color: 'var(--working)' } : undefined} />;
}
