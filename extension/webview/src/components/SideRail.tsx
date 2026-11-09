// Slim rail on the right of the chat: the context window as a vertical gauge, the files the agent
// changed grouped by project (one chat can touch several repos), and the PRs it opened.
import { useMemo } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { FileDiff, GitPullRequest } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { ContextPanel } from '@/components/ContextPanel';
import { changesByProject, findPRs } from '@/views/toolSummary';
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
        <PopoverPrimitive.Content side="left" align="start" sideOffset={8} className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 max-h-[70vh] w-[22rem] overflow-y-auto rounded-xl border p-3 shadow-xl">
          <div className="mb-2 font-semibold">{label}</div>
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function SideRail({ chat }: { chat: ChatState }) {
  const prs = useMemo(() => findPRs(chat.items as never), [chat.items]);
  const projects = useMemo(() => changesByProject(chat.items as never, chat.cwd), [chat.items, chat.cwd]);
  const files = projects.reduce((n, p) => n + p.files.length, 0);
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

      {files > 0 && (
        <Pop label={projects.length > 1 ? t('Changes in {0} projects', projects.length) : t('Changes')} icon={<FileDiff className="size-4" />} count={files}>
          <div className="flex flex-col gap-3">
            {projects.map((p) => (
              <div key={p.root}>
                <div className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-[10.5px]" title={p.root}>
                    {p.root}
                  </span>
                </div>
                <ul className="mt-1 flex flex-col">
                  {p.files.map((f) => (
                    <li key={f.path}>
                      <button className="hover:bg-accent flex w-full cursor-pointer items-baseline gap-2 rounded px-1.5 py-0.5 text-left font-mono text-[11.5px]" onClick={() => post({ type: 'openFile', path: f.path })} title={f.path}>
                        <span className="min-w-0 flex-1 truncate">{f.rel}</span>
                        {f.added > 0 && <span className="text-added tabular-nums">+{f.added}</span>}
                        {f.removed > 0 && <span className="text-removed tabular-nums">−{f.removed}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Pop>
      )}

      {prs.length > 0 && (
        <Pop label={t('Pull requests')} icon={<GitPullRequest className="size-4" />} count={prs.length}>
          <ul className="flex flex-col">
            {prs.map((pr) => (
              <li key={pr.url}>
                <a href={pr.url} className="hover:bg-accent flex items-center gap-2 rounded px-1.5 py-1 text-[12px]" title={pr.url}>
                  <GitPullRequest className="text-recent size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{pr.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </Pop>
      )}
    </aside>
  );
}
