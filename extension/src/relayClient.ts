// Steerhouse's side of the relay (relay.ts): start one, find one after a reload, and look like the
// process the Agent SDK expects (spawnClaudeCodeProcess).
import { spawn } from 'child_process';
import { randomBytes, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Writable } from 'stream';
import { dataDir } from './paths';
import { lineSplitter, type RelaySpec } from './relay';

export const IDLE_MS = 15 * 60_000;
export const ORPHAN_MS = 24 * 60 * 60_000;

export interface RelayEntry {
  id: string;
  pid: number;
  socket: string;
  token: string;
  cwd?: string;
  sessionId?: string;
}

const dir = () => {
  const d = path.join(dataDir(), 'relays');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

// VS Code is going away (reload, closing): the SDK then kills what it spawned, which must not reach the relay
let shuttingDown = false;
export const setShuttingDown = () => {
  shuttingDown = true;
};
export const isShuttingDown = () => shuttingDown;
process.on('exit', setShuttingDown);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function listRelays(): RelayEntry[] {
  const out: RelayEntry[] = [];
  for (const f of fs.readdirSync(dir())) {
    if (!f.endsWith('.json') || f.endsWith('.spec.json')) continue;
    const file = path.join(dir(), f);
    try {
      const e: RelayEntry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (alive(e.pid)) out.push(e);
      else fs.rmSync(file, { force: true });
    } catch {
      /* being written */
    }
  }
  return out;
}

export const findRelay = (sessionId: string) => listRelays().find((e) => e.sessionId === sessionId);

export function socketPath(id: string, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\steerhouse-${id}` : path.join(os.tmpdir(), `steerhouse-${id.slice(0, 12)}.sock`);
}

/** Starts a detached relay that runs this command; returns how to connect to it. */
export function startRelay(script: string, o: { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; sessionId?: string; idleMs?: number; orphanMs?: number }): RelayEntry {
  const id = randomUUID().replace(/-/g, '');
  const token = randomBytes(24).toString('hex');
  const entryFile = path.join(dir(), `${id}.json`);
  const specFile = path.join(dir(), `${id}.spec.json`);
  const spec: RelaySpec = { id, entryFile, socket: socketPath(id), token, command: o.command, args: o.args, cwd: o.cwd, env: o.env, sessionId: o.sessionId, idleMs: o.idleMs ?? IDLE_MS, orphanMs: o.orphanMs ?? ORPHAN_MS };
  fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
  // inside the desktop editor process.execPath is Electron: this makes it plain Node
  const child = spawn(process.execPath, [script, specFile], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.on('error', () => {});
  child.unref();
  return { id, pid: child.pid ?? 0, socket: spec.socket, token, cwd: o.cwd, sessionId: o.sessionId };
}

/** The relay as a process for the SDK: stdin and stdout go through the socket. */
export class RelayProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin: Writable;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private sock?: net.Socket;
  private pending: string[] = [];
  private finished = false;
  /** whether a turn was running when this connected */
  readonly hello: Promise<{ busy: boolean; sessionId?: string }>;
  private resolveHello!: (h: { busy: boolean; sessionId?: string }) => void;

  constructor(private entry: RelayEntry, private connectMs = 5000) {
    super();
    this.hello = new Promise((r) => (this.resolveHello = r));
    this.stdin = new Writable({
      write: (chunk, _enc, done) => {
        this.send(chunk.toString());
        done();
      },
      final: (done) => {
        if (!shuttingDown) this.send('{"type":"relay_end"}\n');
        done();
      },
    });
    this.connect(Date.now());
  }

  private send(text: string) {
    if (this.sock) this.sock.write(text);
    else this.pending.push(text);
  }

  private connect(started: number) {
    const sock = net.connect(this.entry.socket);
    let up = false;
    sock.on('connect', () => {
      up = true;
      sock.write(this.entry.token + '\n');
      this.sock = sock;
      this.pending.splice(0).forEach((t) => sock.write(t));
    });
    const lines = lineSplitter((line) => {
      if (line.startsWith('{"type":"relay_')) {
        const m = JSON.parse(line);
        if (m.type === 'relay_hello') this.resolveHello({ busy: !!m.busy, sessionId: m.sessionId });
        if (m.type === 'relay_exit') this.finish(m.code ?? null, m.signal ?? null);
        return;
      }
      this.stdout.write(line + '\n');
    });
    sock.on('data', lines);
    sock.on('error', () => {
      // the relay is still starting
      if (!up && Date.now() - started < this.connectMs) setTimeout(() => this.connect(started), 50);
      else if (!up) this.finish(1, null, new Error('Could not connect to the process running this chat'));
    });
    sock.on('close', () => {
      if (up) this.finish(1, null);
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, error?: Error) {
    if (this.finished) return;
    this.finished = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.resolveHello({ busy: false });
    this.stdout.end();
    if (error) this.emit('error', error);
    this.emit('exit', code, signal);
    this.sock?.destroy();
  }

  kill(signal: NodeJS.Signals) {
    if (shuttingDown || this.finished) return false;
    this.killed = true;
    this.send(JSON.stringify({ type: 'relay_kill', signal }) + '\n');
    return true;
  }
}
