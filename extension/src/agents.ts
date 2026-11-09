// Other coding agents installed on this machine (Cursor Agent, Codex, Gemini CLI, OpenCode…).
// A new chat asks which agent to use: Claude Code runs in the Steerhouse chat; the others open in a
// terminal in the chosen folder, with their own login and settings.
import * as path from 'path';
import * as vscode from 'vscode';
import { which } from './util';

export interface CliAgent {
  id: string;
  name: string;
  /** executables to look for, first found wins */
  bins: string[];
  vendor: string;
  /** how to log in, shown when it is missing */
  login: string;
}

export const CLI_AGENTS: CliAgent[] = [
  { id: 'cursor', name: 'Cursor Agent', bins: ['cursor-agent', 'agent'], vendor: 'cursor', login: 'cursor-agent login' },
  { id: 'codex', name: 'Codex', bins: ['codex'], vendor: 'openai', login: 'codex login' },
  { id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], vendor: 'google', login: 'gemini' },
  { id: 'opencode', name: 'OpenCode', bins: ['opencode'], vendor: 'other', login: 'opencode auth login' },
  { id: 'grok', name: 'Grok Build', bins: ['grok'], vendor: 'xai', login: 'grok login' },
];

/** The agents found on PATH, with the executable that runs each. */
export function installedAgents(find: (bin: string) => string | undefined = which): (CliAgent & { exe: string })[] {
  const out: (CliAgent & { exe: string })[] = [];
  for (const a of CLI_AGENTS) {
    // "agent" is a common name: only count it as Cursor's when it lives in a Cursor folder
    const exe = a.bins.map((b) => find(b)).find((p, i) => p && (a.bins[i] !== 'agent' || /cursor/i.test(p)));
    if (exe) out.push({ ...a, exe });
  }
  return out;
}

/** Opens an agent CLI in a terminal in the folder (its own process, not typed into a shell). */
export function runCliAgent(a: CliAgent & { exe: string }, cwd: string, media: vscode.Uri, opts: { env?: Record<string, string>; args?: string[]; label?: string } = {}) {
  const args = opts.args ?? [];
  const isScript = /\.(cmd|bat)$/i.test(a.exe);
  const term = vscode.window.createTerminal({
    name: `${opts.label ?? a.name} · ${path.basename(cwd)}`,
    cwd,
    env: opts.env,
    shellPath: isScript ? 'cmd.exe' : a.exe,
    shellArgs: isScript ? ['/c', a.exe, ...args] : args,
    iconPath: vscode.Uri.joinPath(media, 'vendors', `${a.vendor}.svg`),
  });
  term.show();
  return term;
}
