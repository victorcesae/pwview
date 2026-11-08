import { Bot, FolderGit2, GitBranch, Link2, Plus, ShieldAlert, Sparkles } from 'lucide-react';
import { post } from '@/bridge';
import { DiffStat, StateDot, stateLabel } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ago, base, rel } from '@/lib/utils';
import { useState } from 'react';
import { GraphView } from './Graph';
import { UsageView } from './Usage';
import type { GraphData, HotFile, SessionInfo, UsageReport } from '@/types';
import { t } from '@/i18n';

function SessionRow({ s }: { s: SessionInfo }) {
  return (
    <button
      onClick={() => post({ type: 'openSession', id: s.id })}
      className="hover:bg-accent group flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors"
    >
      <StateDot state={s.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{s.title}</div>
        <div className="text-muted-foreground flex items-center gap-2 truncate text-[11px]">
          {s.branch && (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />
              {s.branch}
            </span>
          )}
          {s.lastPrompt && <span className="truncate">“{s.lastPrompt}”</span>}
        </div>
      </div>
      <div className="text-muted-foreground hidden shrink-0 items-center gap-2 text-[11px] sm:flex">
        {s.agents.length > 0 && (
          <Badge variant="agent">
            <Bot />
            {s.agents.length}
          </Badge>
        )}
        {s.linked.length > 0 && (
          <Badge variant="warn">
            <Link2 />
            {s.linked.length}
          </Badge>
        )}
        <span className="w-16 text-right tabular-nums">{s.edits} edits</span>
        <span className="w-16 text-right">{ago(s.updated)}</span>
      </div>
    </button>
  );
}

function HotFiles({ hot, sessions }: { hot: HotFile[]; sessions: SessionInfo[] }) {
  const title = (id: string) => sessions.find((s) => s.id === id)?.title ?? id;
  return (
    <Card className="border-warn/30">
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="text-warn size-4" /> {t('Linked changes')}
          </CardTitle>
          <CardDescription className="mt-1">The same files were changed by more than one session. Check that the changes fit together.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {hot.map((h) => (
          <div key={h.file} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <button className="cursor-pointer font-mono text-[12px] hover:underline" onClick={() => post({ type: 'openFile', path: h.file })}>
              {base(h.file)}
            </button>
            <span className="text-muted-foreground text-[11px]">{h.changes} edits · {ago(h.updated)}</span>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {h.sessions.map((id) => (
                <Button key={id} size="xs" variant="outline" onClick={() => post({ type: 'openSession', id })}>
                  {title(id).slice(0, 36)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function Overview({ data }: { data: { sessions: SessionInfo[]; hot: HotFile[]; hooks: boolean; graph?: GraphData; usage?: UsageReport } }) {
  const { sessions, hot, hooks } = data;
  const [view, setView] = useState<'list' | 'graph' | 'usage'>('list');
  const working = sessions.filter((s) => s.state === 'working');
  const byProject = new Map<string, SessionInfo[]>();
  for (const s of sessions) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-lg">
            <Sparkles className="size-4" />
          </div>
          <div>
            <h1 className="text-[16px] leading-tight font-semibold">{t('Agent sessions')}</h1>
            <p className="text-muted-foreground text-[12px]">
              {sessions.length} sessions · <span className="text-working">{working.length} working</span> · {byProject.size} projects
            </p>
          </div>
        </div>
        <div className="bg-muted ml-auto inline-flex rounded-lg p-[3px]">
          {(['list', 'graph', 'usage'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`h-6 cursor-pointer rounded-md px-2.5 text-[12px] font-medium capitalize ${view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              {v === 'list' ? t('List') : v === 'graph' ? t('Graph') : t('Usage')}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => post({ type: 'newSession' })}>
          <Plus /> {t('New session')}
        </Button>
      </header>

      {view === 'graph' && data.graph && <GraphView graph={data.graph} />}
      {view === 'usage' && data.usage && <UsageView report={data.usage} />}
      {view === 'list' && !hooks && (
        <Card className="border-warn/40 bg-warn/5">
          <CardContent className="flex flex-wrap items-center gap-3">
            <ShieldAlert className="text-warn size-4" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Comments can't reach agents yet</div>
              <div className="text-muted-foreground text-[12px]">Install two Claude Code hooks so the comments you leave on changes are handed to the agent.</div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => post({ type: 'installHooks' })}>
              Enable comment delivery
            </Button>
          </CardContent>
        </Card>
      )}

      {view === 'list' && working.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2">
          {working.map((s) => (
            <Card key={s.id} className="border-working/30 hover:border-working/60 cursor-pointer transition-colors" onClick={() => post({ type: 'openSession', id: s.id })}>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2">
                    <StateDot state={s.state} />
                    <span className="truncate">{s.title}</span>
                  </CardTitle>
                  <CardDescription className="mt-1.5 truncate">{base(s.project)}{s.branch ? ` · ${s.branch}` : ''}</CardDescription>
                </div>
                <Badge variant="working">{stateLabel[s.state]}</Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {s.agents.filter((a) => a.state === 'working').map((a) => (
                  <div key={a.id} className="text-muted-foreground flex items-center gap-2 text-[12px]">
                    <Bot className="text-agent size-3.5" />
                    <span className="truncate">{a.description}</span>
                  </div>
                ))}
                <div className="text-muted-foreground flex items-center gap-3 text-[11px]">
                  <span>{s.edits} edits · {s.files.length} files</span>
                  <span>{s.agents.length} sub-agents</span>
                  <span className="ml-auto">{ago(s.updated)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {view === 'list' && hot.length > 0 && <HotFiles hot={hot} sessions={sessions} />}

      {view === 'list' && [...byProject.entries()].map(([project, list]) => (
        <section key={project} className="flex flex-col gap-1">
          <h2 className="text-muted-foreground flex items-center gap-2 px-3 text-[11px] font-semibold tracking-wide uppercase">
            <FolderGit2 className="size-3.5" />
            {base(project)}
            <span className="font-normal normal-case">{project}</span>
          </h2>
          <div className="flex flex-col">
            {list.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </div>
        </section>
      ))}

      {!sessions.length && (
        <Card>
          <CardContent className="text-muted-foreground py-10 text-center">
            No agent sessions in the last days. Start one with <b>New session</b> or run <code>claude</code> in a terminal.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export { DiffStat, rel };
