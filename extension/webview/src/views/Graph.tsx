import { graphlib, layout } from '@dagrejs/dagre';
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Bot, FileCode2, MessageSquare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { post } from '@/bridge';
import { StateDot } from '@/components/common';
import { Button } from '@/components/ui/button';
import { ago, base, cn } from '@/lib/utils';
import type { GraphData, GNode, State } from '@/types';

const SIZE: Record<GNode['type'], { w: number; h: number }> = {
  session: { w: 240, h: 64 },
  prompt: { w: 260, h: 78 },
  agent: { w: 220, h: 56 },
  file: { w: 200, h: 48 },
};

function Frame({ children, className, onClick, title }: { children: React.ReactNode; className?: string; onClick?: () => void; title?: string }) {
  return (
    <div
      title={title}
      onClick={onClick}
      className={cn('bg-card text-card-foreground h-full w-full cursor-pointer overflow-hidden rounded-lg border px-2.5 py-1.5 text-[12px] shadow-sm transition-colors hover:border-ring', className)}
    >
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-[var(--border)]" />
      {children}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-[var(--border)]" />
    </div>
  );
}

function SessionNode({ data }: NodeProps<Node<Extract<GNode, { type: 'session' }>['data']>>) {
  return (
    <Frame className="border-primary/40" onClick={() => post({ type: 'openSession', id: data.sessionId })} title={data.project}>
      <div className="flex items-center gap-1.5">
        <StateDot state={data.state as State} className="size-2" />
        <span className="truncate font-semibold">{data.title}</span>
      </div>
      <div className="text-muted-foreground mt-0.5 truncate text-[11px]">
        {base(data.project)}
        {data.branch ? ` · ${data.branch}` : ''}
      </div>
    </Frame>
  );
}

function PromptNode({ data }: NodeProps<Node<Extract<GNode, { type: 'prompt' }>['data']>>) {
  return (
    <Frame onClick={() => post({ type: 'openSession', id: data.sessionId })} title={data.text}>
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10.5px]">
        <MessageSquare className="size-3" />
        Prompt {data.index} · {ago(data.ts)}
        {data.edits > 0 && <span className="text-added ml-auto">{data.edits} edits</span>}
      </div>
      <div className="mt-0.5 line-clamp-2 leading-snug">{data.text}</div>
    </Frame>
  );
}

function AgentNode({ data }: NodeProps<Node<Extract<GNode, { type: 'agent' }>['data']>>) {
  return (
    <Frame className="border-agent/40" onClick={() => post({ type: 'openSession', id: data.sessionId, agentId: data.agentId })} title={data.description}>
      <div className="text-agent flex items-center gap-1.5 text-[10.5px]">
        <Bot className="size-3" /> Sub-agent {data.edits > 0 && <span className="text-muted-foreground">· {data.edits} edits</span>}
        {data.state === 'working' && <StateDot state="working" className="ml-auto size-2" />}
      </div>
      <div className="truncate">{data.description}</div>
    </Frame>
  );
}

function FileNode({ data }: NodeProps<Node<Extract<GNode, { type: 'file' }>['data']>>) {
  return (
    <Frame className="border-warn/50 bg-warn/5" onClick={() => post({ type: 'openFile', path: data.path })} title={data.path}>
      <div className="flex items-center gap-1.5 font-mono text-[11.5px]">
        <FileCode2 className="text-warn size-3.5" />
        <span className="truncate">{base(data.path)}</span>
      </div>
      <div className="text-muted-foreground text-[10.5px]">
        {data.sessions} sessions · {data.edits} edits
      </div>
    </Frame>
  );
}

const nodeTypes = { session: SessionNode, prompt: PromptNode, agent: AgentNode, file: FileNode };


function layoutGraph(g: GraphData): { nodes: Node[]; edges: Edge[] } {
  const d = new graphlib.Graph();
  d.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 56 });
  d.setDefaultEdgeLabel(() => ({}));
  for (const n of g.nodes) d.setNode(n.id, { width: SIZE[n.type].w, height: SIZE[n.type].h });
  for (const e of g.edges) if (e.kind !== 'linked') d.setEdge(e.source, e.target);
  layout(d);
  const nodes: Node[] = g.nodes.map((n) => {
    const p = d.node(n.id);
    return { id: n.id, type: n.type, data: n.data, position: { x: p.x - SIZE[n.type].w / 2, y: p.y - SIZE[n.type].h / 2 }, style: { width: SIZE[n.type].w, height: SIZE[n.type].h } };
  });
  const color: Record<string, string> = { next: 'var(--border)', start: 'var(--border)', spawned: 'var(--agent)', edited: 'var(--warn)', linked: 'var(--working)' };
  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    animated: e.kind === 'linked',
    type: e.kind === 'linked' ? 'default' : 'smoothstep',
    style: { stroke: color[e.kind], strokeWidth: e.kind === 'next' || e.kind === 'start' ? 1.2 : 1.6, strokeDasharray: e.kind === 'linked' ? '6 4' : undefined },
    labelStyle: { fill: 'var(--muted-foreground)', fontSize: 10 },
    labelBgStyle: { fill: 'var(--background)' },
  }));
  return { nodes, edges };
}

export function GraphView({ graph }: { graph: GraphData }) {
  const projects = useMemo(() => [...new Set(graph.nodes.flatMap((n) => (n.type === 'session' ? [n.data.project] : [])))], [graph]);
  const [project, setProject] = useState<string>('all');
  const filtered = useMemo<GraphData>(() => {
    if (project === 'all') return graph;
    const keep = new Set(graph.nodes.filter((n) => n.type === 'session' && n.data.project === project).map((n) => (n as Extract<GNode, { type: 'session' }>).data.sessionId));
    const nodes = graph.nodes.filter((n) => (n.type === 'file' ? true : keep.has((n.data as { sessionId: string }).sessionId)));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    const used = new Set(edges.flatMap((e) => [e.source, e.target]));
    return { nodes: nodes.filter((n) => n.type !== 'file' || used.has(n.id)), edges };
  }, [graph, project]);
  const { nodes, edges } = useMemo(() => layoutGraph(filtered), [filtered]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Button size="xs" variant={project === 'all' ? 'secondary' : 'ghost'} onClick={() => setProject('all')}>
          All projects
        </Button>
        {projects.map((p) => (
          <Button key={p} size="xs" variant={project === p ? 'secondary' : 'ghost'} onClick={() => setProject(p)}>
            {base(p)}
          </Button>
        ))}
        <span className="text-muted-foreground ml-auto flex items-center gap-3">
          <span><span className="text-agent">━</span> spawned</span>
          <span><span className="text-warn">━</span> edited shared file</span>
          <span><span className="text-working">┅</span> linked by you</span>
        </span>
      </div>
      <div className="h-[calc(100vh-150px)] min-h-[420px] overflow-hidden rounded-xl border">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.15} proOptions={{ hideAttribution: true }} nodesConnectable={false} colorMode="system">
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
