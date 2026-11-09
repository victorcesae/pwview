// Keeps a chat's Claude Code running when VS Code reloads or closes. This small process is started
// detached and owns Claude Code; Steerhouse connects to it over a local socket and can reconnect.
// Runs on its own (no vscode module), as dist/relay.js.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';

export interface RelaySpec {
  id: string;
  /** where this relay records itself, readable only by this user */
  entryFile: string;
  socket: string;
  token: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  sessionId?: string;
  /** stop Claude Code after this long with nobody connected and nothing running */
  idleMs: number;
  /** ... and after this long with nobody connected even if it is still busy or waiting for an answer */
  orphanMs: number;
}

/** What a line from Claude Code says about its state. */
export function readFrame(line: string): { busy?: boolean; sessionId?: string } {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return {};
  }
  if (m?.type === 'result') return { busy: false };
  if (m?.type === 'assistant' || m?.type === 'stream_event' || (m?.type === 'user' && m.message)) return { busy: true };
  if (m?.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') return { sessionId: m.session_id };
  return {};
}

/** Calls back with each complete line. */
export function lineSplitter(onLine: (line: string) => void) {
  let rest = '';
  return (chunk: Buffer | string) => {
    rest += chunk.toString();
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

function main(specFile: string) {
  const spec: RelaySpec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  fs.rmSync(specFile, { force: true }); // it holds the account's environment
  let sessionId = spec.sessionId;
  let busy = false;
  let client: net.Socket | undefined;
  let timers: NodeJS.Timeout[] = [];

  const record = () => fs.writeFileSync(spec.entryFile, JSON.stringify({ id: spec.id, pid: process.pid, socket: spec.socket, token: spec.token, cwd: spec.cwd, sessionId }), { mode: 0o600 });
  const cleanup = () => {
    fs.rmSync(spec.entryFile, { force: true });
    if (process.platform !== 'win32') fs.rmSync(spec.socket, { force: true });
  };
  const send = (m: unknown) => client?.write(JSON.stringify(m) + '\n');

  const cli = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const stopCli = (signal: NodeJS.Signals = 'SIGTERM') => {
    if (!cli.killed) cli.kill(signal);
  };
  /** With nobody connected, nothing runs forever. */
  const watch = () => {
    timers.forEach(clearTimeout);
    timers = [];
    if (client) return;
    timers.push(setTimeout(stopCli, spec.orphanMs));
    // a chat that never got a message has nothing to come back to
    if (!busy) timers.push(setTimeout(stopCli, sessionId ? spec.idleMs : Math.min(spec.idleMs, 60_000)));
  };

  const fromCli = lineSplitter((line) => {
    const f = readFrame(line);
    if (f.sessionId && f.sessionId !== sessionId) {
      sessionId = f.sessionId;
      record();
    }
    if (f.busy !== undefined && f.busy !== busy) {
      busy = f.busy;
      if (!client) watch();
    }
    // with nobody connected it is dropped: what matters is in the transcript, and Claude Code
    // hands over what is still waiting for an answer when a client initializes again
    client?.write(line + '\n');
  });
  cli.stdout!.on('data', fromCli);
  cli.stdin!.on('error', () => {});

  const server = net.createServer((sock) => {
    let authed = false;
    sock.on('error', () => sock.destroy());
    const fromClient = lineSplitter((line) => {
      if (!authed) {
        if (line !== spec.token) return sock.destroy();
        authed = true;
        client?.destroy(); // the newest window takes over
        client = sock;
        watch();
        send({ type: 'relay_hello', busy, sessionId });
        return;
      }
      if (line.startsWith('{"type":"relay_')) {
        const m = JSON.parse(line);
        if (m.type === 'relay_kill') stopCli(m.signal);
        if (m.type === 'relay_end') cli.stdin!.end();
        return;
      }
      if (/^\{"type":"user"/.test(line)) busy = true;
      if (cli.stdin!.writable) cli.stdin!.write(line + '\n');
    });
    sock.on('data', fromClient);
    sock.on('close', () => {
      if (client === sock) {
        client = undefined;
        watch();
      }
    });
  });

  cli.on('exit', (code, signal) => {
    send({ type: 'relay_exit', code, signal });
    cleanup();
    server.close();
    if (client) client.end(() => process.exit(0));
    else process.exit(0);
    setTimeout(() => process.exit(0), 500);
  });
  cli.on('error', () => {
    cleanup();
    process.exit(1);
  });
  process.on('SIGTERM', () => stopCli());
  process.on('SIGHUP', () => {}); // the SSH session or terminal going away is the point of this process

  server.listen(spec.socket, () => {
    if (process.platform !== 'win32') fs.chmodSync(spec.socket, 0o600);
    record();
    watch();
  });
}

if (require.main === module) main(process.argv[2]);
