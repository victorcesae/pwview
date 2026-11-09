// Mirrors src/engine.ts + src/comments.ts (the shapes the extension posts to the webview).
export type State = 'working' | 'recent' | 'idle';
export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface Change { id: string; sessionId: string; agentId?: string; timestamp: string; file: string; kind: 'edit' | 'create' | 'update'; added: number; removed: number; why: string; hunks: Hunk[] }
export interface TimelineEvent { ts: string; kind: 'prompt' | 'text' | 'tool' | 'change'; text: string; tool?: string; refId?: string; agentId?: string }
export interface AgentInfo { id: string; description: string; agentType: string; parentToolUseId: string; state: State; updated?: string; edits: number; tools: number }
export interface SessionInfo {
  id: string; project: string; title: string; firstPrompt?: string; lastPrompt?: string; branch?: string; model?: string;
  started?: string; updated?: string; state: State; edits: number; tools: number; files: string[]; linked: string[]; agents: AgentInfo[]; pendingComments: number;
}
export type Mode = 'steer' | 'queue' | 'now';
export interface Comment { id: string; sessionId: string; agentId?: string; file?: string; line?: number; snippet?: string; text: string; mode?: Mode; created: string; status: 'pending' | 'delivered' | 'cancelled'; deliveredAt?: string; deliveredVia?: 'step' | 'turn-end' | 'prompt' | 'terminal' }
export interface HotFile { file: string; sessions: string[]; changes: number; updated: string }

export type Data =
  | ChatData
  | { view: 'overview'; overview: { sessions: SessionInfo[]; hot: HotFile[]; hooks: boolean; graph?: GraphData; usage?: UsageReport } }
  | { view: 'session'; focusAgent?: string; session: { info: SessionInfo; events: TimelineEvent[]; changes: Change[]; comments: Comment[]; terminal?: boolean; linkedTitles: Record<string, string> } };

export type ToExtension =
  | { type: 'ready' }
  | { type: 'openSession'; id: string; agentId?: string }
  | { type: 'overview' }
  | { type: 'openUrl'; url: string }
  | { type: 'openChange'; sessionId: string; changeId: string }
  | { type: 'openFile'; path: string }
  | { type: 'resume'; id: string }
  | { type: 'message'; id: string; text: string; mode?: Mode; images?: { data: string; mime: string }[] }
  | { type: 'cancelComment'; commentId: string }
  | { type: 'editComment'; commentId: string; text: string }
  | { type: 'usage'; days: number }
  | { type: 'promoteComment'; commentId: string }
  | { type: 'linkSession'; id: string }
  | { type: 'newSession' }
  | { type: 'installHooks' }
  | { type: 'savePrompt'; text: string };

// ---- AgentLens chat (mirrors src/chat.ts)
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Priority = 'later' | 'next' | 'now';
export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string };
export type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
export type ChatItem =
  | { kind: 'user'; id: string; text: string; images: string[]; priority?: Priority; ts: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean; parent?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; status: 'running' | 'done' | 'error'; result?: string; file?: string; patch?: Hunk[]; parent?: string; elapsed?: number }
  | { kind: 'permission'; id: string; tool: string; summary: string; input: unknown; canAlways: boolean; status: 'pending' | 'allowed' | 'denied'; reason?: string }
  | { kind: 'plan'; id: string; plan: string; status: 'pending' | 'approved' | 'rejected' }
  | { kind: 'question'; id: string; questions: Question[]; status: 'pending' | 'answered'; answers?: Record<string, string> }
  | { kind: 'result'; id: string; text: string; isError: boolean; costUsd?: number; durationMs?: number }
  | { kind: 'system'; id: string; text: string };
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
export interface ChatState {
  key: string; sessionId?: string; cwd: string; title: string; model?: string; models: { value: string; displayName: string }[];
  permissionMode: PermissionMode; effort?: Effort; fastMode: boolean; ultracode: boolean; status: 'starting' | 'idle' | 'working' | 'waiting' | 'closed' | 'error'; activity?: string;
  todos: Todo[]; items: ChatItem[]; queue: { id: string; text: string; images: number; priority: 'later' | 'next' }[]; tokens?: number; context?: { used: number; max: number; percentage: number; detailed?: boolean; categories?: { id?: string; name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[] }; earlier: number; slashCommands: string[]; mcp: { name: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; tools: number; error?: string }[]; costUsd: number; account: { name: string; email?: string; organization?: string; plan?: string; provider?: string; gateway?: string }; host?: string; hostIcon?: string; limits?: Limits; prs?: Record<string, { state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown'; title?: string }>; error?: string;
}
export type LinkedSession = { id: string; title: string; state: State; activity?: string };
export type ChatData = { view: 'chat'; chat: ChatState; linked: LinkedSession[] };
export type ToChat =
  | { type: 'ready' }
  | { type: 'send'; text: string; images: { data: string; mime: string }[]; priority: Priority }
  | { type: 'promote'; id: string; priority?: Priority }
  | { type: 'cancelQueued'; id: string }
  | { type: 'editQueued'; id: string; text: string }
  | { type: 'interrupt' }
  | { type: 'loadEarlier'; all?: boolean }
  | { type: 'openUrl'; url: string }
  | { type: 'contextDetail' }
  | { type: 'toggleMcp'; name: string; enabled: boolean }
  | { type: 'reconnectMcp'; name: string }
  | { type: 'manageConnectors' }
  | { type: 'retry' }
  | { type: 'respond'; id: string; decision: 'allow' | 'always' | 'deny'; message?: string; answers?: Record<string, string> }
  | { type: 'setModel'; model: string }
  | { type: 'setEffort'; effort: Effort }
  | { type: 'setFast'; on: boolean }
  | { type: 'setUltracode'; on: boolean }
  | { type: 'setMode'; mode: PermissionMode }
  | { type: 'openFile'; path: string }
  | { type: 'openChange'; changeId: string }
  | { type: 'link' }
  | { type: 'unlink'; id: string }
  | { type: 'openSession'; id: string };

// ---- graph (mirrors src/graph.ts)
export type GNode =
  | { id: string; type: 'session'; data: { sessionId: string; title: string; state: string; project: string; branch?: string } }
  | { id: string; type: 'prompt'; data: { sessionId: string; text: string; ts: string; index: number; edits: number } }
  | { id: string; type: 'agent'; data: { sessionId: string; agentId: string; description: string; state: string; edits: number } }
  | { id: string; type: 'file'; data: { path: string; sessions: number; edits: number } };
export type GEdge = { id: string; source: string; target: string; kind: 'next' | 'spawned' | 'edited' | 'linked' | 'start'; label?: string };
export type GraphData = { nodes: GNode[]; edges: GEdge[] };

// ---- usage (mirrors src/usage.ts)
export type UsageBucket = { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number; unpriced: number };
export interface UsageReport {
  days: number;
  totals: UsageBucket;
  byModel: (UsageBucket & { model: string; label: string })[];
  byDay: { day: string; cost: number; tokens: number; byModel: Record<string, number> }[];
  byProject: (UsageBucket & { project: string })[];
  topSessions: (UsageBucket & { id: string; title: string; project: string })[];
}

export interface LimitWindow { id: string; label: string; pct: number; resetsAt?: string }
export interface Limits { available: boolean; plan?: string; windows: LimitWindow[]; extra?: { used: number; limit?: number; currency?: string; label: string }; source: 'claude' | 'openrouter' | 'none' }
