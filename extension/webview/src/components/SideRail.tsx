// Slim rail on the right of the chat: the context window as a vertical gauge, the Changes
// panel (per-turn diffs, git actions), background commands, and the PRs it opened.
import { useMemo } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { PrList, PrRailIcon } from '@/components/PrList';
import { TaskList, TaskRailIcon } from '@/components/TaskList';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { ContextPanel } from '@/components/ContextPanel';
import { ChangesPanel } from '@/components/ChangesPanel';
import { findPRs } from '@/views/toolSummary';
import type { ChatState } from '@/types';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function Pop({ label, icon, count, children }: { label: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent relative grid size-7 cursor-pointer place-items-center rounded-md" aria-label={`${label} (${count})`} title={`${label} (${count})`}>
          {icon}
          <span className="bg-muted text-foreground absolute -right-0.5 -bottom-0.5 min-w-3.5 rounded-full px-1 text-center text-[9px] leading-3.5 tabular-nums">{count}</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content side="left" align="start" sideOffset={8} className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 max-h-[70vh] w-[min(30rem,calc(100vw-5rem))] overflow-y-auto rounded-xl border p-3 shadow-xl">
          <div className="mb-2 font-semibold">{label}</div>
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function SideRail({ chat }: { chat: ChatState }) {
  const prs = useMemo(() => findPRs(chat.items as never), [chat.items]);
  const c = chat.context;
  const pct = c ? Math.min(100, Math.max(0, c.percentage)) : 0;
  const color = pct >= 85 ? 'var(--removed)' : pct >= 65 ? 'var(--warn)' : 'var(--working)';
  const ctxLabel = c ? `${t('Context')}: ${fmt(c.used)} / ${fmt(c.max)} ${t('tokens')} (${Math.round(pct)}%)` : t('Context');

  return (
    <aside className="flex w-9 shrink-0 flex-col items-center gap-1.5 border-l py-2" aria-label={t('Session details')}>
      <ContextPanel chat={chat} side="left" className="h-28 w-7 py-1">
        <span className="flex h-full flex-col items-center gap-1" title={ctxLabel}>
          <span className="bg-muted relative w-1.5 flex-1 overflow-hidden rounded-full" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={ctxLabel}>
            <span className="absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-500" style={{ height: `${pct}%`, background: color }} />
          </span>
          <span className="text-muted-foreground text-[9px] tabular-nums">{c ? `${Math.round(pct)}%` : '–'}</span>
        </span>
      </ContextPanel>

      <ChangesPanel chat={chat} />

      {!!chat.tasks?.length && (
        <Pop label={t('Background commands')} icon={<TaskRailIcon running={chat.tasks.filter((x) => x.status === 'running').length} />} count={chat.tasks.filter((x) => x.status === 'running').length || chat.tasks.length}>
          <TaskList tasks={chat.tasks} canStop={chat.status !== 'closed'} />
        </Pop>
      )}
      {prs.length > 0 && (
        <Pop label={t('Pull requests')} icon={<PrRailIcon st={chat.prs?.[prs.at(-1)!.url]} />} count={prs.length}>
          <PrList prs={prs} status={chat.prs} />
        </Pop>
      )}
    </aside>
  );
}
