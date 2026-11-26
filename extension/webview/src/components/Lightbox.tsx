// Click an image to see it full size. The lightbox is a gallery of every image in the chat, in
// order: each Zoomable registers its picture with the provider (and stays known while the
// virtualized list scrolls it out of the DOM), so ← / → walk through all of them.
// Wheel zooms, drag pans, double-click resets; Esc or a click on the backdrop closes it.
import { post as postAny } from '@/bridge';
import type { ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);
import { t } from '@/i18n';
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

type Pic = { src: string; path?: string };
type Entry = Pic & { row: string; seq: number; el?: HTMLElement | null };
type Api = { open: (src: string) => void; register: (key: string, e: Entry) => () => void; nextSeq: () => number };

const Ctx = createContext<Api>({ open: () => {}, register: () => () => {}, nextSeq: () => 0 });
export const useLightbox = () => useContext(Ctx).open;

/** Which chat row an image belongs to, for the gallery's order (set by the chat's row wrapper). */
export const GalleryRow = createContext('');

export function LightboxProvider({ children, rank }: { children: React.ReactNode; /** order of a row key; -1 when the row is gone */ rank?: (row: string) => number }) {
  const reg = useRef(new Map<string, Entry>());
  const seq = useRef(0);
  const rankRef = useRef(rank);
  rankRef.current = rank;
  const [list, setList] = useState<Pic[]>();
  const [index, setIndex] = useState(0);

  const ordered = useCallback((): Entry[] => {
    const r = rankRef.current ?? (() => 0);
    const all = [...reg.current.values()].filter((e) => !e.row || r(e.row) >= 0);
    const pos = (e: Entry) => (e.row ? r(e.row) : Number.MAX_SAFE_INTEGER); // the message box's attachments last
    all.sort((a, b) => {
      const d = pos(a) - pos(b);
      if (d) return d;
      if (a.el?.isConnected && b.el?.isConnected && a.el !== b.el) return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      return a.seq - b.seq;
    });
    const seen = new Set<string>();
    return all.filter((e) => !seen.has(e.src) && !!seen.add(e.src));
  }, []);

  const api = useMemo<Api>(
    () => ({
      open: (src) => {
        const all = ordered();
        const i = all.findIndex((e) => e.src === src);
        setList(i >= 0 ? all : [{ src }]);
        setIndex(Math.max(0, i));
      },
      // unmounting (scrolled away) keeps the entry; only a removed row drops it, via rank
      register: (key, e) => {
        const old = reg.current.get(key);
        reg.current.set(key, { ...e, seq: old?.seq ?? e.seq });
        return () => {
          const cur = reg.current.get(key);
          if (cur) cur.el = undefined;
          if (cur && !cur.row) reg.current.delete(key); // composer attachments go with the box
        };
      },
      nextSeq: () => seq.current++,
    }),
    [ordered],
  );

  const close = useCallback(() => setList(undefined), []);
  const go = useCallback((d: number) => setIndex((i) => (list ? (i + d + list.length) % list.length : 0)), [list]);
  useEffect(() => {
    if (!list) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); // not also "Esc twice stops the agent"
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [list, go, close]);

  const pic = list?.[index];
  return (
    <Ctx.Provider value={api}>
      {children}
      {list && pic && (
        <div role="dialog" aria-modal="true" className="animate-in fade-in-0 fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-black/80 p-6" onClick={close} data-lightbox>
          <ZoomImage key={pic.src} src={pic.src} />
          <div className="absolute top-4 right-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <button className="grid size-8 cursor-pointer place-items-center rounded-full bg-black/60 text-white hover:bg-black/80" onClick={() => post({ type: 'openMedia', path: pic.path, data: pic.path ? undefined : pic.src })} title={t('Open in editor')} aria-label={t('Open in editor')}>
              <ExternalLink className="size-4" />
            </button>
            <button className="grid size-8 cursor-pointer place-items-center rounded-full bg-black/60 text-white hover:bg-black/80" onClick={close} aria-label={t('Close')}>
              <X className="size-4" />
            </button>
          </div>
          {list.length > 1 && (
            <>
              <button className="absolute top-1/2 left-3 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 text-white hover:bg-black/80" onClick={(e) => (e.stopPropagation(), go(-1))} aria-label={t('Previous image')}>
                <ChevronLeft className="size-5" />
              </button>
              <button className="absolute top-1/2 right-3 grid size-10 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/60 text-white hover:bg-black/80" onClick={(e) => (e.stopPropagation(), go(1))} aria-label={t('Next image')}>
                <ChevronRight className="size-5" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[12px] text-white tabular-nums" data-lightbox-count>
                {index + 1} / {list.length}
              </div>
            </>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

function ZoomImage({ src }: { src: string }) {
  const [z, setZ] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="max-h-full max-w-full rounded-lg object-contain shadow-2xl select-none"
      style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})`, cursor: z.s > 1 ? 'grab' : 'zoom-in', transition: drag.current ? 'none' : 'transform 80ms' }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={() => setZ({ s: z.s > 1 ? 1 : 2, x: 0, y: 0 })}
      onWheel={(e) => {
        const s = Math.min(8, Math.max(1, z.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        setZ(s === 1 ? { s, x: 0, y: 0 } : { ...z, s });
      }}
      onPointerDown={(e) => {
        if (z.s <= 1) return;
        drag.current = { x: e.clientX - z.x, y: e.clientY - z.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => drag.current && setZ({ ...z, x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })}
      onPointerUp={() => (drag.current = undefined)}
    />
  );
}

/** An image thumbnail that opens the gallery when clicked. `path` is the local file, when there is one. */
export function Zoomable({ src, className, path }: { src: string; className?: string; path?: string }) {
  const { open, register, nextSeq } = useContext(Ctx);
  const row = useContext(GalleryRow);
  const ref = useRef<HTMLButtonElement>(null);
  const [seq] = useState(nextSeq);
  useLayoutEffect(() => register(`${row}|${src}`, { src, path, row, seq, el: ref.current }), [register, row, src, path, seq]);
  return (
    <button ref={ref} type="button" onClick={() => open(src)} className="cursor-zoom-in" aria-label={t('View image')}>
      <img src={src} alt="" className={className} loading="lazy" />
    </button>
  );
}
