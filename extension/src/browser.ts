// Opens web links (PRs, docs, the pwview viewer) in the browser the user picked in settings:
// the computer's default browser, Chrome, Edge, Firefox, or any executable.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { which } from './util';

export type BrowserChoice = 'default' | 'chrome' | 'edge' | 'firefox' | 'custom';

/** Install locations to try for a named browser on this OS. */
export function browserCandidates(choice: BrowserChoice, platform = process.platform, env = process.env): string[] {
  if (platform === 'win32') {
    const rel = { chrome: 'Google\\Chrome\\Application\\chrome.exe', edge: 'Microsoft\\Edge\\Application\\msedge.exe', firefox: 'Mozilla Firefox\\firefox.exe' }[choice as 'chrome'];
    if (!rel) return [];
    return ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map((v) => env[v]).filter((b): b is string => !!b).map((b) => path.win32.join(b, rel));
  }
  if (platform === 'darwin') {
    const app = { chrome: 'Google Chrome', edge: 'Microsoft Edge', firefox: 'Firefox' }[choice as 'chrome'];
    return app ? [`/Applications/${app}.app/Contents/MacOS/${app}`] : [];
  }
  return ({ chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'], edge: ['microsoft-edge', 'microsoft-edge-stable'], firefox: ['firefox'] } as Record<string, string[]>)[choice] ?? [];
}

/** The executable for the chosen browser, or undefined to use the system default. */
export function browserExecutable(choice: BrowserChoice, customPath = ''): string | undefined {
  if (choice === 'default') return undefined;
  if (choice === 'custom') return !customPath ? undefined : fs.existsSync(customPath) ? customPath : which(customPath) || undefined;
  for (const c of browserCandidates(choice)) {
    const p = path.isAbsolute(c) ? (fs.existsSync(c) ? c : undefined) : which(c);
    if (p) return p;
  }
  return undefined;
}

export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  const cfg = vscode.workspace.getConfiguration('steerhouse');
  const choice = cfg.get<BrowserChoice>('browser', 'default');
  // Over Remote-SSH the extension runs on the host: a browser there would open on the server, not
  // in front of you. The default path forwards the link to your own machine.
  if (choice === 'default' || vscode.env.remoteName) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  const exe = browserExecutable(choice, cfg.get<string>('browserPath', ''));
  if (!exe) {
    vscode.window.showWarningMessage(vscode.l10n.t('Steerhouse: {0} was not found, so the link opens in your default browser.', choice === 'custom' ? cfg.get<string>('browserPath', '') || 'steerhouse.browserPath' : choice));
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }
  const child = spawn(exe, [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => vscode.env.openExternal(vscode.Uri.parse(url)));
  child.unref();
}
