// Steerhouse was called AgentLens. On first start it carries over what the old name left behind:
// settings ("agentlens.*" → "steerhouse.*"), its data folder (~/.claude/agentlens), and the Claude
// Code hook entries that pointed at the old hook script. Each step runs once and never overwrites
// something already set under the new name.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const OLD = 'agentlens';
const NEW = 'steerhouse';

/** Copies the old data folder to the new one when only the old one exists. */
export function migrateDataDir(claudeDir: string): boolean {
  const from = path.join(claudeDir, OLD);
  const to = path.join(claudeDir, NEW);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

/** Points our hook entries in a Claude Code settings.json at the new script (backup first). */
export function migrateHooks(settingsFile: string): number {
  let text: string;
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch {
    return 0;
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return 0; // not ours to repair
  }
  let n = 0;
  for (const groups of Object.values<any>(doc?.hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of g?.hooks ?? []) {
        const c = String(h?.command ?? '');
        if (/[\\/]agentlens[\\/]hook\.js/.test(c)) {
          h.command = c.replace(/([\\/])agentlens([\\/]hook\.js)/, `$1${NEW}$2`);
          n++;
        }
      }
  if (n) {
    fs.writeFileSync(settingsFile + '.agentlens-rename-bak', text);
    fs.writeFileSync(settingsFile, JSON.stringify(doc, null, 2) + '\n');
  }
  return n;
}

/** Old project prompts folder, still read next to the new one. */
export const legacyPromptsDir = (root: string) => path.join(root, '.' + OLD, 'prompts');

/** Copies "agentlens.<key>" settings to "steerhouse.<key>" where the new one is not set yet. */
export async function migrateSettings(keys: string[]): Promise<number> {
  const oldCfg = vscode.workspace.getConfiguration(OLD);
  const newCfg = vscode.workspace.getConfiguration(NEW);
  let n = 0;
  for (const k of keys) {
    const o = oldCfg.inspect(k);
    const cur = newCfg.inspect(k);
    if (!o) continue;
    const targets: [unknown, unknown, vscode.ConfigurationTarget][] = [
      [o.globalValue, cur?.globalValue, vscode.ConfigurationTarget.Global],
      [o.workspaceValue, cur?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    ];
    for (const [was, now, target] of targets) {
      if (was === undefined || now !== undefined) continue;
      if (target === vscode.ConfigurationTarget.Workspace && !vscode.workspace.workspaceFolders?.length) continue;
      await newCfg.update(k, was, target);
      n++;
    }
  }
  return n;
}

/** Runs the steps once per machine (a marker in the new data folder), reporting what moved. */
export async function migrateFromAgentLens(opts: { claudeDir: string; settingKeys: string[]; accountSettings: string[] }): Promise<string[]> {
  const done: string[] = [];
  if (migrateDataDir(opts.claudeDir)) done.push('data folder');
  const marker = path.join(opts.claudeDir, NEW, '.migrated-from-agentlens');
  let hooks = 0;
  for (const f of opts.accountSettings) hooks += migrateHooks(f);
  if (hooks) done.push(`${hooks} hook entries`);
  if (!fs.existsSync(marker)) {
    const s = await migrateSettings(opts.settingKeys).catch(() => 0);
    if (s) done.push(`${s} settings`);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  }
  return done;
}
