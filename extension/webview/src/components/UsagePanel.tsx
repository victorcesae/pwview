// Subscription usage by the input: a ring for the current 5-hour session (or the busiest window),
// and on click every window with its reset time, like Claude's /usage. Providers with a usage API
// (OpenRouter keys) show their credit; API keys show what this chat cost.
import { Popover as PopoverPrimitive } from 'radix-ui';
import { t } from '@/i18n';
import type { ChatState, LimitWindow } from '@/types';

const colorFor = (pct: number) => (pct >= 90 ? 'var(--removed)' : pct >= 70 ? 'var(--warn)' : 'var(--working)');

function resetIn(iso?: string): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return t('resets soon');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 24) return t('resets {0}', new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
  return t('resets in {0}', h ? `${h}h ${m}m` : `${m}m`);
}

/** The window the ring shows: the current session, else whichever is closest to its limit. */
export function mainWindow(chat: ChatState): LimitWindow | undefined {
  const ws = chat.limits?.windows ?? [];
  return ws.find((w) => w.id === 'five_hour') ?? ws.slice().sort((a, b) => b.pct - a.pct)[0];
}

export function UsageRing({ chat }: { chat: ChatState }) {
  const w = mainWindow(chat);
  const pct = w ? Math.min(100, Math.max(0, w.pct)) : 0;
  const R = 8;
  const C = 2 * Math.PI * R;
  return (
    <svg viewBox="0 0 20 20" className="size-5 -rotate-90" aria-hidden>
      <circle cx={10} cy={10} r={R} fill="none" stroke="var(--border)" strokeWidth={2.5} />
      {w && <circle cx={10} cy={10} r={R} fill="none" stroke={colorFor(pct)} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`} className="transition-[stroke-dasharray] duration-500" />}
    </svg>
  );
}

export function UsagePanel({ chat }: { chat: ChatState }) {
  const w = mainWindow(chat);
  const label = w ? `${t('Plan usage')}: ${t(w.label)} ${Math.round(w.pct)}%` : t('Plan usage');
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button className="hover:bg-accent inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1" aria-label={label} title={label}>
          <UsageRing chat={chat} />
          {w && <span className="text-muted-foreground text-[11px] tabular-nums">{Math.round(w.pct)}%</span>}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content side="top" align="end" sideOffset={8} className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 w-[20rem] rounded-xl border p-3.5 shadow-xl">
          <Body chat={chat} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function Bar({ w }: { w: LimitWindow }) {
  const pct = Math.min(100, Math.max(0, w.pct));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="min-w-0 flex-1 truncate">{t(w.label)}</span>
        <span className="tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t(w.label)}>
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: colorFor(pct) }} />
      </div>
      {w.resetsAt && <div className="text-muted-foreground text-[11px]">{resetIn(w.resetsAt)}</div>}
    </div>
  );
}

const money = (n: number, cur = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
};

function Body({ chat }: { chat: ChatState }) {
  const l = chat.limits;
  const plan = l?.plan ?? chat.account.plan;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{t('Plan usage')}</span>
        {plan && <span className="bg-muted rounded px-1.5 py-px text-[10.5px] font-medium uppercase">{plan}</span>}
        <span className="text-muted-foreground ml-auto truncate text-[11px]">{chat.account.email ?? chat.account.name}</span>
      </div>
      {!l ? (
        <div className="text-muted-foreground text-[12px]">{t('Checking your plan…')}</div>
      ) : !l.available ? (
        <div className="text-muted-foreground text-[12px]">{chat.account.gateway ? t('This provider does not report plan limits.') : t('Plan limits do not apply to API keys. You pay per token.')}</div>
      ) : (
        l.windows.map((w) => <Bar key={w.id} w={w} />)
      )}
      {l?.extra && (
        <div className="flex items-baseline gap-2 border-t pt-2 text-[12px]">
          <span className="flex-1">{t(l.extra.label)}</span>
          <span className="tabular-nums">
            {money(l.extra.used, l.extra.currency ?? 'USD')}
            {l.extra.limit ? ` / ${money(l.extra.limit, l.extra.currency ?? 'USD')}` : ''}
          </span>
        </div>
      )}
      <div className="text-muted-foreground flex items-baseline gap-2 border-t pt-2 text-[11.5px]">
        <span className="flex-1">{t('This chat')}</span>
        <span className="tabular-nums">{money(chat.costUsd)} {t('API-equivalent')}</span>
      </div>
    </div>
  );
}
