// The PRs an agent opened, each with its state (open / draft / merged / closed), title, task list
// progress, review decision and CI checks (GitHub Actions); a PR's checks unfold on click.
import { useState } from 'react';
import { Check, ChevronRight, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ListChecks, Loader2, MinusCircle, X } from 'lucide-react';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatState, PrCheckView } from '@/types';

type Status = NonNullable<ChatState['prs']>[string];
type PrState = Status['state'];
type CheckState = PrCheckView['state'];

export const PR_LOOK: Record<PrState, { icon: typeof GitPullRequest; color: string; label: string }> = {
  open: { icon: GitPullRequest, color: 'var(--recent)', label: 'Open' },
  draft: { icon: GitPullRequestDraft, color: 'var(--muted-foreground)', label: 'Draft' },
  merged: { icon: GitMerge, color: '#a371f7', label: 'Merged' },
  closed: { icon: GitPullRequestClosed, color: 'var(--removed)', label: 'Closed' },
  unknown: { icon: GitPullRequest, color: 'var(--muted-foreground)', label: 'Status unknown' },
};

export const CHECK_LOOK: Record<CheckState, { icon: typeof Check; color: string; label: string; spin?: boolean }> = {
  pass: { icon: Check, color: 'var(--recent)', label: 'Passing' },
  fail: { icon: X, color: 'var(--removed)', label: 'Failing' },
  pending: { icon: Loader2, color: 'var(--warn)', label: 'Running', spin: true },
  skipped: { icon: MinusCircle, color: 'var(--muted-foreground)', label: 'Skipped' },
};

/** Overall CI state: any failure, else anything running, else passing. */
export function checksSummary(checks?: PrCheckView[]): CheckState | undefined {
  if (!checks?.length) return undefined;
  if (checks.some((c) => c.state === 'fail')) return 'fail';
  if (checks.some((c) => c.state === 'pending')) return 'pending';
  if (checks.some((c) => c.state === 'pass')) return 'pass';
  return 'skipped';
}

const REVIEW: Record<NonNullable<Status['review']>, { label: string; color: string }> = {
  approved: { label: 'Approved', color: 'var(--recent)' },
  changes_requested: { label: 'Changes requested', color: 'var(--removed)' },
  required: { label: 'Review required', color: 'var(--warn)' },
};

const pill = (color: string) => ({ color, background: `color-mix(in srgb, ${color} 14%, transparent)` });

function PrRow({ url, label, st }: { url: string; label: string; st?: Status }) {
  const [open, setOpen] = useState(false);
  const L = PR_LOOK[st?.state ?? 'unknown'];
  const checks = st?.checks ?? [];
  const sum = checksSummary(checks);
  const S = sum && CHECK_LOOK[sum];
  const n = (s: CheckState) => checks.filter((c) => c.state === s).length;
  // failing first, then running, passing, skipped
  const order: CheckState[] = ['fail', 'pending', 'pass', 'skipped'];
  const sorted = checks.slice().sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return (
    <li className="rounded-md" data-pr={url}>
      <div className="flex items-center gap-2 px-1.5 py-1 text-[12px]">
        <L.icon className="size-3.5 shrink-0" style={{ color: L.color }} aria-label={t(L.label)} />
        <a href={url} className="min-w-0 flex-1 truncate hover:underline" title={url}>
          {label}
          {st?.title && <span className="text-muted-foreground"> · {st.title}</span>}
        </a>
        {st && st.state !== 'unknown' && (
          <span className="shrink-0 rounded px-1.5 text-[10.5px] font-medium" style={pill(L.color)}>
            {t(L.label)}
          </span>
        )}
      </div>
      {(st?.tasks || S || st?.review) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 pl-7 text-[11px]">
          {st?.tasks && (
            <span className="text-muted-foreground inline-flex items-center gap-1" title={t('Tasks in the description')} data-tasks>
              <ListChecks className="size-3.5" />
              <span className="tabular-nums">
                {t('{0}/{1} tasks', st.tasks.done, st.tasks.total)}
              </span>
              <span className="bg-muted ml-0.5 h-1 w-10 overflow-hidden rounded-full">
                <span className="bg-recent block h-full" style={{ width: `${(st.tasks.done / st.tasks.total) * 100}%` }} />
              </span>
            </span>
          )}
          {S && (
            <button className="hover:text-foreground inline-flex cursor-pointer items-center gap-1" onClick={() => setOpen(!open)} aria-expanded={open} data-checks={sum}>
              <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
              <S.icon className={cn('size-3.5', S.spin && 'animate-spin')} style={{ color: S.color }} />
              <span style={{ color: S.color }}>{t(S.label)}</span>
              <span className="text-muted-foreground tabular-nums">
                {[n('fail') && t('{0} failing', n('fail')), n('pending') && t('{0} running', n('pending')), n('pass') && t('{0} passing', n('pass'))].filter(Boolean).join(' · ')}
              </span>
            </button>
          )}
          {st?.review && (
            <span className="rounded px-1.5 font-medium" style={pill(REVIEW[st.review].color)}>
              {t(REVIEW[st.review].label)}
            </span>
          )}
        </div>
      )}
      {open && (
        <ul className="mb-1 ml-7 flex flex-col border-l pl-2" aria-label={t('Checks')}>
          {sorted.map((c) => {
            const C = CHECK_LOOK[c.state];
            return (
              <li key={(c.workflow ?? '') + c.name} className="flex items-center gap-1.5 py-0.5 text-[11.5px]" data-check={c.state}>
                <C.icon className={cn('size-3 shrink-0', C.spin && 'animate-spin')} style={{ color: C.color }} aria-label={t(C.label)} />
                {c.url ? (
                  <a href={c.url} className="min-w-0 flex-1 truncate hover:underline" title={c.url}>
                    {c.workflow && <span className="text-muted-foreground">{c.workflow} / </span>}
                    {c.name}
                  </a>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function PrList({ prs, status }: { prs: { url: string; label: string }[]; status?: ChatState['prs'] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {prs.map((pr) => (
        <PrRow key={pr.url} url={pr.url} label={pr.label} st={status?.[pr.url]} />
      ))}
    </ul>
  );
}

/** Rail button icon: the newest PR's state, with a dot for its CI (red failing, amber running). */
export function PrRailIcon({ st }: { st?: Status }) {
  const L = PR_LOOK[st?.state ?? 'unknown'];
  const sum = checksSummary(st?.checks);
  return (
    <span className="relative inline-grid">
      <L.icon className="size-4" style={{ color: L.color }} />
      {(sum === 'fail' || sum === 'pending') && <span className="ring-background absolute -top-0.5 -right-0.5 size-1.5 rounded-full ring-1" style={{ background: CHECK_LOOK[sum].color }} data-ci={sum} />}
    </span>
  );
}

