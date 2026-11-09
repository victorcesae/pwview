// The folders a chat works in, in its header: its own folder first, then every other project the
// agent has edited (e.g. ../api-gateway). Click one to show it in the Explorer.
import { useMemo } from 'react';
import { Folder, FolderOpen } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { changesByProject } from '@/views/toolSummary';
import type { ChatState } from '@/types';

const base = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p;
const same = (a: string, b: string) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function workFolders(chat: Pick<ChatState, 'items' | 'cwd'>): { root: string; name: string; files: number; own: boolean }[] {
  const projects = changesByProject(chat.items as never, chat.cwd);
  const own = projects.find((p) => same(p.root, chat.cwd));
  return [
    { root: chat.cwd, name: base(chat.cwd), files: own?.files.length ?? 0, own: true },
    ...projects.filter((p) => !same(p.root, chat.cwd)).map((p) => ({ root: p.root, name: p.name, files: p.files.length, own: false })),
  ];
}

export function WorkFolders({ chat }: { chat: ChatState }) {
  const folders = useMemo(() => workFolders(chat), [chat.items, chat.cwd]);
  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden" aria-label={t('Folders this chat works in')} role="list">
      {folders.map((f) => {
        const Icon = f.own ? FolderOpen : Folder;
        return (
          <button
            key={f.root}
            role="listitem"
            data-folder={f.name}
            onClick={() => post({ type: 'revealFolder', path: f.root })}
            title={`${f.own ? t('Working folder') : t('Also edited here')}: ${f.root}${f.files ? '\n' + t('{0} files changed', f.files) : ''}\n${t('Show in Explorer')}`}
            className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded border px-1.5 py-px text-[11px]"
          >
            <Icon className="size-3 shrink-0" />
            <span className="max-w-[10rem] truncate">{f.name}</span>
            {f.files > 0 && <span className="tabular-nums opacity-70">{f.files}</span>}
          </button>
        );
      })}
    </div>
  );
}
