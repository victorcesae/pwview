// Getting around long chats: long messages fold, a rail with one mark per prompt jumps to it, and
// Alt+↑ / Alt+↓ step between your messages.
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { t } from '@/i18n';

/** Past this height a finished message is shown folded. */
export const FOLD_PX = 420;

/** A long message, folded with a fade and "Show more" (never while it is still being written). */
export function Fold({ children, live, className }: { children: ReactNode; live?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || live) return;
    const measure = () => setTall(el.scrollHeight > FOLD_PX + 120);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live]);
  const folded = tall && !open && !live;
  return (
    <div className={cn('relative', className)}>
      <div ref={box} style={folded ? { maxHeight: FOLD_PX, overflow: 'hidden' } : undefined}>
        {children}
      </div>
      {folded && <div className="from-background pointer-events-none absolute inset-x-0 bottom-6 h-16 bg-gradient-to-t to-transparent" />}
      {tall && !live && (
        <button
          onClick={() => setOpen(!open)}
          className="text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center gap-1 text-[11.5px]"
          data-fold
        >
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          {open ? t('Show less') : t('Show more')}
        </button>
      )}
    </div>
  );
}

export interface Prompt {
  /** row index in the transcript */
  row: number;
  text: string;
}

/**
 * One mark per prompt along the right edge, placed by where it is in the chat. Hover shows the start
 * of the prompt, click jumps there; the mark of the part you are reading is lit.
 */
export function JumpRail({ prompts, total, current, onJump }: { prompts: Prompt[]; total: number; current: number; onJump: (row: number) => void }) {
  if (prompts.length < 2 || total < 2) return null;
  const at = currentPrompt(prompts, current);
  return (
    <nav className="absolute top-2 right-1 bottom-2 z-20 w-3" aria-label={t('Your messages')} data-jump-rail>
      {prompts.map((p, i) => (
        <button
          key={p.row}
          onClick={() => onJump(p.row)}
          title={p.text.slice(0, 140) || t('(image)')}
          aria-label={t('Go to message {0}', i + 1)}
          style={{ top: `${(p.row / (total - 1)) * 100}%` }}
          className={cn(
            'group absolute right-0 flex h-3 w-3 -translate-y-1/2 cursor-pointer items-center justify-end',
          )}
        >
          <span className={cn('block h-[3px] rounded-full transition-all group-hover:w-3', i === at ? 'bg-primary w-3' : 'bg-muted-foreground/40 w-2')} />
        </button>
      ))}
    </nav>
  );
}

/** The last prompt at or above this row. */
export function currentPrompt(prompts: Prompt[], row: number): number {
  let at = 0;
  for (let i = 0; i < prompts.length; i++) if (prompts[i].row <= row) at = i;
  return at;
}

/** Alt+↑ / Alt+↓: previous / next prompt. */
export function usePromptKeys(prompts: Prompt[], current: () => number, onJump: (row: number) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !prompts.length) return;
      e.preventDefault();
      const row = current();
      const target = e.key === 'ArrowUp' ? [...prompts].reverse().find((p) => p.row < row) ?? prompts[0] : prompts.find((p) => p.row > row);
      if (target) onJump(target.row);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompts, current, onJump]);
}
