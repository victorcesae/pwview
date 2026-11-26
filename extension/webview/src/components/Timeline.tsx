// Session timeline: one tick per transcript row (your prompts tall, tool calls short, edits colored by
// lines added / removed). Hover tells what and when, click or drag scrolls the chat there, play steps
// through the session at an adjustable speed while the current row is highlighted.
import { Pause, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { duration } from '@/components/Elapsed';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatItem } from '@/types';

type Row = ChatItem | ChatItem[];
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const SPEEDS = [0.5, 1, 2, 4];

export interface Tick {
  row: number;
  kind: 'prompt' | 'answer' | 'edit' | 'tool' | 'other';
  /** ms since epoch; carried over from the row before when the item has no time */
  at?: number;
  label: string;
  added: number;
  removed: number;
}

const firstLine = (s: string, n = 90) => {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > n ? l.slice(0, n - 1) + '…' : l;
};
const timeOf = (it: ChatItem): number | undefined => {
  const ts = 'ts' in it ? it.ts : undefined;
  const n = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** The ticks for a transcript's rows (pure, for tests and the bar). */
export function ticksOf(rows: Row[]): Tick[] {
  let last: number | undefined;
  return rows.map((g, row) => {
    const items = Array.isArray(g) ? g : [g];
    const at = items.map(timeOf).find((x) => x !== undefined) ?? last;
    last = at;
    let added = 0;
    let removed = 0;
    for (const it of items)
      if (it.kind === 'tool' && EDIT_TOOLS.test(it.name)) for (const h of it.patch ?? []) for (const l of h.lines) l[0] === '+' ? added++ : l[0] === '-' && removed++;
    const it = items[0];
    const edit = items.some((x) => x.kind === 'tool' && EDIT_TOOLS.test(x.name));
    if (it.kind === 'user') return { row, kind: 'prompt', at, label: (it.auto ? '⟳ ' : '') + (firstLine(it.text) || t('(image)')), added, removed };
    if (it.kind === 'assistant') return { row, kind: 'answer', at, label: firstLine(it.text), added, removed };
    if (it.kind === 'tool') {
      const label = items.length > 1 ? items.map((x) => (x.kind === 'tool' ? x.name : x.kind)).join(', ') : `${it.name}: ${firstLine(it.summary, 70)}`;
      return { row, kind: edit ? 'edit' : 'tool', at, label, added, removed };
    }
    return { row, kind: 'other', at, label: it.kind === 'system' || it.kind === 'result' ? firstLine(it.text) : it.kind, added, removed };
  });
}

const clock = (ms?: number) => (ms === undefined ? '' : new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
const KIND_LABEL: Record<Tick['kind'], string> = { prompt: 'Your prompt', answer: 'Agent answer', edit: 'File edit', tool: 'Tool call', other: '' };

export function Timeline({ rows, current, onJump, onPlayRow, onClose }: { rows: Row[]; current: number; onJump: (row: number) => void; onPlayRow: (row: number | undefined) => void; onClose: () => void }) {
  const ticks = useMemo(() => ticksOf(rows), [rows]);
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | undefined>();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [pos, setPos] = useState<number | undefined>();
  const dragging = useRef(false);
  const jump = useRef(onJump);
  jump.current = onJump;
  const n = ticks.length;
  const x = (row: number) => (n <= 1 ? 50 : (row / (n - 1)) * 100);
  const rowAt = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || !n) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1))));
  };
  const go = (row: number) => {
    setPos(row);
    onJump(row);
    onPlayRow(row);
  };

  // play: one row per step, faster with the speed
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setPos((p) => {
        const next = (p ?? Math.max(0, current - 1)) + 1;
        if (next >= n) {
          setPlaying(false);
          return p;
        }
        jump.current(next);
        onPlayRow(next);
        return next;
      });
    }, 900 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, n]);
  useEffect(() => () => onPlayRow(undefined), []);

  // wall-clock between consecutive prompts
  const gaps = useMemo(() => {
    const ps = ticks.filter((k) => k.kind === 'prompt');
    return ps.slice(1).flatMap((b, i) => {
      const a = ps[i];
      return a.at !== undefined && b.at !== undefined && b.at > a.at ? [{ from: a.row, to: b.row, ms: b.at - a.at }] : [];
    });
  }, [ticks]);

  if (!n) return null;
  const shown = hover ?? pos ?? current;
  const tk = ticks[Math.min(shown, n - 1)];
  return (
    <div className="flex flex-col gap-1 border-b px-4 py-1.5" role="region" aria-label={t('Session timeline')} data-timeline>
      <div className="flex items-center gap-2">
        <Button size="xs" variant="ghost" onClick={() => (playing ? setPlaying(false) : (pos !== undefined && pos >= n - 1 && setPos(-1), setPlaying(true)))} aria-label={playing ? t('Pause') : t('Play')} title={playing ? t('Pause') : t('Play')}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <button className="text-muted-foreground hover:text-foreground cursor-pointer rounded border px-1 text-[10.5px] tabular-nums" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} title={t('Playback speed')} aria-label={t('Playback speed')}>
          {speed}×
        </button>
        <div
          ref={track}
          className="relative h-7 min-w-0 flex-1 cursor-pointer touch-none select-none"
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setPlaying(false);
            go(rowAt(e.clientX));
          }}
          onPointerMove={(e) => {
            const r = rowAt(e.clientX);
            setHover(r);
            if (dragging.current && r !== pos) go(r);
          }}
          onPointerUp={() => (dragging.current = false)}
          onPointerLeave={() => !dragging.current && setHover(undefined)}
        >
          <div className="bg-border absolute inset-x-0 top-1/2 h-px" />
          {gaps.map((g) => (
            <span key={g.from} className="text-muted-foreground pointer-events-none absolute top-0 -translate-x-1/2 text-[9px] leading-none tabular-nums" style={{ left: `${(x(g.from) + x(g.to)) / 2}%` }}>
              {t('{0} later', duration(g.ms))}
            </span>
          ))}
          {ticks.map((k) => {
            const h = k.kind === 'prompt' ? 22 : k.kind === 'edit' ? 10 + Math.min(10, Math.round(Math.log2(1 + k.added + k.removed) * 2)) : k.kind === 'answer' ? 10 : 6;
            const color = k.kind === 'prompt' ? 'bg-primary' : k.kind === 'edit' ? (k.added >= k.removed ? 'bg-added' : 'bg-removed') : k.kind === 'answer' ? 'bg-foreground/50' : 'bg-muted-foreground/50';
            return <span key={k.row} className={cn('pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-sm', color, k.kind === 'prompt' ? 'w-[3px]' : 'w-px', k.row === shown && 'ring-ring ring-2')} style={{ left: `${x(k.row)}%`, top: '55%', height: h }} />;
          })}
          <span className="border-foreground pointer-events-none absolute top-0 bottom-0 w-0 border-l border-dashed opacity-60" style={{ left: `${x(Math.min(pos ?? current, n - 1))}%` }} />
        </div>
        <Button size="xs" variant="ghost" onClick={onClose} aria-label={t('Close timeline')} title={t('Close timeline')}>
          <X />
        </Button>
      </div>
      <div className="text-muted-foreground flex min-w-0 gap-2 text-[11px]" aria-live="polite">
        <span className="shrink-0 tabular-nums">{clock(tk?.at)}</span>
        {tk && KIND_LABEL[tk.kind] && <span className="shrink-0">· {t(KIND_LABEL[tk.kind])}</span>}
        {tk?.kind === 'edit' && (
          <span className="shrink-0 tabular-nums">
            <span className="text-added">+{tk.added}</span> <span className="text-removed">−{tk.removed}</span>
          </span>
        )}
        <span className="text-foreground/80 truncate">{tk?.label}</span>
      </div>
    </div>
  );
}
