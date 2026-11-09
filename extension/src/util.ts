import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { launched } from './terminals';

export function ago(ts?: string): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

export function rel(file: string, root: string): string {
  const r = path.relative(root, file);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : file;
}

const win = process.platform === 'win32';

/** Where Claude Code's installers put the CLI. VS Code's PATH often lacks these (GUI launch, SSH non-login shell). */
function knownDirs(): string[] {
  const home = os.homedir();
  const dirs = [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin')];
  if (win) dirs.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'));
  else dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.bun', 'bin'));
  return dirs;
}

const semver = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/**
 * Last resort on Windows: the Claude desktop app ships Claude Code at
 * %LOCALAPPDATA%\Claude-Data\<app>\claude-code\<version>\<build>\claude.exe. Use the newest one.
 */
function desktopBundledClaude(): string | undefined {
  if (!win || !process.env.LOCALAPPDATA) return;
  const root = path.join(process.env.LOCALAPPDATA, 'Claude-Data');
  const dirs = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  let best: { v: string; exe: string } | undefined;
  for (const app of dirs(root))
    for (const v of dirs(path.join(root, app, 'claude-code')))
      for (const build of dirs(path.join(root, app, 'claude-code', v))) {
        const exe = path.join(root, app, 'claude-code', v, build, 'claude.exe');
        if (fs.existsSync(exe) && (!best || newer(v, best.v) > 0)) best = { v, exe };
      }
  return best?.exe;
}

export function which(cmd: string): string | undefined {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : undefined;
  const exts = win ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...knownDirs()];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of path.extname(cmd) ? [''] : exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
}

/** Explain the missing CLI and offer to install it (typed into a terminal, not run) or point to it. */
async function agentMissing(command: string) {
  const install = win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  const pick = await vscode.window.showErrorMessage(
    `Steerhouse: the agent CLI "${command}" isn't installed where this editor runs${vscode.env.remoteName ? ` (${vscode.env.remoteName})` : ''}. Viewing sessions, diffs and comments still works; starting, resuming and prompts need it.`,
    'Install Claude Code…',
    'Set path…',
  );
  if (pick === 'Install Claude Code…') {
    installClaude();
  } else if (pick === 'Set path…') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'steerhouse.agentCommand');
  }
}

/**
 * Start the agent CLI in a VS Code terminal, passing arguments directly (no shell
 * quoting problems with prompts). The terminal is the session: you can type into it.
 */
/**
 * Run the official Claude Code installer in the shell it is written for, never in the user's
 * default terminal (which may be Git Bash, cmd, fish…, and may get a venv "activate" line typed
 * into it by other extensions). The installer is the terminal's own process, started after the
 * user confirms the exact command.
 */
export async function installClaude() {
  const win = process.platform === 'win32';
  const cmd = win ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  const ok = await vscode.window.showInformationMessage(
    `Install Claude Code with the official installer?\n\n${cmd}\n\nIt runs in ${win ? 'PowerShell' : 'bash'}${vscode.env.remoteName ? ` on ${vscode.env.remoteName}` : ''}.`,
    { modal: true },
    'Install',
  );
  if (ok !== 'Install') return;
  const t = win
    ? vscode.window.createTerminal({
        name: 'Install Claude Code',
        iconPath: new vscode.ThemeIcon('cloud-download'),
        shellPath: 'powershell.exe',
        shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', `${cmd}; Write-Host ''; Write-Host 'Done. Next: Steerhouse: Log in to Claude Code' -ForegroundColor Green`],
      })
    : vscode.window.createTerminal({
        name: 'Install Claude Code',
        iconPath: new vscode.ThemeIcon('cloud-download'),
        shellPath: '/bin/bash',
        shellArgs: ['-c', `${cmd}; echo; echo "Done. Next: Steerhouse: Log in to Claude Code"; exec bash -l`],
      });
  t.show();
}

/** The agent CLI to drive (PATH, standard install dirs, then the Claude desktop app's bundled copy). */
export function agentExecutable(): string | undefined {
  const command = vscode.workspace.getConfiguration('steerhouse').get<string>('agentCommand', 'claude');
  return which(command) ?? (command === 'claude' ? desktopBundledClaude() : undefined);
}

export function runAgent(name: string, cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const cfg = vscode.workspace.getConfiguration('steerhouse');
  const command = cfg.get<string>('agentCommand', 'claude');
  const all = [...cfg.get<string[]>('agentArgs', []), ...args];
  const exe = which(command) ?? (command === 'claude' ? desktopBundledClaude() : undefined);
  if (!exe) {
    agentMissing(command);
    return;
  }
  const isScript = /\.(cmd|bat)$/i.test(exe);
  // The hook reads STEERHOUSE_TERMINAL and records it, so we know this terminal runs that session.
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const term = vscode.window.createTerminal({
    name,
    cwd,
    shellPath: isScript ? 'cmd.exe' : exe,
    shellArgs: isScript ? ['/c', exe, ...all] : all,
    iconPath: new vscode.ThemeIcon('sparkle'),
    env: { ...extraEnv, STEERHOUSE_TERMINAL: token },
  });
  launched.set(token, term);
  term.show();
}
