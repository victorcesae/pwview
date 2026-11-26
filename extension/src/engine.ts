// Reads Claude Code's own transcripts (~/.claude/projects/<project>/<session>.jsonl and
// <session>/subagents/agent-*.jsonl) and turns them into sessions, sub-agents, timelines
// and file changes with exact before/after content. No vscode imports: unit-testable.
import { BgTaskTracker, textsOf, type BgTask } from './bgtasks';
import * as fs from 'fs';
import * as path from 'path';
import { loadComments } from './comments';
import { claudeDir, norm } from './paths';

export interface UsageRow {
  ts: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export type State = 'working' | 'recent' | 'idle';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface Change {
  id: string;
  sessionId: string;
  agentId?: string;
  timestamp: string;
  file: string;
  kind: 'edit' | 'create' | 'update';
  added: number;
  removed: number;
  why: string;
  hunks: Hunk[];
}

export interface TimelineEvent {
  ts: string;
  kind: 'prompt' | 'text' | 'tool' | 'change';
  text: string;
  tool?: string;
  refId?: string;
  agentId?: string;
  /** a message the developer sent while the agent was working (steer / queue) */
  midTurn?: boolean;
}

export interface Transcript {
  cwd?: string;
  branch?: string;
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  started?: string;
  updated?: string;
  model?: string;
  events: TimelineEvent[];
  changes: Change[];
  pending: Set<string>;
  usage: UsageRow[];
  toolCount: number;
  /** commands the agent left running in the background (dev servers, watchers…) */
  tasks: BgTask[];
}

export interface AgentInfo {
  id: string;
  /** stopped by the user (Claude Code's meta file says so), or its last turn was interrupted */
  stopped?: boolean;
  /** what it did last, one line (for "Working · …") */
  doing?: string;
  description: string;
  agentType: string;
  parentToolUseId: string;
  state: State;
  updated?: string;
  edits: number;
  tools: number;
}

export interface SessionInfo {
  adapter: 'claude-code';
  account: string;
  id: string;
  project: string;
  title: string;
  firstPrompt?: string;
  lastPrompt?: string;
  branch?: string;
  model?: string;
  started?: string;
  updated?: string;
  state: State;
  edits: number;
  tools: number;
  files: string[];
  linked: string[];
  agents: AgentInfo[];
  pendingComments: number;
}

export interface Session {
  info: SessionInfo;
  path: string;
  t: Transcript;
  agents: { info: AgentInfo; path: string; t: Transcript }[];
}

export interface HotFile {
  file: string;
  sessions: string[];
  changes: number;
  updated: string;
}

const clip = (s: string, n: number) => {
  s = s.trim();
  return s.length <= n ? s : s.slice(0, n) + '…';
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Where an incremental read stopped: the byte after the last complete line. */
export interface ReadPos {
  offset: number;
}

function* records(file: string, pos?: ReadPos): Generator<any> {
  let text: string;
  try {
    if (!pos) text = fs.readFileSync(file, 'utf8');
    else {
      // only what was appended since the last read, up to the last complete line
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.max(0, size - pos.offset));
        const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, pos.offset) : 0;
        let end = buf.lastIndexOf(0x0a, n - 1) + 1;
        // a last line without its newline counts once it is complete JSON (else it is still being written)
        if (end < n) {
          try {
            JSON.parse(buf.subarray(end, n).toString('utf8'));
            end = n;
          } catch {
            /* half-written: read next time */
          }
        }
        text = buf.subarray(0, end).toString('utf8');
        pos.offset += end;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      /* partial line while the agent is writing */
    }
  }
}

function summarize(name: string, input: any): string {
  const f = (k: string) => str(input?.[k]);
  let out: string;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      out = f('command');
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      out = f('file_path');
      break;
    case 'Grep':
      out = `${f('pattern')}  ${f('path')}`;
      break;
    case 'Glob':
      out = f('pattern');
      break;
    case 'Agent':
    case 'Task':
      out = f('description');
      break;
    case 'WebFetch':
      out = f('url');
      break;
    case 'WebSearch':
      out = f('query');
      break;
    default:
      out = JSON.stringify(input ?? {});
  }
  return clip(out, 200);
}

const NOISE = ['<system-reminder>', '<local-command', '<command-', 'Caveat:', '[Request interrupted'];
const isNoise = (t: string) => {
  const s = t.trimStart();
  return !s || NOISE.some((n) => s.startsWith(n));
};

function changeFrom(r: any, id: string, sid: string, aid: string | undefined, ts: string, why: string): Change | undefined {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return;
  const kind = r.type === 'create' ? 'create' : r.type === 'update' ? 'update' : 'oldString' in r ? 'edit' : undefined;
  if (!kind) return;
  if (!Array.isArray(r.structuredPatch) && kind !== 'create') return;
  const hunks: Hunk[] = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines ?? []) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  if (kind === 'create' && added === 0) added = str(r.content).split('\n').length;
  return { id, sessionId: sid, agentId: aid, timestamp: ts, file: r.filePath, kind, added, removed, why: clip(why, 1200), hunks };
}

/** A parse that can go on: the transcript so far and the parser's own state (kept in memory only). */
export interface ParseState {
  t: Transcript;
  bg: BgTaskTracker;
  whyByTool: Map<string, string>;
  usageById: Map<string, UsageRow>;
  lastText: string;
  pos: ReadPos;
}

export function parse(file: string, sid: string, aid?: string): Transcript {
  return parseFrom(file, sid, aid).t;
}

/** Parses a transcript, or only what was appended since `state` (a live session's file grows all the time). */
export function parseFrom(file: string, sid: string, aid?: string, state?: ParseState): ParseState {
  const st: ParseState = state ?? { t: { events: [], changes: [], pending: new Set(), toolCount: 0, usage: [], tasks: [] }, bg: new BgTaskTracker(), whyByTool: new Map(), usageById: new Map(), lastText: '', pos: { offset: 0 } };
  const { t, bg, whyByTool } = st;
  // one reply is written as several records that repeat the same usage: count each reply once
  const usageById = st.usageById;
  let lastText = st.lastText;

  for (const rec of records(file, st.pos)) {
    const ts = str(rec.timestamp);
    if (ts) {
      t.started ??= ts;
      t.updated = ts;
    }
    // The project is where the session started; later `cd`s don't move it.
    if (typeof rec.cwd === 'string') t.cwd ??= rec.cwd;
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) t.branch = rec.gitBranch;

    // task notifications can arrive in any record (a user message, an attachment, a queued command)
    if (rec.type === 'user' || rec.type === 'attachment' || rec.type === 'queue-operation') bg.text(textsOf(rec.message?.content ?? rec.attachment ?? rec.content), ts);
    switch (rec.type) {
      case 'custom-title':
        t.title = str(rec.customTitle) || t.title;
        break;
      case 'last-prompt':
        t.lastPrompt = str(rec.lastPrompt) || t.lastPrompt;
        break;
      case 'attachment': {
        // messages sent while the agent was working (steer / queue) are stored as queued commands
        const a = rec.attachment;
        if (a?.type === 'queued_command') {
          const text = typeof a.prompt === 'string' ? a.prompt : (a.prompt ?? []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n');
          if (text.trim() && !isNoise(text)) t.events.push({ ts: ts || str(a.timestamp), kind: 'prompt', text: clip(text, 3000), agentId: aid, midTurn: true });
        }
        break;
      }
      case 'assistant': {
        const model = str(rec.message?.model);
        if (model && !model.startsWith('<')) t.model = model;
        const u = rec.message?.usage;
        const mid = str(rec.message?.id);
        if (u && mid && model && !model.startsWith('<')) {
          const row: UsageRow = {
            ts,
            model,
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
          };
          const prev = usageById.get(mid);
          if (!prev) {
            usageById.set(mid, row);
            t.usage.push(row);
          } else prev.output = Math.max(prev.output, row.output); // a later record may carry the final count
        }
        for (const c of rec.message?.content ?? []) {
          if (c.type === 'text' && str(c.text).trim()) {
            lastText = c.text;
            t.events.push({ ts, kind: 'text', text: clip(c.text, 1500), agentId: aid });
          } else if (c.type === 'tool_use') {
            t.toolCount++;
            t.pending.add(c.id);
            bg.toolUse(c.id, c.name, c.input, ts, aid);
            whyByTool.set(c.id, lastText);
            t.events.push({ ts, kind: 'tool', tool: c.name, text: summarize(c.name, c.input), refId: c.id, agentId: aid });
          }
        }
        break;
      }
      case 'user': {
        if (rec.isMeta) break;
        const content = rec.message?.content;
        const prompt = (text: string) => {
          if (isNoise(text)) return;
          t.firstPrompt ??= clip(text, 300);
          t.events.push({ ts, kind: 'prompt', text: clip(text, 3000), agentId: aid });
        };
        if (typeof content === 'string') prompt(content);
        else
          for (const c of content ?? []) {
            if (c.type === 'tool_result') {
              t.pending.delete(c.tool_use_id);
              bg.toolResult(c.tool_use_id, textsOf(c.content), ts);
              // Resumed/compacted sessions can replay the same tool result: count each change once.
              if (t.changes.some((x) => x.id === c.tool_use_id)) continue;
              const ch = changeFrom(rec.toolUseResult, c.tool_use_id, sid, aid, ts, whyByTool.get(c.tool_use_id) ?? '');
              if (ch) {
                t.events.push({ ts, kind: 'change', text: ch.file, refId: ch.id, agentId: aid });
                t.changes.push(ch);
              }
            } else if (c.type === 'text') prompt(str(c.text));
          }
        break;
      }
    }
  }
  t.tasks = bg.tasks;
  st.lastText = lastText;
  return st;
}

/** Full-file before/after for one change, re-read on demand to keep memory small. */
export function changeDetail(file: string, toolUseId: string): { original: string | null; after: string | null } | undefined {
  for (const rec of records(file)) {
    const content = rec.message?.content;
    if (!Array.isArray(content) || !content.some((c: any) => c.tool_use_id === toolUseId)) continue;
    const r = rec.toolUseResult ?? {};
    const original: string | null = typeof r.originalFile === 'string' ? r.originalFile : null;
    let after: string | null = null;
    if (typeof r.content === 'string') after = r.content;
    else if (original !== null && typeof r.oldString === 'string') {
      after = r.replaceAll ? original.split(r.oldString).join(r.newString) : original.replace(r.oldString, () => r.newString);
    }
    return { original, after };
  }
  return undefined;
}

function stateOf(mtimeMs: number, pending: boolean): State {
  const age = Date.now() - mtimeMs;
  if (age < 20_000 || (pending && age < 600_000)) return 'working';
  if (age < 900_000) return 'recent';
  return 'idle';
}

const modifiedSince = (file: string, cutoff: number) => {
  try {
    return fs.statSync(file).mtimeMs >= cutoff;
  } catch {
    return false;
  }
};

/** The folder a transcript ran in (its first `cwd`), from the start of the file only. */
export function transcriptCwd(file: string, bytes = 256 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0));
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(text);
    return m ? JSON.parse(m[1]) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Every transcript of a project in these transcript folders, also those too old to be listed,
 * without parsing them. Checks each file's folder: two projects can share a transcript folder,
 * because its name flattens the path (a/b and a-b).
 */
export function projectTranscripts(project: string, dirs: string[]): { id: string; path: string }[] {
  const out: { id: string; path: string }[] = [];
  for (const dir of new Set(dirs)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      if (transcriptCwd(file) === project) out.push({ id: n.slice(0, -'.jsonl'.length), path: file });
    }
  }
  return out;
}

export class Engine {
  private cache = new Map<string, { key: string; t: Transcript }>();
  /** set when a transcript was parsed since the cache was last saved */
  private dirty = false;

  /**
   * The parsed transcripts, kept on disk between VS Code sessions: reading 200 MB of transcripts
   * takes ~10 s at startup, loading this takes ~20 ms. Entries are checked against each file's
   * mtime and size as before, so a stale one is simply parsed again.
   */
  restoreCache(file: string, version: string) {
    try {
      const saved = require('v8').deserialize(fs.readFileSync(file)) as { version: string; entries: [string, { key: string; t: Transcript }][]; live?: [string, ParseState][] };
      if (saved?.version !== version || !Array.isArray(saved.entries)) return;
      for (const [k, v] of saved.entries) if (!this.cache.has(k)) this.cache.set(k, v);
      // where reading stopped in sessions that were still being written: after a restart they go on from there
      for (const [k, st] of saved.live ?? []) {
        if (this.live.has(k)) continue;
        Object.setPrototypeOf(st.bg, BgTaskTracker.prototype);
        this.live.set(k, st);
      }
    } catch {
      /* none yet, or unreadable: parsed again */
    }
  }

  /** Writes the cache when something new was parsed (only transcripts that still exist). */
  saveCache(file: string, version: string) {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const entries = [...this.cache.entries()].filter(([k]) => fs.existsSync(k));
      // only sessions written in the last two days: those are the ones that keep growing
      const recent = Date.now() - 2 * 86_400_000;
      const live = [...this.live.entries()].filter(([k]) => {
        try {
          return fs.statSync(k).mtimeMs > recent;
        } catch {
          return false;
        }
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, require('v8').serialize({ version, entries, live }));
      fs.renameSync(tmp, file);
    } catch {
      /* best effort: next start parses again */
    }
  }

  /** One transcript root per Claude account (each account has its own config folder). */
  constructor(private roots: () => { account: string; dir: string }[] = () => [{ account: 'default', dir: path.join(claudeDir(), 'projects') }]) {}

  private load(file: string, sid: string, aid?: string): { mtime: number; t: Transcript } | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = this.cache.get(file);
    if (hit && hit.key === key) return { mtime: st.mtimeMs, t: hit.t };
    // grown since the last read (a session being written right now): parse only the new lines
    const prev = this.live.get(file);
    const state = prev && st.size >= prev.pos.offset ? parseFrom(file, sid, aid, prev) : parseFrom(file, sid, aid);
    this.live.set(file, state);
    const t = state.t;
    this.cache.set(file, { key, t });
    this.dirty = true;
    return { mtime: st.mtimeMs, t };
  }
  /** parser state of transcripts read in this session, to go on from where they were read */
  private live = new Map<string, ParseState>();

  scan(days: number): Session[] {
    const cutoff = Date.now() - days * 86_400_000;
    const comments = loadComments();
    const out: Session[] = [];
    const ls = (d: string) => {
      try {
        return fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    for (const { account, dir: rootDir } of this.roots()) for (const dir of ls(rootDir)) {
      if (!dir.isDirectory()) continue;
      const pdir = path.join(rootDir, dir.name);
      for (const f of ls(pdir)) {
        if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
        const file = path.join(pdir, f.name);
        const sid = f.name.slice(0, -'.jsonl'.length);
        // the date comes first: parsing every old transcript takes a minute and gigabytes of memory
        if (!modifiedSince(file, cutoff)) continue;
        const loaded = this.load(file, sid);
        if (!loaded || !loaded.t.events.length) continue;
        const { t } = loaded;

        const agents: Session['agents'] = [];
        let newest = loaded.mtime;
        const subdir = path.join(pdir, sid, 'subagents');
        for (const a of ls(subdir)) {
          if (!a.name.endsWith('.jsonl')) continue;
          const apath = path.join(subdir, a.name);
          const aid = a.name.slice(0, -'.jsonl'.length).replace(/^agent-/, '');
          const al = this.load(apath, sid, aid);
          if (!al) continue;
          newest = Math.max(newest, al.mtime);
          let meta: any = {};
          try {
            meta = JSON.parse(fs.readFileSync(apath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
          } catch {
            /* older Claude Code versions have no meta file */
          }
          agents.push({
            path: apath,
            t: al.t,
            info: {
              id: aid,
              description: str(meta.description) || al.t.firstPrompt || aid,
              agentType: str(meta.agentType),
              parentToolUseId: str(meta.toolUseId),
              stopped: !!meta.stoppedByUser || /Request interrupted by user/.test(al.t.events.at(-1)?.text ?? ''),
              doing: al.t.events.filter((e) => e.text).at(-1)?.text?.replace(/\s+/g, ' ').slice(0, 120),
              // stopped is final; a tool call still open (a long command) keeps it working for a while
              state: meta.stoppedByUser ? 'idle' : stateOf(al.mtime, al.t.pending.size > 0),
              updated: al.t.updated,
              edits: al.t.changes.length,
              tools: al.t.toolCount,
            },
          });
        }
        agents.sort((a, b) => (a.info.updated ?? '').localeCompare(b.info.updated ?? ''));
        const files = new Set<string>(t.changes.map((c) => c.file));
        agents.forEach((a) => a.t.changes.forEach((c) => files.add(c.file)));
        const ownState = stateOf(newest, t.pending.size > 0);
        const updated = [t.updated, ...agents.map((a) => a.info.updated)].filter(Boolean).sort().pop();

        out.push({
          path: file,
          t,
          agents,
          info: {
            adapter: 'claude-code',
            account,
            id: sid,
            project: t.cwd ?? dir.name,
            // one line: a prompt's line breaks would show as ⏎ in lists and tab titles
            title: (t.title ?? t.firstPrompt ?? '(untitled)').replace(/\s+/g, ' ').trim() || '(untitled)',
            firstPrompt: t.firstPrompt,
            lastPrompt: t.lastPrompt,
            branch: t.branch,
            model: t.model,
            started: t.started,
            updated,
            state: agents.some((a) => a.info.state === 'working') ? 'working' : ownState,
            edits: t.changes.length + agents.reduce((n, a) => n + a.info.edits, 0),
            tools: t.toolCount + agents.reduce((n, a) => n + a.info.tools, 0),
            files: [...files].sort(),
            linked: [],
            agents: agents.map((a) => a.info),
            pendingComments: comments.filter((c) => c.sessionId === sid && c.status === 'pending').length,
          },
        });
      }
    }
    // A session moved to another folder (worktree, relocation) leaves a copy of its transcript in
    // both project dirs: keep only the most recently updated copy of each session id.
    const newestById = new Map<string, Session>();
    for (const s of out) {
      const prev = newestById.get(s.info.id);
      if (!prev || (s.info.updated ?? '') > (prev.info.updated ?? '')) newestById.set(s.info.id, s);
    }
    out.splice(0, out.length, ...newestById.values());

    // Sessions that changed the same files are linked.
    const byFile = new Map<string, Set<string>>();
    for (const s of out) for (const f of s.info.files) (byFile.get(norm(f)) ?? byFile.set(norm(f), new Set()).get(norm(f))!).add(s.info.id);
    for (const s of out) {
      const linked = new Set<string>();
      for (const f of s.info.files) byFile.get(norm(f))!.forEach((id) => id !== s.info.id && linked.add(id));
      s.info.linked = [...linked];
    }
    out.sort((a, b) => (b.info.updated ?? '').localeCompare(a.info.updated ?? ''));
    return out;
  }

  static allChanges(s: Session): Change[] {
    return [...s.t.changes, ...s.agents.flatMap((a) => a.t.changes)].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  static hotFiles(sessions: Session[]): HotFile[] {
    const m = new Map<string, HotFile>();
    for (const s of sessions)
      for (const c of Engine.allChanges(s)) {
        const k = norm(c.file);
        const h = m.get(k) ?? { file: c.file, sessions: [], changes: 0, updated: '' };
        if (!h.sessions.includes(s.info.id)) h.sessions.push(s.info.id);
        h.changes++;
        if (c.timestamp > h.updated) h.updated = c.timestamp;
        m.set(k, h);
      }
    return [...m.values()].filter((h) => h.sessions.length > 1).sort((a, b) => b.updated.localeCompare(a.updated));
  }

  static transcriptPath(s: Session, agentId?: string): string | undefined {
    return agentId ? s.agents.find((a) => a.info.id === agentId)?.path : s.path;
  }
}
