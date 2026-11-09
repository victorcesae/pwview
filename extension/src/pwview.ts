// pwview without any setup: every chat in a web project can drive a shared browser. Steerhouse finds
// or downloads pwview and connects it to the chat. pwview starts the browser (and downloads Chromium
// if needed) on the first browser action only, so opening a chat costs nothing.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LiveBrowser } from './liveBrowser';
import { which } from './util';

/** The pwview release Steerhouse needs (for `status --json` and starting the browser on demand). */
export const PWVIEW_VERSION = '0.2.1';
const RELEASES = 'https://github.com/victorcesae/pwview/releases/download';

export interface PwviewStatus {
  root: string;
  running: boolean;
  mode: string | null;
  ports: { ui: number; report: number; cdp: number; novnc: number; vnc: number };
  display: number;
}

/** The release file for this computer, when there is one. */
export function assetFor(platform: string, arch: string): string | undefined {
  return ({ 'linux-x64': 'pwview-linux-x86_64', 'linux-arm64': 'pwview-linux-aarch64', 'darwin-arm64': 'pwview-macos-aarch64', 'win32-x64': 'pwview-windows-x86_64.exe' } as Record<string, string>)[`${platform}-${arch}`];
}

/** Whether `pwview --version` output is at least the version Steerhouse needs. */
export function versionOk(out: string, need = PWVIEW_VERSION): boolean {
  const have = /(\d+)\.(\d+)\.(\d+)/.exec(out)?.slice(1).map(Number);
  if (!have) return false;
  const want = need.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}

/** Whether this project's .mcp.json already gives Claude a Playwright or pwview server. */
export function hasBrowserServer(mcpJson: string): boolean {
  try {
    const servers = JSON.parse(mcpJson)?.mcpServers ?? {};
    return 'playwright' in servers || 'pwview' in servers;
  } catch {
    return false;
  }
}

/** A browser is only useful in web projects; other folders don't get its tools in every chat. */
export const wantsBrowser = (root: string) => fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'pwview.toml'));

const MARK = '# Written by Steerhouse: other ports because the usual ones were busy. Yours to edit (remove this line to keep it).';
export const isOurs = (text: string) => text.startsWith(MARK);
export const localToml = (p: PwviewStatus['ports'], display: number) => `${MARK}
[ports]
ui = ${p.ui}
report = ${p.report}
cdp = ${p.cdp}
novnc = ${p.novnc}
vnc = ${p.vnc}

[display]
number = ${display}
`;

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
const anyPort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
const displayBusy = (n: number) => fs.existsSync(`/tmp/.X11-unix/X${n}`);

/** Ports (and an X display) for this project when another one holds the configured ones; else undefined. */
export async function freeSettings(s: Pick<PwviewStatus, 'ports' | 'display'>, free = portFree, any = anyPort, busyDisplay = displayBusy): Promise<Pick<PwviewStatus, 'ports' | 'display'> | undefined> {
  const names = Object.keys(s.ports) as (keyof PwviewStatus['ports'])[];
  const isFree = await Promise.all(names.map((n) => free(s.ports[n])));
  const busy = busyDisplay(s.display);
  if (isFree.every(Boolean) && !busy) return undefined;
  const ports = { ...s.ports };
  for (const [i, n] of names.entries()) if (!isFree[i]) ports[n] = await any();
  let display = s.display;
  while (busyDisplay(display)) display++;
  return { ports, display };
}

const run = (bin: string, args: string[], cwd?: string, timeout = 30_000) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { cwd, timeout, windowsHide: true, maxBuffer: 4_000_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${String(stderr).trim() || err.message}`)) : resolve(String(stdout)))),
  );

export class Pwview {
  private found?: Promise<string>;
  private live = new Map<string, LiveBrowser>();
  private out?: vscode.OutputChannel;

  constructor(private ctx: vscode.ExtensionContext) {}

  private cfg() {
    return vscode.workspace.getConfiguration('steerhouse.pwview');
  }
  private log(s: string) {
    (this.out ??= vscode.window.createOutputChannel('Steerhouse pwview')).appendLine(s);
  }

  /** pwview's path: the setting, an installed one recent enough, or our own copy (downloaded once). */
  private binary(): Promise<string> {
    return (this.found ??= this.locate().catch((e) => {
      this.found = undefined; // try again next time: the network may be back
      throw e;
    }));
  }

  private async locate(): Promise<string> {
    const custom = this.cfg().get<string>('path', '');
    if (custom) return custom;
    const installed = [which('pwview'), path.join(os.homedir(), '.cargo', 'bin', 'pwview')];
    for (const p of installed) {
      if (!p || !fs.existsSync(p)) continue;
      if (versionOk(await run(p, ['--version']).catch(() => ''))) return p;
    }
    const asset = assetFor(process.platform, process.arch);
    if (!asset) throw new Error(`no pwview download for ${process.platform}-${process.arch}`);
    const dir = this.ctx.globalStorageUri.fsPath;
    const own = path.join(dir, `pwview-${PWVIEW_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);
    if (fs.existsSync(own)) return own;
    const url = `${RELEASES}/v${PWVIEW_VERSION}/${asset}`;
    this.log(`Downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${own}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
    fs.renameSync(tmp, own);
    return own;
  }

  private async status(bin: string, cwd: string): Promise<PwviewStatus> {
    return JSON.parse(await run(bin, ['-C', cwd, 'status', '--json']));
  }

  /** Keeps pwview's files out of git without touching anything that gets committed. */
  private async excludeFromGit(root: string, ...names: string[]) {
    const rel = await run('git', ['rev-parse', '--git-path', 'info/exclude'], root).catch(() => '');
    if (!rel.trim()) return;
    const file = path.resolve(root, rel.trim());
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = names.filter((n) => !text.split(/\r?\n/).includes(n));
    if (!missing.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }

  /** When another project holds the ports, use free ones here (only in a file that is ours). */
  private async settlePorts(root: string, st: PwviewStatus) {
    if (st.running) return;
    const free = await freeSettings(st);
    if (!free) return;
    const file = path.join(root, 'pwview.local.toml');
    if (fs.existsSync(file) && !isOurs(fs.readFileSync(file, 'utf8'))) return this.log(`${file} is yours, so it stays as it is, but some of its ports are busy.`);
    fs.writeFileSync(file, localToml(free.ports, free.display));
    await this.excludeFromGit(root, 'pwview.local.toml');
  }

  /** Gives a chat the browser tools. Never gets in the chat's way: problems only go to the log. */
  async attach(cwd: string, chat: { addMcp(name: string, config: Record<string, unknown>): Promise<unknown> }) {
    try {
      if (!this.cfg().get<boolean>('enabled', true)) return;
      const bin = await this.binary();
      const st = await this.status(bin, cwd);
      if (!wantsBrowser(st.root) || st.root === os.homedir()) return;
      const mcpJson = path.join(st.root, '.mcp.json');
      if (fs.existsSync(mcpJson) && hasBrowserServer(fs.readFileSync(mcpJson, 'utf8'))) return;
      await this.excludeFromGit(st.root, '.pwview/');
      await this.settlePorts(st.root, st);
      await chat.addMcp('pwview', { type: 'stdio', command: bin, args: ['-C', st.root, 'mcp'] });
    } catch (e) {
      this.log(`Browser tools not connected for ${cwd}: ${(e as Error)?.message ?? e}`);
    }
  }

  /** Starts the browser if needed and shows it in a panel. */
  async open(cwd: string) {
    try {
      const st = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Steerhouse: starting the browser…') }, async () => {
        const bin = await this.binary();
        const before = await this.status(bin, cwd);
        await this.excludeFromGit(before.root, '.pwview/');
        await this.settlePorts(before.root, before);
        await run(bin, ['-C', cwd, 'up', '--install'], cwd, 600_000);
        return this.status(bin, cwd);
      });
      const open = this.live.get(st.root);
      if (open) return open.reveal();
      const view = new LiveBrowser(path.basename(st.root), st.ports.cdp, () => this.live.delete(st.root));
      this.live.set(st.root, view);
    } catch (e) {
      vscode.window.showErrorMessage(vscode.l10n.t('Steerhouse: the browser did not start: {0}', String((e as Error)?.message ?? e).split('\n').slice(-1)[0]));
    }
  }

  async stop(cwd: string) {
    try {
      const bin = await this.binary();
      const st = await this.status(bin, cwd);
      this.live.get(st.root)?.dispose();
      await run(bin, ['-C', cwd, 'down']);
      vscode.window.setStatusBarMessage(vscode.l10n.t('$(debug-stop) Steerhouse: browser stopped'), 5000);
    } catch (e) {
      vscode.window.showErrorMessage(String((e as Error)?.message ?? e));
    }
  }
}
