import { ArrowLeft, BookmarkPlus, Bot, ChevronDown, ChevronRight, FileCode2, Files, GitBranch, Link2, MessageSquarePlus, Send, Sparkles, SquareTerminal, Wrench, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { post } from '@/bridge';
import { DiffStat, Stat, StateDot, stateLabel, ToolIcon } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { MessagesTab } from './Messages';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ago, base, clock, cn, rel } from '@/lib/utils';
import type { Change, Comment, Hunk, SessionInfo, TimelineEvent } from '@/types';
import { t } from '@/i18n';

type SessionData = { info: SessionInfo; events: TimelineEvent[]; changes: Change[]; comments: Comment[]; terminal?: boolean; linkedTitles: Record<string, string> };

export function HunkView({ hunks }: { hunks: Hunk[] }) {
  if (!hunks.length) return <div className="text-muted-foreground px-3 py-2 text-[12px]">{t('New file. Open the diff to see it all.')}</div>;
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.55]">
      {hunks.map((h, i) => {
        let o = h.oldStart;
        let n = h.newStart;
        return (
          <div key={i} className="border-t first:border-t-0">
            <div className="text-muted-foreground bg-muted/50 px-3 py-0.5 text-[11px]">@@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@</div>
            {h.lines.map((l, j) => {
              const kind = l[0];
              const left = kind === '+' ? '' : o++;
              const right = kind === '-' ? '' : n++;
              return (
                <div key={j} className={cn('flex', kind === '+' && 'bg-diff-add', kind === '-' && 'bg-diff-del')}>
                  <span className="text-muted-foreground/60 w-10 shrink-0 pr-2 text-right select-none">{left}</span>
                  <span className="text-muted-foreground/60 w-10 shrink-0 pr-2 text-right select-none">{right}</span>
                  <span className={cn('w-4 shrink-0 select-none', kind === '+' ? 'text-added' : kind === '-' ? 'text-removed' : 'text-muted-foreground/50')}>{kind === ' ' ? '' : kind}</span>
                  <span className="pr-4 whitespace-pre">{l.slice(1)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ChangeCard({ c, info, agentName }: { c: Change; info: SessionInfo; agentName?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <button className="text-muted-foreground hover:text-foreground mt-0.5 cursor-pointer" onClick={() => setOpen(!open)} aria-label={t('Toggle preview')}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">{c.kind}</Badge>
            <DiffStat added={c.added} removed={c.removed} />
            {agentName ? (
              <Badge variant="agent"><Bot />{agentName.slice(0, 40)}</Badge>
            ) : (
              <Badge variant="secondary"><Sparkles />main</Badge>
            )}
            <span className="text-muted-foreground text-[11px]">{clock(c.timestamp)} · {ago(c.timestamp)}</span>
          </div>
          {c.why && <p className="text-muted-foreground mt-1.5 line-clamp-3 text-[12px] whitespace-pre-wrap">{c.why}</p>}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="xs" onClick={() => post({ type: 'openChange', sessionId: info.id, changeId: c.id })}>{t('Open diff')}</Button>
        </div>
      </div>
      {open && (
        <div className="bg-background border-t">
          <HunkView hunks={c.hunks} />
        </div>
      )}
    </div>
  );
}

function ChangesTab({ data, agentNames }: { data: SessionData; agentNames: Record<string, string> }) {
  const groups = useMemo(() => {
    const m = new Map<string, Change[]>();
    for (const c of [...data.changes].reverse()) m.set(c.file, [...(m.get(c.file) ?? []), c]);
    return [...m.entries()];
  }, [data.changes]);
  if (!groups.length) return <Empty>{t('No file changes in this session yet.')}</Empty>;
  return (
    <div className="flex flex-col gap-4">
      {groups.map(([file, list]) => (
        <section key={file} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <FileCode2 className="text-muted-foreground size-4" />
            <button className="cursor-pointer truncate font-mono text-[12px] hover:underline" onClick={() => post({ type: 'openFile', path: file })}>
              {rel(file, data.info.project)}
            </button>
            <DiffStat added={list.reduce((n, c) => n + c.added, 0)} removed={list.reduce((n, c) => n + c.removed, 0)} />
            <span className="text-muted-foreground text-[11px]">{list.length} {list.length === 1 ? 'change' : 'changes'}</span>
          </div>
          {list.map((c) => (
            <ChangeCard key={c.id} c={c} info={data.info} agentName={c.agentId ? agentNames[c.agentId] : undefined} />
          ))}
        </section>
      ))}
    </div>
  );
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'prompt', label: 'Prompts' },
  { id: 'text', label: 'Agent notes' },
  { id: 'change', label: 'Changes' },
  { id: 'tool', label: 'Tools' },
] as const;

function Timeline({ data, agentNames, focus, setFocus }: { data: SessionData; agentNames: Record<string, string>; focus?: string; setFocus: (a?: string) => void }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const changes = useMemo(() => new Map(data.changes.map((c) => [c.id, c])), [data.changes]);
  const events = data.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (filter === 'all' || e.kind === filter) && (!focus || e.agentId === focus))
    .reverse();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <Button key={f.id} size="xs" variant={filter === f.id ? 'secondary' : 'ghost'} onClick={() => setFilter(f.id)}>
            {f.label}
          </Button>
        ))}
        {focus && (
          <Badge variant="agent" className="ml-auto cursor-pointer" onClick={() => setFocus(undefined)}>
            <Bot />
            {(agentNames[focus] ?? focus).slice(0, 40)}
            <X />
          </Badge>
        )}
      </div>
      {!events.length && <Empty>{t('Nothing here yet.')}</Empty>}
      <ol className="relative flex flex-col">
        {events.map(({ e, i }) => {
          const c = e.refId ? changes.get(e.refId) : undefined;
          const long = e.text.length > 280;
          const isOpen = expanded[i];
          return (
            <li key={i} className="group relative flex gap-3 pb-3 pl-1">
              <div className="flex flex-col items-center">
                <div
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full border',
                    e.kind === 'prompt' && 'bg-primary text-primary-foreground border-transparent',
                    e.kind === 'change' && 'border-added/40 text-added',
                    e.kind === 'text' && 'text-foreground',
                    e.kind === 'tool' && 'text-muted-foreground',
                  )}
                >
                  <ToolIcon kind={e.kind} tool={e.tool} className="size-3" />
                </div>
                <div className="bg-border mt-1 w-px flex-1 group-last:hidden" />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="text-muted-foreground mb-0.5 flex items-center gap-2 text-[11px]">
                  <span className="tabular-nums">{clock(e.ts)}</span>
                  {e.kind === 'prompt' && <span className="text-foreground font-medium">You</span>}
                  {e.kind === 'tool' && <span className="font-mono">{e.tool}</span>}
                  {e.agentId && (
                    <button onClick={() => setFocus(e.agentId)} className="cursor-pointer">
                      <Badge variant="agent"><Bot />{(agentNames[e.agentId] ?? 'sub-agent').slice(0, 32)}</Badge>
                    </button>
                  )}
                </div>
                {e.kind === 'change' && c ? (
                  <button
                    className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left"
                    onClick={() => post({ type: 'openChange', sessionId: data.info.id, changeId: c.id })}
                  >
                    <span className="truncate font-mono text-[12px]">{rel(c.file, data.info.project)}</span>
                    <DiffStat added={c.added} removed={c.removed} className="ml-auto" />
                  </button>
                ) : e.kind === 'tool' ? (
                  <div className="text-muted-foreground truncate font-mono text-[12px]">{e.text}</div>
                ) : (
                  <div className={cn('text-[13px] whitespace-pre-wrap', e.kind === 'prompt' && 'bg-muted rounded-lg px-3 py-2', !isOpen && long && 'line-clamp-4')}>
                    {e.text}
                  </div>
                )}
                <div className="flex items-center gap-3">
                  {long && e.kind !== 'tool' && e.kind !== 'change' && (
                    <button className="text-muted-foreground hover:text-foreground mt-1 cursor-pointer text-[11px]" onClick={() => setExpanded({ ...expanded, [i]: !isOpen })}>
                      {isOpen ? 'Show less' : 'Show more'}
                    </button>
                  )}
                  {e.kind === 'prompt' && (
                    <button
                      className="text-muted-foreground hover:text-foreground mt-1 inline-flex cursor-pointer items-center gap-1 text-[11px]"
                      onClick={() => post({ type: 'savePrompt', text: e.text })}
                      title={t('Save this prompt so you can run it again in one click')}
                    >
                      <BookmarkPlus className="size-3" /> {t('Save as prompt')}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AgentsTab({ info, onFocus }: { info: SessionInfo; onFocus: (id: string) => void }) {
  if (!info.agents.length) return <Empty>{t('This session didn\'t start any sub-agents.')}</Empty>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {info.agents.map((a) => (
        <Card key={a.id} className="hover:border-agent/50 cursor-pointer transition-colors" onClick={() => onFocus(a.id)}>
          <CardContent className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <StateDot state={a.state} />
              <span className="truncate font-medium">{a.description}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              {a.agentType && <Badge variant="agent">{a.agentType}</Badge>}
              <span className="text-muted-foreground">{a.edits} edits · {a.tools} tool calls · {ago(a.updated)}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground rounded-lg border border-dashed px-4 py-8 text-center text-[12px]">{children}</div>;
}

export function SessionView({ data, focusAgent }: { data: SessionData; focusAgent?: string }) {
  const { info } = data;
  const [tab, setTab] = useState(focusAgent ? 'activity' : 'activity');
  const [focus, setFocus] = useState<string | undefined>(focusAgent);
  const agentNames = Object.fromEntries(info.agents.map((a) => [a.id, a.description]));
  const pending = data.comments.filter((c) => c.status === 'pending').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-3">
        <Button size="icon" variant="ghost" onClick={() => post({ type: 'overview' })} aria-label={t('All sessions')}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StateDot state={info.state} />
            <h1 className="truncate text-[16px] font-semibold">{info.title}</h1>
            <Badge variant={info.state === 'working' ? 'working' : info.state === 'recent' ? 'recent' : 'outline'}>{stateLabel[info.state]}</Badge>
          </div>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="font-mono">{info.project}</span>
            {info.branch && (
              <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{info.branch}</span>
            )}
            {info.model && <span className="inline-flex items-center gap-1"><Sparkles className="size-3" />{info.model}</span>}
            <span>started {ago(info.started)} · updated {ago(info.updated)}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setTab('comments')}>
            <MessageSquarePlus /> {t('Message / steer')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => post({ type: 'linkSession', id: info.id })} title={t('Let this session\'s agent see what another session is doing')}>
            <Link2 /> {t('Link')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={() => post({ type: 'resume', id: info.id })}>
                <SquareTerminal /> {t('Open in chat')}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Continue this session in an Steerhouse chat')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat icon={FileCode2} label={t('edits')} value={info.edits} />
        <Stat icon={Files} label={t('files changed')} value={info.files.length} />
        <Stat icon={Wrench} label={t('tool calls')} value={info.tools} />
        <Stat icon={Bot} label={t('sub-agents')} value={info.agents.length} />
      </div>

      {info.linked.length > 0 && (
        <Card className="border-warn/30 bg-warn/5">
          <CardContent className="flex flex-wrap items-center gap-2 py-2.5">
            <Link2 className="text-warn size-4" />
            <span className="text-[12px]">{t('Changes files that these sessions also changed:')}</span>
            {info.linked.map((id) => (
              <Button key={id} size="xs" variant="outline" onClick={() => post({ type: 'openSession', id })}>
                {(data.linkedTitles[id] ?? id).slice(0, 40)}
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="activity">{t('Activity')}</TabsTrigger>
          <TabsTrigger value="changes">{t('Changes')} <span className="text-muted-foreground tabular-nums">{data.changes.length}</span></TabsTrigger>
          <TabsTrigger value="agents">{t('Sub-agents')} <span className="text-muted-foreground tabular-nums">{info.agents.length}</span></TabsTrigger>
          <TabsTrigger value="comments">
            {t('Messages')} {pending > 0 ? <Badge variant="warn" className="px-1 py-0">{pending}</Badge> : <span className="text-muted-foreground tabular-nums">{data.comments.length}</span>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <Timeline data={data} agentNames={agentNames} focus={focus} setFocus={setFocus} />
        </TabsContent>
        <TabsContent value="changes">
          <ChangesTab data={data} agentNames={agentNames} />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab info={info} onFocus={(id) => { setFocus(id); setTab('activity'); }} />
        </TabsContent>
        <TabsContent value="comments">
          <MessagesTab data={data} />
        </TabsContent>
      </Tabs>
      <p className="text-muted-foreground text-center text-[11px]">{base(info.project)} · session {info.id.slice(0, 8)}</p>
    </div>
  );
}
