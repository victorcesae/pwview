import { Bot, FileDiff, FilePlus2, FileSearch, Globe, ListTodo, MessageSquare, Search, Sparkles, SquareTerminal, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { State } from '@/types';
import { t } from '@/i18n';

export function StateDot({ state, className }: { state: State; className?: string }) {
  const color = state === 'working' ? 'bg-working' : state === 'recent' ? 'bg-recent' : 'bg-muted-foreground/40';
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} aria-label={state}>
      {state === 'working' && <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', color)} />}
      <span className={cn('relative inline-flex size-2.5 rounded-full', color)} />
    </span>
  );
}

export const stateLabel: Record<State, string> = { working: t('Working'), recent: t('Waiting'), idle: t('Idle') };

export function ToolIcon({ tool, kind, className }: { tool?: string; kind: string; className?: string }) {
  const c = cn('size-3.5', className);
  if (kind === 'prompt') return <MessageSquare className={c} />;
  if (kind === 'text') return <Sparkles className={c} />;
  if (kind === 'change') return <FileDiff className={c} />;
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return <SquareTerminal className={c} />;
    case 'Read':
      return <FileSearch className={c} />;
    case 'Write':
      return <FilePlus2 className={c} />;
    case 'Edit':
    case 'MultiEdit':
      return <FileDiff className={c} />;
    case 'Grep':
    case 'Glob':
      return <Search className={c} />;
    case 'Agent':
    case 'Task':
      return <Bot className={c} />;
    case 'WebFetch':
    case 'WebSearch':
      return <Globe className={c} />;
    case 'TodoWrite':
      return <ListTodo className={c} />;
    default:
      return <Wrench className={c} />;
  }
}

export function DiffStat({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] tabular-nums', className)}>
      <span className="text-added">+{added}</span> <span className="text-removed">−{removed}</span>
    </span>
  );
}

export function Stat({ label, value, icon: Icon }: { label: string; value: number | string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <Icon className="text-muted-foreground size-4" />
      <div>
        <div className="text-[15px] leading-tight font-semibold tabular-nums">{value}</div>
        <div className="text-muted-foreground text-[11px]">{label}</div>
      </div>
    </div>
  );
}
