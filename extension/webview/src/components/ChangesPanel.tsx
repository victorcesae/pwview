// Changes panel: what each user turn changed (from the chat's Edit / Write tool items), or the whole
// git working tree, with an inline diff per file, the native diff, revert, and Commit / Push / Create PR.
import { useEffect, useMemo, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { ChevronRight, FileDiff, GitCommitHorizontal, GitPullRequest, Loader2, RefreshCw, Undo2, Upload, SquareSplitHorizontal } from 'lucide-react';
import { post as postAny } from '@/bridge';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { HunkView } from '@/views/Session';
import { projectOf } from '@/views/toolSummary';
import type { ChatItem, ChatState, Hunk, ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);
const OPEN_EVENT = 'steerhouse:openChanges';
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const ALL = 'all';
const TREE = 'tree';

export interface FileChange { path: string; rel: string; added: number; removed: number; hunks: Hunk[]; untracked?: boolean; binary?: boolean }
export interface Turn { id: string; prompt: string; files: FileChange[]; added: number; removed: number }

const norm = (p: string) => p.replace(/\\/g, '/');

function addTo(files: Map<string, FileChange>, it: Extract<ChatItem, { kind: 'tool' }>, cwd: string) {
  const p = norm(it.file!);
  const root = projectOf(p, cwd).root;
  const f = files.get(p) ?? files.set(p, { path: it.file!, rel: p.slice(root.length + 1) || p, added: 0, removed: 0, hunks: [] }).get(p)!;
  const hunks = it.patch ?? [];
  if (!hunks.length && it.name === 'Write') f.added += String((it.input as any)?.content ?? '').split('\n').length;
  for (const h of hunks) for (const l of h.lines) l[0] === '+' ? f.added++ : l[0] === '-' && f.removed++;
  f.hunks.push(...hunks);
}

/** One entry per user message, with the files the tools changed until the next user message. */
export function turnsOf(items: ChatItem[], cwd: string): Turn[] {
  const turns: (Turn & { map: Map<string, FileChange> })[] = [];
  for (const it of items) {
    if (it.kind === 'user') turns.push({ id: it.id, prompt: it.text.split('\n')[0].trim() || t('(image)'), files: [], added: 0, removed: 0, map: new Map() });
    else if (it.kind === 'tool' && it.file && it.status !== 'error' && EDIT_TOOLS.test(it.name) && turns.length) addTo(turns.at(-1)!.map, it, cwd);
  }
  return turns.map(({ map, ...tn }) => {
    const files = [...map.values()];
    return { ...tn, files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  });
}

/** All turns merged: the same file once, hunks in order. */
function mergeTurns(turns: Turn[]): FileChange[] {
  const m = new Map<string, FileChange>();
  for (const tn of turns)
    for (const f of tn.files) {
      const e = m.get(f.path) ?? m.set(f.path, { ...f, added: 0, removed: 0, hunks: [] }).get(f.path)!;
      e.added += f.added;
      e.removed += f.removed;
      e.hunks.push(...f.hunks);
    }
  return [...m.values()];
}

/** Open the panel on a turn (or "all") from anywhere in the chat. */
export const openChanges = (turn: string = ALL) => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: turn }));

/** Row index → turn, for the last row of each finished turn that changed files. */
export function turnEnds(rows: (ChatItem | ChatItem[])[], turns: Turn[], working: boolean): Map<number, Turn> {
  const byId = new Map(turns.map((x) => [x.id, x]));
  const out = new Map<number, Turn>();
  let cur: Turn | undefined;
  let last = -1;
  const close = () => cur && cur.files.length && last >= 0 && out.set(last, cur);
  rows.forEach((g, i) => {
    if (!Array.isArray(g) && g.kind === 'user') {
      close();
      cur = byId.get(g.id);
    }
    last = i;
  });
  if (!working) close();
  return out;
}

export function TurnChip({ turn }: { turn: Turn }) {
  return (
    <button className="text-muted-foreground hover:text-foreground hover:bg-accent mt-1.5 ml-7 inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] tabular-nums" onClick={() => openChanges(turn.id)} title={t('Show the changes of this turn')}>
      <FileDiff className="size-3" />
      <span className="text-added">+{turn.added}</span>
      <span className="text-removed">−{turn.removed}</span>
      <span>· {turn.files.length === 1 ? t('1 file') : t('{0} files', turn.files.length)}</span>
    </button>
  );
}

function FileRow({ f, canRevert }: { f: FileChange; canRevert: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded border">
      <div className="flex items-center gap-1.5 px-1.5 py-0.5 font-mono text-[11.5px]">
        <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left" onClick={() => setOpen(!open)} title={f.path} aria-expanded={open}>
          <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate">{f.rel}</span>
          {f.untracked && <span className="text-added text-[10px]">{t('new')}</span>}
          {f.added > 0 && <span className="text-added tabular-nums">+{f.added}</span>}
          {f.removed > 0 && <span className="text-removed tabular-nums">−{f.removed}</span>}
        </button>
        <button className="text-muted-foreground hover:text-foreground cursor-pointer" onClick={() => post({ type: 'changesOpenDiff', path: f.path })} title={t('Open diff')} aria-label={t('Open diff')}>
          <SquareSplitHorizontal className="size-3.5" />
        </button>
        {canRevert && (
          <button className="text-muted-foreground hover:text-removed cursor-pointer" onClick={() => post({ type: 'changesRevert', path: f.path })} title={t('Revert this file')} aria-label={t('Revert this file')}>
            <Undo2 className="size-3.5" />
          </button>
        )}
      </div>
      {open && <div className="border-t">{f.binary ? <div className="text-muted-foreground px-3 py-2 text-[12px]">{t('Binary file')}</div> : <HunkView hunks={f.hunks} />}</div>}
    </li>
  );
}

type TreeState = { loading: boolean; files: FileChange[]; error?: string; root?: string };

export function ChangesPanel({ chat }: { chat: ChatState }) {
  const turns = useMemo(() => turnsOf(chat.items, chat.cwd), [chat.items, chat.cwd]);
  const changed = turns.filter((x) => x.files.length);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string>(ALL);
  const [tree, setTree] = useState<TreeState>({ loading: false, files: [] });

  useEffect(() => {
    const onOpen = (e: Event) => {
      setSel(String((e as CustomEvent).detail ?? ALL));
      setOpen(true);
    };
    const onMsg = (e: MessageEvent) => e.data?.type === 'changesTreeResult' && setTree({ loading: false, files: e.data.files ?? [], error: e.data.error, root: e.data.root });
    window.addEventListener(OPEN_EVENT, onOpen);
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen);
      window.removeEventListener('message', onMsg);
    };
  }, []);

  const loadTree = () => {
    setTree((s) => ({ ...s, loading: true }));
    post({ type: 'changesTree' });
  };
  useEffect(() => {
    if (open && sel === TREE) loadTree();
  }, [open, sel]);

  const turn = turns.find((x) => x.id === sel);
  const files = sel === TREE ? tree.files : turn ? turn.files : mergeTurns(changed);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const prompts = (turn ? [turn] : changed).map((x) => x.prompt).filter(Boolean);
  const suggestion = (prompts.length === 1 ? prompts[0] : prompts.at(-1) ?? '').slice(0, 72);
  const count = mergeTurns(changed).length;

  const act = 'hover:bg-accent text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]';
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent relative grid size-7 cursor-pointer place-items-center rounded-md" aria-label={`${t('Changes')} (${count})`} title={`${t('Changes')} (${count})`}>
          <FileDiff className="size-4" />
          {count > 0 && <span className="bg-muted text-foreground absolute -right-0.5 -bottom-0.5 min-w-3.5 rounded-full px-1 text-center text-[9px] leading-3.5 tabular-nums">{count}</span>}
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content side="left" align="start" sideOffset={8} className="bg-popover text-popover-foreground animate-in fade-in-0 zoom-in-95 z-50 flex max-h-[80vh] w-[min(44rem,calc(100vw-5rem))] flex-col gap-2 overflow-hidden rounded-xl border p-3 shadow-xl">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{t('Changes')}</span>
            <span className="text-[11px] tabular-nums">
              <span className="text-added">+{added}</span> <span className="text-removed">−{removed}</span> <span className="text-muted-foreground">· {files.length === 1 ? t('1 file') : t('{0} files', files.length)}</span>
            </span>
            <span className="flex-1" />
            <button className={act} onClick={() => post({ type: 'gitCommit', message: suggestion })} title={t('Stage everything and commit')}>
              <GitCommitHorizontal className="size-3" /> {t('Commit')}
            </button>
            <button className={act} onClick={() => post({ type: 'gitPush' })} title={t('Push the current branch')}>
              <Upload className="size-3" /> {t('Push')}
            </button>
            <button className={act} onClick={() => post({ type: 'gitCreatePr' })} title={t('gh pr create --fill')}>
              <GitPullRequest className="size-3" /> {t('Create PR')}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <select className="bg-background min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[12px]" value={sel} onChange={(e) => setSel(e.target.value)} aria-label={t('Turn')}>
              <option value={ALL}>{t('All turns')}</option>
              {changed.map((x, i) => (
                <option key={x.id} value={x.id}>
                  {`${i + 1}. ${x.prompt.slice(0, 60)}${x.prompt.length > 60 ? '…' : ''}  (+${x.added} −${x.removed})`}
                </option>
              ))}
              <option value={TREE}>{t('Whole working tree (git)')}</option>
            </select>
            {sel === TREE && (
              <button className={act} onClick={loadTree} title={t('Refresh')} aria-label={t('Refresh')}>
                {tree.loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sel === TREE && tree.error ? (
              <div className="text-muted-foreground text-[12px]">{tree.error}</div>
            ) : sel === TREE && tree.loading && !tree.files.length ? (
              <div className="text-muted-foreground text-[12px]">{t('Loading…')}</div>
            ) : !files.length ? (
              <div className="text-muted-foreground text-[12px]">{t('No changes.')}</div>
            ) : (
              <ul className="flex flex-col gap-1">
                {files.map((f) => (
                  <FileRow key={f.path} f={f} canRevert />
                ))}
              </ul>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
