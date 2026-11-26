// ✓ / ✗ next to a turn's changes chip: the verify command's result for that turn. Click shows its output.
import { Check, Loader2, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { post as postAny } from '@/bridge';
import { duration } from '@/components/Elapsed';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatState, ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);

export function VerifyBadge({ chat, turn }: { chat: ChatState; turn: string }) {
  const v = chat.verify;
  const r = v?.results[turn];
  const running = v?.running === turn;
  const [open, setOpen] = useState(false);
  const [output, setOutput] = useState<string | undefined>();
  useEffect(() => {
    if (!open) return;
    const on = (e: MessageEvent) => e.data?.type === 'verifyOutput' && e.data.turn === turn && setOutput(e.data.output);
    window.addEventListener('message', on);
    post({ type: 'verifyOutput', turn });
    return () => window.removeEventListener('message', on);
  }, [open, turn, r?.durationMs]);
  if (running)
    return (
      <span className="text-muted-foreground mt-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px]" role="status" data-verify="running">
        <Loader2 className="size-3 animate-spin" /> {t('Verifying…')}
      </span>
    );
  if (!r) return null;
  const label = r.cancelled ? t('Verify stopped') : r.timedOut ? t('Verify timed out') : r.ok ? t('Verify passed') : t('Verify failed');
  const Icon = r.cancelled ? Square : r.ok ? Check : X;
  return (
    <>
      <button
        className={cn('hover:bg-accent mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] tabular-nums', r.cancelled ? 'text-muted-foreground' : r.ok ? 'text-added' : 'text-removed')}
        onClick={() => setOpen((o) => !o)}
        title={`${label} · ${r.command} · ${duration(r.durationMs)} — ${open ? t('Hide output') : t('Show the verify output')}`}
        data-verify={r.cancelled ? 'cancelled' : r.ok ? 'ok' : 'failed'}
      >
        <Icon className="size-3" /> {label}
      </button>
      {open && (
        <pre className="bg-muted text-muted-foreground ml-7 max-h-72 basis-full overflow-auto rounded-md border p-2 font-mono text-[11px] whitespace-pre-wrap" data-verify-output>
          <div className="text-foreground mb-1">$ {r.command}</div>
          {output === undefined ? t('Loading…') : output || t('(no output)')}
        </pre>
      )}
    </>
  );
}
