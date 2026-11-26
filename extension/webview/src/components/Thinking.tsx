// The model's extended thinking: dimmed and collapsed to one line; Ctrl/Cmd+O expands or collapses all.
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatItem } from '@/types';

// kept outside React so rows keep their state when the virtualized list remounts them
const opened = new Map<string, boolean>();
let allOpen = false;
const EVENT = 'steerhouse:thinking';

/** Ctrl/Cmd+O: expand every thinking block, or collapse them all. */
export function toggleAllThinking() {
  allOpen = !allOpen;
  opened.clear();
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function ThinkingRow({ it }: { it: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(opened.get(it.id) ?? allOpen);
  const live = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = () => setOpen(allOpen);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useLayoutEffect(() => {
    if (it.streaming && live.current) live.current.scrollTop = live.current.scrollHeight;
  }, [it.text, it.streaming]);
  const text = it.text.trim();
  if (!text && !it.streaming) return null;
  const first = text.split('\n').find((l) => l.trim())?.replace(/^[#*\s]+|\*+$/g, '') ?? '';
  // while it streams, the line being written now; once done, how it began
  const latest = [...text.split('\n')].reverse().find((l) => l.trim())?.replace(/^[#*\s]+|\*+$/g, '') ?? '';
  const preview = it.streaming ? latest : first;
  const secs = it.durationMs !== undefined ? Math.max(1, Math.round(it.durationMs / 1000)) : undefined;
  const label = it.streaming ? t('Thinking…') : secs !== undefined ? t('Thought for {0}s', secs) : t('Thought');
  const toggle = () => {
    opened.set(it.id, !open);
    setOpen(!open);
  };
  return (
    <div className="text-muted-foreground flex flex-col gap-1 text-[13.5px]" data-thinking>
      {/* same layout as the step rows: icon, label, preview, and the chevron on the right */}
      <button className="hover:text-foreground flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 px-1.5 text-left" onClick={toggle} aria-expanded={open} title={t('Show or hide the thinking ({0})', 'Ctrl/Cmd+O')}>
        <Brain className={cn('size-4 shrink-0', it.streaming && 'animate-pulse')} />
        <span className="shrink-0">{label}</span>
        {!open && preview && <span className="min-w-0 flex-1 truncate opacity-80">· {preview}</span>}
        <span className="ml-auto shrink-0">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
      </button>
      {open && (
        <div ref={live} className="border-border/60 ml-1.5 max-h-[60vh] overflow-y-auto border-l pl-3 whitespace-pre-wrap opacity-80">
          {text}
        </div>
      )}
    </div>
  );
}
