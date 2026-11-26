// Coding agents other than Claude Code, behind one interface: each runtime (Codex app-server, later
// ACP agents…) turns its own protocol into RuntimeEvents, and RuntimeChat folds those into the same
// ChatItems the Claude chat shows. No vscode imports here (tests run it in plain node).
import type { Hunk, Todo, Question } from '../chat';

export interface RuntimeCaps {
  /** a message can be added to the running turn */
  steer: boolean;
  fork: boolean;
  rewind: boolean;
  thinking: boolean;
  todos: boolean;
  subagents: boolean;
  approvals: boolean;
  images: boolean;
  effort: boolean;
  permissionModes: boolean;
}

export interface RuntimeDetect {
  exe?: string;
  version?: string;
  authed: boolean;
  /** how to log in, when not */
  loginHint: string;
}

export type ToolKind = 'run' | 'edit' | 'read' | 'search' | 'browser' | 'mcp' | 'agent' | 'other';
export type Decision = 'allow' | 'allowAlways' | 'deny';

export type RuntimeEvent =
  | { type: 'sessionId'; id: string }
  | { type: 'status'; status: 'idle' | 'working' | 'error'; activity?: string; error?: string }
  | { type: 'model'; model: string }
  | { type: 'textDelta'; id: string; delta: string }
  | { type: 'textDone'; id: string; text?: string }
  | { type: 'thinkingDelta'; id: string; delta: string }
  | { type: 'thinkingDone'; id: string }
  | { type: 'toolStart'; id: string; name: string; kind: ToolKind; summary: string; input: unknown }
  | { type: 'toolOutput'; id: string; delta: string }
  | { type: 'toolEnd'; id: string; status: 'done' | 'error'; result?: string; patch?: Hunk[]; file?: string }
  | { type: 'permission'; requestId: string; tool: string; summary: string; input: unknown; canAlways: boolean }
  | { type: 'question'; requestId: string; questions: Question[] }
  | { type: 'plan'; text: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'notice'; text: string; /** a later notice with the same key replaces it (retries) */ key?: string }
  | { type: 'turnEnd'; usage?: { input: number; output: number; total: number; contextWindow?: number }; costUsd?: number; error?: string; interrupted?: boolean };

export interface RuntimeStartOptions {
  cwd: string;
  model?: string;
  /** thread / session to reopen */
  resume?: string;
  /** executable override (tests point this at a fake server) */
  executable?: string;
  env?: Record<string, string | undefined>;
}

export interface RuntimeSession {
  send(text: string, images: string[], files: string[]): Promise<void>;
  steer?(text: string, images: string[]): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, decision: Decision, extra?: { reason?: string; answers?: Record<string, string> }): void;
  setModel?(model: string): Promise<void>;
  listModels(): Promise<{ value: string; displayName: string }[]>;
  events: AsyncIterable<RuntimeEvent>;
  close(): void;
}

export interface AgentRuntime {
  id: string;
  label: string;
  /** VendorMark / media/vendors/<vendor>.svg */
  vendor: string;
  caps: RuntimeCaps;
  detect(): Promise<RuntimeDetect>;
  start(opts: RuntimeStartOptions): RuntimeSession;
}

/** A push-pull queue: events pushed by the adapter, read with for await. */
export class EventQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiting?: (r: IteratorResult<T>) => void;
  private done = false;
  push(v: T) {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w({ value: v, done: false });
    } else this.buf.push(v);
  }
  end() {
    this.done = true;
    this.waiting?.({ value: undefined as any, done: true });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}
