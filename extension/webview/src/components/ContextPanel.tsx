// Context window breakdown, like Claude's /context: 100 squares (1% each) colored by category,
// plus tokens and share per category. Opening it asks the CLI for an exact count.
import { Popover as PopoverPrimitive } from 'radix-ui';
import { Loader2 } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatState } from '@/types';

type Cat = NonNullable<NonNullable<ChatState['context']>['categories']>[number];

const COLOR: Record<string, string> = {
  system_prompt: '#9ca3af',
  system_tools: '#64748b',
  mcp_tools: 'var(--working)',
  mcp_instructions: '#22d3ee',
  custom_agents: '#f472b6',
  memory_files: 'var(--warn)',
  skills: '#eab308',
  messages: 'var(--agent)',
};
const colorOf = (c: Cat) => COLOR[c.id ?? ''] ?? (c.kind === 'used' ? 'var(--recent)' : 'var(--muted-foreground)');
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function cells(ctx: NonNullable<ChatState['context']>): { cat?: Cat; style: 'used' | 'deferred' | 'buffer' | 'free' }[] {
  const cats = ctx.categories ?? [];
  const per = ctx.max / 100;
  const out: { cat?: Cat; style: 'used' | 'deferred' | 'buffer' | 'free' }[] = [];
  const push = (list: Cat[], style: 'used' | 'deferred' | 'buffer') => {
    for (const c of list) {
      const n = Math.max(c.tokens > 0 && style === 'used' ? 1 : 0, Math.round(c.tokens / per));
      for (let i = 0; i < n && out.length < 100; i++) out.push({ cat: c, style });
    }
  };
  push(cats.filter((c) => c.kind === 'used'), 'used');
  push(cats.filter((c) => c.kind === 'deferred'), 'deferred');
  const buffers = cats.filter((c) => c.kind === 'buffer');
  const bufferCells = Math.min(100 - out.length, buffers.reduce((n, c) => n + Math.round(c.tokens / per), 0));
  while (out.length < 100 - bufferCells) out.push({ style: 'free' });
  push(buffers, 'buffer');
  while (out.length < 100) out.push({ style: 'free' });
  return out;
}

export function ContextPanel({ chat, children }: { chat: ChatState; children: React.ReactNode }) {
  return (
    <PopoverPrimitive.Root onOpenChange={(open) => open && chat.status !== 'starting' && post({ type: 'contextDetail' } as never)}>
      <PopoverPrimitive.Trigger asChild>
        <button className="hover:bg-accent grid size-7 cursor-pointer place-items-center rounded-md" aria-label={t('Context')}>
          {children}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content side="top" align="end" sideOffset={8} className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 w-[22rem] rounded-xl border p-3.5 shadow-xl">
          <Body chat={chat} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Body({ chat }: { chat: ChatState }) {
  const ctx = chat.context;
  if (!ctx) return <div className="text-muted-foreground text-[12px]">{t('Context usage appears after the first answer')}</div>;
  const grid = cells(ctx);
  const cats = (ctx.categories ?? []).slice().sort((a, b) => Number(a.kind === 'free') - Number(b.kind === 'free') || b.tokens - a.tokens);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{t('Context')}</span>
        <span className="text-muted-foreground text-[12px] tabular-nums">
          {fmt(ctx.used)} / {fmt(ctx.max)} {t('tokens')} · {Math.round(ctx.percentage)}%
        </span>
        {!ctx.detailed && <Loader2 className="text-muted-foreground ml-auto size-3.5 animate-spin" aria-label={t('Counting…')} />}
      </div>
      <div className="grid grid-cols-10 gap-[3px]" role="img" aria-label={t('Context window map')}>
        {grid.map((c, i) => (
          <span
            key={i}
            title={c.cat ? `${c.cat.name}: ${fmt(c.cat.tokens)}` : t('Free space')}
            className={cn('aspect-square rounded-[3px]', c.style === 'free' && 'bg-muted', c.style === 'deferred' && 'border', c.style === 'buffer' && 'opacity-60')}
            style={
              c.style === 'used'
                ? { background: colorOf(c.cat!) }
                : c.style === 'deferred'
                  ? { borderColor: colorOf(c.cat!) }
                  : c.style === 'buffer'
                    ? { background: 'repeating-linear-gradient(45deg, var(--muted-foreground) 0 2px, transparent 2px 5px)' }
                    : undefined
            }
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {cats.map((c) => (
          <div key={(c.id ?? '') + c.name} className="flex items-center gap-2 text-[12px]">
            <span
              className={cn('size-2.5 shrink-0 rounded-[3px]', c.kind === 'free' && 'bg-muted', c.kind === 'deferred' && 'border')}
              style={c.kind === 'used' ? { background: colorOf(c) } : c.kind === 'deferred' ? { borderColor: colorOf(c) } : c.kind === 'buffer' ? { background: 'repeating-linear-gradient(45deg, var(--muted-foreground) 0 2px, transparent 2px 4px)' } : undefined}
            />
            <span className="min-w-0 flex-1 truncate">
              {c.name}
              {c.kind === 'deferred' && <span className="text-muted-foreground"> · {t('loaded on demand')}</span>}
            </span>
            <span className="text-muted-foreground tabular-nums">{fmt(c.tokens)}</span>
            <span className="w-10 text-right tabular-nums">{((c.tokens / ctx.max) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
      {ctx.percentage >= 65 && <div className="text-warn text-[11.5px]">{t('Long context: consider /compact')}</div>}
    </div>
  );
}
