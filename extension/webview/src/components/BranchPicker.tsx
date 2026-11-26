// The chat folder's git branch, in the composer footer: switch branch, or start a chat in a new worktree.
import { GitBranch, FolderGit2, Check, TriangleAlert, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { post as postAny } from '@/bridge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import type { GitInfo, ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);

export function BranchPicker({ prompt }: { prompt?: string }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'gitInfo' && setInfo(e.data as GitInfo);
    window.addEventListener('message', on);
    post({ type: 'gitInfo' });
    // the agent may switch branches itself: look again now and then
    const timer = setInterval(() => document.visibilityState === 'visible' && post({ type: 'gitInfo' }), 15_000);
    return () => {
      window.removeEventListener('message', on);
      clearInterval(timer);
    };
  }, []);
  if (!info?.isRepo) return null;
  return (
    <DropdownMenu onOpenChange={(open) => open && post({ type: 'gitInfo' })}>
      <DropdownMenuTrigger asChild>
        <button
          className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-7 max-w-44 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11.5px]"
          title={info.dirty ? t('Branch (uncommitted changes)') : t('Branch')}
          aria-label={t('Branch')}
          data-branch
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{info.branch ?? t('detached')}</span>
          {info.dirty && <span className="bg-warn size-1.5 shrink-0 rounded-full" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 max-w-80 overflow-y-auto">
        <DropdownMenuLabel>{t('Switch branch')}</DropdownMenuLabel>
        {info.dirty && (
          <div className="text-warn flex items-center gap-1.5 px-2.5 pb-1 text-[11px]">
            <TriangleAlert className="size-3" /> {t('Uncommitted changes in this folder')}
          </div>
        )}
        {info.branches.map((b) => (
          <DropdownMenuItem key={b} onSelect={() => b !== info.branch && post({ type: 'switchBranch', branch: b })}>
            {b === info.branch ? <Check /> : <span className="size-4" />}
            <span className="truncate">{b}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => post({ type: 'newWorktree' })}>
          <FolderGit2 /> {t('New chat in a worktree…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => post({ type: 'bestOfN', prompt })}>
          <Layers /> {t('Best of N…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
