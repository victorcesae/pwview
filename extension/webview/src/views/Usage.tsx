import { Coins, Cpu, DatabaseZap, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { post } from '@/bridge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { t } from '@/i18n';
import { base, cn } from '@/lib/utils';
import type { UsageBucket, UsageReport } from '@/types';

const SERIES = ['var(--working)', 'var(--agent)', 'var(--recent)', 'var(--warn)', 'var(--removed)', 'var(--muted-foreground)'];
const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');
const tok = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
const total = (b: UsageBucket) => b.input + b.output + b.cacheWrite + b.cacheRead;

function Tile({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="bg-card flex items-start gap-3 rounded-lg border px-3.5 py-3">
      <Icon className="text-muted-foreground mt-0.5 size-4" />
      <div className="min-w-0">
        <div className="text-[18px] leading-tight font-semibold tabular-nums">{value}</div>
        <div className="text-muted-foreground text-[11.5px]">{label}</div>
        {sub && <div className="text-muted-foreground mt-0.5 truncate text-[11px] opacity-80">{sub}</div>}
      </div>
    </div>
  );
}

/** Stacked daily bars, one color per model; hover shows the day's breakdown. */
function DailyChart({ report, models }: { report: UsageReport; models: string[] }) {
  const [hover, setHover] = useState<number>();
  const max = Math.max(...report.byDay.map((d) => d.cost), 0.0001);
  const W = 640;
  const H = 180;
  const gap = report.byDay.length > 20 ? 2 : 6;
  const bw = (W - gap * (report.byDay.length - 1)) / report.byDay.length;
  const h = hover !== undefined ? report.byDay[hover] : undefined;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="h-auto w-full" role="img" aria-label={t('API-equivalent cost per day')}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - H * f} y2={H - H * f} stroke="var(--border)" strokeDasharray="3 4" />
        ))}
        {report.byDay.map((d, i) => {
          let y = H;
          const x = i * (bw + gap);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(undefined)}>
              <rect x={x} y={0} width={bw} height={H} fill="transparent" />
              {models.map((m, mi) => {
                const v = d.byModel[m] ?? 0;
                const bh = (v / max) * (H - 4);
                y -= bh;
                return v > 0 ? <rect key={m} x={x} y={y} width={bw} height={bh} rx={2} fill={SERIES[mi % SERIES.length]} opacity={hover === undefined || hover === i ? 1 : 0.45} /> : null;
              })}
              {(report.byDay.length <= 14 || i % Math.ceil(report.byDay.length / 10) === 0) && (
                <text x={x + bw / 2} y={H + 13} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="bg-popover text-popover-foreground pointer-events-none absolute top-0 right-0 rounded-md border px-2.5 py-1.5 text-[11.5px] shadow-md">
          <div className="font-medium">{h.day}</div>
          <div className="tabular-nums">
            {usd(h.cost)} · {tok(h.tokens)} {t('tokens')}
          </div>
          {models
            .filter((m) => h.byModel[m])
            .map((m) => (
              <div key={m} className="text-muted-foreground flex items-center gap-1.5 tabular-nums">
                <span className="inline-block size-2 rounded-sm" style={{ background: SERIES[models.indexOf(m) % SERIES.length] }} />
                {m}: {usd(h.byModel[m])}
              </div>
            ))}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
        {models.map((m, i) => (
          <span key={m} className="text-muted-foreground inline-flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} />
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

function BarList<T extends UsageBucket>({ rows, label, onClick }: { rows: T[]; label: (r: T) => string; onClick?: (r: T) => void }) {
  const max = Math.max(...rows.map((r) => r.cost), 0.0001);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        <button
          key={i}
          disabled={!onClick}
          onClick={() => onClick?.(r)}
          className={cn('group flex flex-col gap-1 rounded-md px-1 py-0.5 text-left', onClick && 'hover:bg-accent cursor-pointer')}
        >
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <span className="min-w-0 flex-1 truncate">{label(r)}</span>
            <span className="text-muted-foreground text-[11px] tabular-nums">{tok(total(r))}</span>
            <span className="w-16 text-right font-medium tabular-nums">{usd(r.cost)}</span>
          </div>
          <div className="bg-muted h-1.5 overflow-hidden rounded-full">
            <div className="bg-working h-full rounded-full" style={{ width: `${(r.cost / max) * 100}%` }} />
          </div>
        </button>
      ))}
      {!rows.length && <div className="text-muted-foreground text-[12px]">{t('No usage in this period.')}</div>}
    </div>
  );
}

export function UsageView({ report }: { report: UsageReport }) {
  const models = useMemo(() => report.byModel.map((m) => m.label).filter((v, i, a) => a.indexOf(v) === i), [report]);
  const tt = report.totals;
  const cacheShare = total(tt) ? tt.cacheRead / total(tt) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-[12px]">{t('Period')}</span>
        {[3, 7, 14, 30].map((d) => (
          <Button key={d} size="xs" variant={report.days === d ? 'secondary' : 'ghost'} onClick={() => post({ type: 'usage', days: d })}>
            {t('{0} days', d)}
          </Button>
        ))}
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1 text-[11px]" title={t('What these tokens would cost at Anthropic API list prices. With a Claude subscription you do not pay this; it shows the value of your usage.')}>
          <Info className="size-3.5" /> {t('API-equivalent value')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile icon={Coins} label={t('API-equivalent cost')} value={usd(tt.cost)} sub={tt.unpriced ? t('{0} tokens from unknown models not priced', tok(tt.unpriced)) : undefined} />
        <Tile icon={Cpu} label={t('Total tokens')} value={tok(total(tt))} sub={`${t('input')} ${tok(tt.input)} · ${t('output')} ${tok(tt.output)}`} />
        <Tile icon={DatabaseZap} label={t('Cache reads')} value={tok(tt.cacheRead)} sub={t('{0}% of all tokens (billed at ~10%)', Math.round(cacheShare * 100))} />
        <Tile icon={DatabaseZap} label={t('Cache writes')} value={tok(tt.cacheWrite)} />
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('Cost per day, by model')}</CardTitle>
            <CardDescription className="mt-1">{t('Hover a day for the breakdown.')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <DailyChart report={report} models={models} />
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('By model')}</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={report.byModel} label={(r) => r.label} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('By project')}</CardTitle>
          </CardHeader>
          <CardContent>
            <BarList rows={report.byProject} label={(r) => base(r.project)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('Most expensive sessions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <BarList rows={report.topSessions} label={(r) => r.title} onClick={(r) => post({ type: 'openSession', id: r.id })} />
        </CardContent>
      </Card>
    </div>
  );
}
