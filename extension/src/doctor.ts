// "AgentLens: Check Setup": everything the extension needs, with a fix for each problem.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { hooksStatus } from './hooks';
import { claudeDir } from './paths';
import { agentExecutable, installClaude, runAgent } from './util';

export interface Check {
  name: string;
  ok: boolean | 'unknown';
  detail: string;
  fix?: { label: string; command: string };
}

const version = (exe: string) =>
  new Promise<string | undefined>((resolve) => {
    const isScript = /\.(cmd|bat)$/i.test(exe);
    execFile(isScript ? 'cmd.exe' : exe, isScript ? ['/c', exe, '--version'] : ['--version'], { timeout: 15000 }, (err, out) => resolve(err ? undefined : out.trim().split('\n')[0]));
  });

/** Is there a Claude Code login? (credentials file, env API key/token, or macOS Keychain which we can't read) */
export function loginState(): { ok: boolean | 'unknown'; detail: string } {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: 'ANTHROPIC_API_KEY is set (API billing)' };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN) return { ok: true, detail: 'token from the environment' };
  if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return { ok: true, detail: 'cloud provider (Bedrock / Vertex) from the environment' };
  if (fs.existsSync(path.join(claudeDir(), '.credentials.json'))) return { ok: true, detail: 'logged in (Claude subscription or Console)' };
  if (process.platform === 'darwin') return { ok: 'unknown', detail: 'on macOS the login lives in the Keychain; run "Log in" if chats ask for it' };
  return { ok: false, detail: 'not logged in yet: one login is reused by every chat and terminal' };
}

export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const exe = agentExecutable();
  const v = exe ? await version(exe) : undefined;
  checks.push({
    name: 'Claude Code',
    ok: !!exe && !!v,
    detail: exe ? `${v ?? 'found but did not run'}: ${exe}` : 'not found on PATH or in the usual install folders',
    fix: exe ? undefined : { label: 'Install Claude Code', command: 'agentlens.installClaude' },
  });
  const login = loginState();
  checks.push({ name: 'Login', ok: login.ok, detail: login.detail, fix: login.ok === true ? undefined : { label: 'Log in', command: 'agentlens.login' } });
  const h = hooksStatus();
  checks.push({
    name: 'Message delivery hooks',
    ok: h === 'all',
    detail: h === 'all' ? 'steer / queue / send now work in terminal sessions too' : h === 'some' ? 'an older version is installed: update for steering' : 'not installed: needed only for sessions running in a terminal',
    fix: h === 'all' ? undefined : { label: h === 'some' ? 'Update hooks' : 'Enable', command: 'agentlens.installHooks' },
  });
  const ws = vscode.workspace.workspaceFolders?.[0];
  checks.push({ name: 'Project folder', ok: !!ws, detail: ws ? ws.uri.fsPath : 'open a folder so agents know where to work', fix: ws ? undefined : { label: 'Open Folder', command: 'workbench.action.files.openFolder' } });
  checks.push({
    name: 'Where this runs',
    ok: true,
    detail: vscode.env.remoteName ? `remote (${vscode.env.remoteName}): agents run on the remote machine, using its RAM and its login` : 'this machine',
  });
  return checks;
}

/** Mark walkthrough steps done from the real state (not from button clicks). */
export async function syncSetupContext(checks?: Check[]) {
  checks ??= await runChecks();
  const ok = (name: string) => checks!.find((c) => c.name === name)?.ok === true;
  await vscode.commands.executeCommand("setContext", "agentlens.claudeOk", ok("Claude Code"));
  await vscode.commands.executeCommand("setContext", "agentlens.loginOk", ok("Login"));
  await vscode.commands.executeCommand("setContext", "agentlens.hooksOk", ok("Message delivery hooks"));
  return checks;
}

export function registerDoctor(ctx: vscode.ExtensionContext) {
  syncSetupContext().catch(() => {});
  const out = vscode.window.createOutputChannel('AgentLens');
  ctx.subscriptions.push(
    out,
    vscode.commands.registerCommand('agentlens.doctor', async () => {
      const checks = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'AgentLens: checking setup…' }, runChecks);
      syncSetupContext(checks);
      out.clear();
      out.appendLine('AgentLens setup check\n');
      for (const c of checks) out.appendLine(`${c.ok === true ? '✔' : c.ok === 'unknown' ? '?' : '✖'} ${c.name}: ${c.detail}`);
      const bad = checks.filter((c) => c.ok === false);
      if (!bad.length) {
        vscode.window.showInformationMessage('AgentLens: everything is set up. ✔', 'New Chat').then((p) => p && vscode.commands.executeCommand('agentlens.newChat'));
        return;
      }
      const first = bad[0];
      const pick = await vscode.window.showWarningMessage(`AgentLens: ${first.name}: ${first.detail}`, ...(first.fix ? [first.fix.label] : []), 'Show details');
      if (pick === 'Show details') out.show();
      else if (pick && first.fix) vscode.commands.executeCommand(first.fix.command);
    }),
    vscode.commands.registerCommand('agentlens.installClaude', () => installClaude()),
    vscode.commands.registerCommand('agentlens.login', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? require('os').homedir();
      runAgent('Claude login', cwd, []);
      vscode.window.showInformationMessage('In the Claude terminal, type /login and follow the link. You only do this once: every AgentLens chat and terminal reuses the login.');
    }),
  );

  // First run: open the step-by-step setup.
  if (!ctx.globalState.get('agentlens.walkthroughShown')) {
    ctx.globalState.update('agentlens.walkthroughShown', true);
    vscode.commands.executeCommand('workbench.action.openWalkthrough', 'victorcesae.agentlens#agentlens.start', false);
  }
}
