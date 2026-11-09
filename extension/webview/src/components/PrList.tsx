// The PRs an agent opened, each with its state (open / draft / merged / closed), title, task list
// progress, review decision and CI checks (GitHub Actions); a PR's checks unfold on click.
import { useEffect, useState } from 'react';
import { post } from '@/bridge';
import { Check, ChevronRight, FileText, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ListChecks, Loader2, MinusCircle, X } from 'lucide-react';
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

type PrFile = { path: string; additions: number; deletions: number; viewed: boolean };
type FilesState = { id?: string; files: PrFile[]; error?: string; loading?: boolean };

/** The PR's changed files with your viewed marks, fetched from the extension when opened. */
function usePrFiles(url: string, open: boolean): [FilesState | undefined, (s: FilesState) => void] {
  const [state, setState] = useState<FilesState>();
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'prFilesResult' && e.data.url === url && setState({ id: e.data.id, files: e.data.files ?? [], error: e.data.error });
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [url]);
  useEffect(() => {
    if (!open) return;
    setState((s) => ({ ...(s ?? { files: [] }), loading: true }));
    post({ type: 'prFiles', url });
  }, [open, url]);
  return [state, setState];
}

function PrRow({ url, label, st }: { url: string; label: string; st?: Status }) {
  const [open, setOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = usePrFiles(url, filesOpen);
  const github = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url);
  const canMerge = github && st?.state === 'open';
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
      {(st?.tasks || S || st?.review || github) && (
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
          {github && (
            <span className="ml-auto inline-flex items-center gap-1">
              <button className="hover:bg-accent text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5" onClick={() => setFilesOpen(!filesOpen)} aria-expanded={filesOpen} data-pr-files>
                <FileText className="size-3" /> {t('Files')}
                {files && files.files.length > 0 && <span className="tabular-nums">{files.files.filter((x) => x.viewed).length}/{files.files.length}</span>}
              </button>
              {canMerge && (
                <button className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium text-white" style={{ background: '#8250df' }} onClick={() => post({ type: 'prMerge', url })} data-pr-merge>
                  <GitMerge className="size-3" /> {t('Merge')}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {filesOpen && (
        <div className="mb-1 ml-7 border-l pl-2 text-[11.5px]" aria-label={t('Files changed')}>
          {files?.loading && !files.files.length && <div className="text-muted-foreground py-1">{t('Loading…')}</div>}
          {files?.error && <div className="text-removed py-1">{files.error}</div>}
          {files && files.files.length > 0 && (
            <div className="text-muted-foreground flex items-center gap-2 py-0.5">
              <span>{t('{0} of {1} viewed', files.files.filter((x) => x.viewed).length, files.files.length)}</span>
              <span className="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                <span className="block h-full" style={{ width: `${(files.files.filter((x) => x.viewed).length / files.files.length) * 100}%`, background: '#8250df' }} />
              </span>
            </div>
          )}
          <ul className="flex flex-col">
            {files?.files.map((fl) => (
              <li key={fl.path} className="flex items-center gap-1.5 py-0.5" data-file={fl.path} data-viewed={fl.viewed}>
                <input
                  type="checkbox"
                  className="accent-[#8250df] cursor-pointer"
                  checked={fl.viewed}
                  title={t('Viewed')}
                  aria-label={t('Viewed')}
                  onChange={(e) => {
                    if (!files.id) return;
                    // show it at once; the extension confirms with GitHub and sends the list again
                    setFiles({ ...files, files: files.files.map((x) => (x.path === fl.path ? { ...x, viewed: e.target.checked } : x)) });
                    post({ type: 'prViewed', url, prId: files.id, path: fl.path, viewed: e.target.checked });
                  }}
                />
                <button className={cn('min-w-0 flex-1 cursor-pointer truncate text-left font-mono hover:underline', fl.viewed && 'text-muted-foreground')} title={fl.path} onClick={() => post({ type: 'prOpenFile', url, path: fl.path })}>
                  {fl.path}
                </button>
                <span className="text-added tabular-nums">+{fl.additions}</span>
                <span className="text-removed tabular-nums">−{fl.deletions}</span>
              </li>
            ))}
          </ul>
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

