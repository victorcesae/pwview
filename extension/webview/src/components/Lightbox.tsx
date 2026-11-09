// Click an image to see it full size; Esc or a click closes it.
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const Ctx = createContext<(src: string) => void>(() => {});
export const useLightbox = () => useContext(Ctx);

export function LightboxProvider({ children }: { children: React.ReactNode }) {
  const [src, setSrc] = useState<string>();
  const open = useCallback((s: string) => setSrc(s), []);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSrc(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);
  return (
    <Ctx.Provider value={open}>
      {children}
      {src && (
        <div role="dialog" aria-modal="true" className="animate-in fade-in-0 fixed inset-0 z-[100] grid place-items-center bg-black/75 p-6" onClick={() => setSrc(undefined)}>
          <img src={src} alt="" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button className="absolute top-4 right-4 grid size-8 cursor-pointer place-items-center rounded-full bg-black/60 text-white hover:bg-black/80" onClick={() => setSrc(undefined)} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}

/** An image thumbnail that opens full size when clicked. */
export function Zoomable({ src, className }: { src: string; className?: string }) {
  const open = useLightbox();
  return (
    <button type="button" onClick={() => open(src)} className="cursor-zoom-in" aria-label="View image">
      <img src={src} alt="" className={className} />
    </button>
  );
}
