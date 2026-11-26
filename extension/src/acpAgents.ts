// ACP agents in the Steerhouse chat: the built-in ones (Gemini CLI, Kiro, Copilot CLI, Grok) and the
// commands listed in steerhouse.acpAgents, registered as runtimes and offered when found.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RUNTIMES } from './chatPanel';
import { ACP_AGENTS, acpRuntime, customAcpAgents, type AcpAgentDef } from './runtimes/acp';
import { which } from './util';

const exeOf = (d: AcpAgentDef) => d.bins.map((b) => which(b) ?? (path.isAbsolute(b) && fs.existsSync(b) ? b : undefined)).find(Boolean);

let defs: AcpAgentDef[] = [];

/** (Re)registers the ACP runtimes; call on activation and when steerhouse.acpAgents changes. */
export function registerAcpRuntimes() {
  for (const d of defs) if (d.id.startsWith('acp:')) delete RUNTIMES[d.id];
  defs = [...ACP_AGENTS, ...customAcpAgents(vscode.workspace.getConfiguration('steerhouse').get('acpAgents'))];
  for (const d of defs) RUNTIMES[d.id] = acpRuntime(d, () => exeOf(d));
}

/** The ACP agents installed here, for the new-chat pickers. */
export function acpAgentsOnPath(): { id: string; name: string; exe: string; vendor: string }[] {
  return defs.flatMap((d) => {
    const exe = exeOf(d);
    return exe ? [{ id: d.id, name: d.label, exe, vendor: d.vendor }] : [];
  });
}
