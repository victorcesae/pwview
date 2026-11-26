// Previews of local files a finished answer or tool call mentions: images (into the gallery),
// video and audio players, PDFs, and a file card for documents and archives. The webview only
// guesses candidate paths; the host says which exist (and their size and webview URI), batched
// and cached, so nothing renders for a path that isn't there.
import { post as postAny } from '@/bridge';
import type { ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);
import { t } from '@/i18n';
import { detectMediaPaths, mediaKind, type MediaKind } from '@/lib/mediaPaths';
import { Button } from '@/components/ui/button';
import { Zoomable } from '@/components/Lightbox';
import { FileArchive, FileSpreadsheet, FileText, FolderOpen, ExternalLink, File as FileIcon, Presentation } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

export type FileInfo = { path: string; name: string; size: number; uri?: string };
type Answer = { key: string; info: FileInfo | null };

const cache = new Map<string, FileInfo | null>();
const waiting = new Set<string>();
const listeners = new Set<() => void>();
let queued: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

window.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type !== 'fileInfo') return;
  for (const a of e.data.files as Answer[]) {
    cache.set(a.key, a.info);
    waiting.delete(a.key);
  }
  listeners.forEach((l) => l());
});

function ask(paths: string[]) {
  for (const p of paths) if (!cache.has(p) && !waiting.has(p)) (waiting.add(p), queued.push(p));
  if (!queued.length || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const paths = queued;
    queued = [];
    post({ type: 'fileInfo', paths });
  }, 30);
}

function useFileInfo(paths: string[]): (FileInfo | null | undefined)[] {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!paths.length) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    ask(paths);
    return () => void listeners.delete(l);
  }, [paths]);
  return paths.map((p) => cache.get(p));
}

const MAX = 8;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
const act = (path: string, action: 'open' | 'reveal' | 'external') => post({ type: 'mediaAction', path, action });

function DocIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const cls = 'text-muted-foreground size-7 shrink-0';
  if (['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(ext)) return <FileSpreadsheet className={cls} />;
  if (['pptx', 'ppt', 'odp'].includes(ext)) return <Presentation className={cls} />;
  if (['zip', 'tar', 'gz', 'tgz', '7z'].includes(ext)) return <FileArchive className={cls} />;
  if (['docx', 'doc', 'odt', 'rtf', 'pdf', 'epub'].includes(ext)) return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}

function FileCard({ f }: { f: FileInfo }) {
  return (
    <div className="bg-card flex max-w-md items-center gap-2.5 rounded-md border px-2.5 py-2" data-file-card>
      <DocIcon name={f.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium" title={f.path}>{f.name}</div>
        <div className="text-muted-foreground text-[11px]">{size(f.size)}</div>
      </div>
      <Button size="xs" variant="ghost" onClick={() => act(f.path, 'open')}>{t('Open file')}</Button>
      <Button size="xs" variant="ghost" onClick={() => act(f.path, 'reveal')} title={t('Reveal in folder')} aria-label={t('Reveal in folder')}>
        <FolderOpen />
      </Button>
      <Button size="xs" variant="ghost" onClick={() => act(f.path, 'external')} title={t('Open externally')} aria-label={t('Open externally')}>
        <ExternalLink />
      </Button>
    </div>
  );
}

function Preview({ f, kind }: { f: FileInfo; kind: MediaKind }) {
  if (kind === 'image' && f.uri) return <Zoomable src={f.uri} path={f.path} className="max-h-48 max-w-full rounded-md border object-contain" />;
  if (kind === 'video' && f.uri)
    return (
      <figure className="flex max-w-xl flex-col gap-1">
        <video src={f.uri} controls preload="metadata" className="max-h-80 w-full rounded-md border bg-black" />
        <figcaption className="text-muted-foreground truncate text-[11px]" title={f.path}>{f.name} · {size(f.size)}</figcaption>
      </figure>
    );
  if (kind === 'audio' && f.uri)
    return (
      <figure className="flex w-full max-w-md flex-col gap-1">
        <audio src={f.uri} controls preload="metadata" className="w-full" />
        <figcaption className="text-muted-foreground truncate text-[11px]" title={f.path}>{f.name} · {size(f.size)}</figcaption>
      </figure>
    );
  // PDFs get the card: VS Code webviews have no PDF viewer plugin, an <iframe>/<object> stays blank.
  // "Open" uses a PDF viewer extension when one is installed, otherwise the system's viewer.
  return <FileCard f={f} />;
}

/**
 * The preview cards for a message, from its finished text. Pass `text` only once the message is
 * done (no work while streaming); detection is memoized on the text.
 */
export const MediaCards = memo(function MediaCards({ text }: { text?: string }) {
  const paths = useMemo(() => (text ? detectMediaPaths(text, MAX * 2) : []), [text]);
  const infos = useFileInfo(paths);
  const files = useMemo(() => {
    const seen = new Set<string>();
    const out: { f: FileInfo; kind: MediaKind }[] = [];
    for (const f of infos) {
      if (!f || seen.has(f.path) || out.length >= MAX) continue;
      const kind = mediaKind(f.path);
      if (!kind) continue;
      seen.add(f.path);
      out.push({ f, kind });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infos.map((f) => f?.path ?? '').join('\n')]);
  if (!files.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2" data-media-cards>
      {files.map(({ f, kind }) => (
        <Preview key={f.path} f={f} kind={kind} />
      ))}
    </div>
  );
});
