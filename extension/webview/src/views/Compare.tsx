// Best of N: the runs of one prompt side by side (status, time, cost, files and diffs), with
// Open chat / Apply this one per run, and Ask a judge / Clean up for the whole batch.
import { ChevronDown, ChevronRight, Gavel, MessageSquare, Check, Trash2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { post as postAny } from '@/bridge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CompareData, CompareRun } from '@/types';
import { HunkView } from './Session';

const post = (m: { type: string; i?: number }) => postAny(m as never);

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const STATUS: Record<string, string> = {
  starting: 'Starting',
  working: 'Working',
  waiting: 'Needs you',
  idle: 'Done',
  error: 'Error',
  closed: 'Closed',
  removed: 'Removed',
};

function RunCard({ run, data }: { run: CompareRun; data: CompareData }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const busy = run.status === 'working' || run.status === 'starting';
  const status = run.status === 'idle' && !run.finished ? 'Starting' : (STATUS[run.status] ?? run.status);
  return (
    <div className={cn('bg-card flex min-w-0 flex-col rounded-lg border', data.applied === run.i && 'border-primary')} data-run={run.i}>
      <div className="flex flex-col gap-1 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{t('Run {0}', run.i)}</span>
          <Badge variant="secondary" className="shrink-0">{run.model || t('default model')}</Badge>
          {data.applied === run.i && (
            <Badge className="shrink-0">
              <Check /> {t('Applied')}
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]">
          <span className="inline-flex items-center gap-1">
            {busy && <Loader2 className="size-3 animate-spin" />}
            {t(status)}
          </span>
          <span>{duration(run.elapsedMs)}</span>
          <span>${run.costUsd.toFixed(2)}</span>
          <span>
            {t('{0} files', run.files.length)} <span className="text-added">+{run.added}</span> <span className="text-removed">-{run.removed}</span>
          </span>
        </div>
        <div className="text-muted-foreground truncate font-mono text-[11px]" title={run.dir}>
          {run.branch}
        </div>
        {run.error && <div className="text-removed text-[11.5px]">{run.error}</div>}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Button size="xs" variant="outline" onClick={() => post({ type: 'compareOpenChat', i: run.i })} disabled={data.cleaned}>
            <MessageSquare /> {t('Open chat')}
          </Button>
          <Button size="xs" onClick={() => post({ type: 'compareApply', i: run.i })} disabled={data.cleaned || !run.files.length}>
            <Check /> {t('Apply this one')}
          </Button>
        </div>
      </div>
      <div className="min-w-0 overflow-x-auto">
        {!run.files.length && <div className="text-muted-foreground px-3 py-3 text-[12px]">{busy ? t('No changes yet.') : t('No changes.')}</div>}
        {run.files.map((f) => (
          <div key={f.rel} className="border-b last:border-b-0">
            <button className="hover:bg-accent flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[12px]" onClick={() => setOpen((s) => ({ ...s, [f.rel]: !s[f.rel] }))}>
              {open[f.rel] ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate font-mono" title={f.rel}>
                {f.rel}
              </span>
              {f.untracked && <span className="text-muted-foreground text-[10.5px]">{t('new')}</span>}
              <span className="text-added shrink-0">+{f.added}</span>
              <span className="text-removed shrink-0">-{f.removed}</span>
            </button>
            {open[f.rel] && <div className="font-mono text-[11.5px]">{f.binary ? <div className="text-muted-foreground px-3 py-2">{t('Binary file')}</div> : <HunkView hunks={f.hunks} />}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CompareView({ data }: { data: CompareData }) {
  const running = data.runs.some((r) => !r.finished && r.status !== 'removed');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[15px] font-semibold">{t('Best of N · {0} runs', data.runs.length)}</h1>
          <p className="text-muted-foreground line-clamp-3 text-[12.5px] whitespace-pre-wrap">{data.prompt}</p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => post({ type: 'compareJudge' })} disabled={data.cleaned} title={running ? t('Some runs are still working') : undefined}>
            <Gavel /> {t('Ask a judge')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => post({ type: 'compareCleanup' })} disabled={data.cleaned}>
            <Trash2 /> {t('Clean up')}
          </Button>
        </div>
      </div>
      {data.cleaned && <div className="text-muted-foreground text-[12px]">{t('The worktrees and branches were removed.')}</div>}
      <div className="grid gap-3 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${data.runs.length}, minmax(260px, 1fr))` }}>
        {data.runs.map((r) => (
          <RunCard key={r.i} run={r} data={data} />
        ))}
      </div>
    </div>
  );
}
