// The plan the agent proposes when it leaves plan mode (ExitPlanMode): Implement it, or Refine it.
import { Check, ClipboardList, Hammer, PencilLine, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { post as postAny } from '@/bridge';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import type { ChatItem, PermissionMode, ToChat } from '@/types';

const post = (m: ToChat) => postAny(m as never);

export function PlanCard({ it }: { it: Extract<ChatItem, { kind: 'plan' }> }) {
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const pending = it.status === 'pending';
  useEffect(() => {
    if (refining) box.current?.focus();
  }, [refining]);

  const implement = (mode: PermissionMode) => {
    post({ type: 'respond', id: it.id, decision: 'allow' });
    post({ type: 'setMode', mode });
  };
  const refine = () => post({ type: 'respond', id: it.id, decision: 'deny', message: feedback.trim() || 'Keep planning.' });

  return (
    <div className={cn('bg-card overflow-hidden rounded-xl border shadow-sm', pending ? 'border-working/60 ring-working/15 ring-2' : 'opacity-90')} data-plan>
      <div className={cn('flex items-center gap-2 border-b px-4 py-2.5', pending && 'bg-working/10')}>
        <ClipboardList className="text-working size-4" />
        <span className="text-[13px] font-semibold">{t('Plan')}</span>
        {pending && <span className="text-muted-foreground text-[11.5px]">{t('Review it, then implement or refine')}</span>}
        <span className="flex-1" />
        {!pending && (
          <Badge variant={it.status === 'approved' ? 'recent' : 'outline'}>
            {it.status === 'approved' ? <Check className="size-3" /> : <X className="size-3" />} {it.status === 'approved' ? t('Implemented') : t('Refined')}
          </Badge>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-4 py-2">
        <Markdown text={it.plan} />
      </div>
      {pending && (
        <div className="flex flex-col gap-2 border-t px-4 py-2.5">
          {refining ? (
            <>
              <textarea
                ref={box}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    refine();
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setRefining(false);
                  }
                }}
                rows={2}
                placeholder={t('What should change in the plan?')}
                className="bg-input min-h-14 w-full resize-y rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                data-refine
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={refine}>
                  <Send /> {t('Send feedback')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRefining(false)}>
                  {t('Cancel')}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => implement('acceptEdits')} title={t('Approve the plan; the agent edits files without asking')} data-implement>
                <Hammer /> {t('Implement')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => implement('default')} title={t('Approve the plan; the agent asks before each edit')}>
                {t('Implement, ask before edits')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRefining(true)} data-refine-open>
                <PencilLine /> {t('Refine')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
