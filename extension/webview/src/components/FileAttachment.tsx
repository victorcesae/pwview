// A file attached to a message, shown like an image attachment: an icon and the name. A click opens
// it in a new tab; the agent gets the path, not the user's text.
import { File, FileArchive, FileCode2, FileSpreadsheet, FileText, FileVideo, X } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';

const nameOf = (p: string) => p.split(/[\\/]/).pop() || p;

function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['xls', 'xlsx', 'csv', 'ods', 'tsv'].includes(ext)) return FileSpreadsheet;
  if (['pdf', 'doc', 'docx', 'odt', 'txt', 'md', 'rtf'].includes(ext)) return FileText;
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return FileArchive;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return FileVideo;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cs', 'prw', 'tlpp', 'json', 'yaml', 'yml', 'sql', 'html', 'css'].includes(ext)) return FileCode2;
  return File;
}

export function FileAttachment({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const name = nameOf(path);
  const Icon = iconFor(name);
  return (
    <span className="group bg-muted/60 hover:bg-muted relative inline-flex max-w-64 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px]" data-file-attachment>
      <button className="flex min-w-0 cursor-pointer items-center gap-1.5" onClick={() => post({ type: 'openFile', path })} title={`${path}\n${t('Click to open')}`}>
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      {onRemove && (
        <button onClick={onRemove} className="text-muted-foreground hover:text-foreground cursor-pointer" aria-label={t('Remove')}>
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
