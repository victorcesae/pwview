import * as fs from 'fs';
import * as path from 'path';
import { claudeDir, dataDir } from './paths';

export const hookScriptPath = () => path.join(dataDir(), 'hook.js');
const settingsPath = () => path.join(claudeDir(), 'settings.json');
const cmd = (arg: string) => `node "${hookScriptPath().replace(/\\/g, '/')}" ${arg}`;

/** Claude Code event → our hook argument. */
const EVENTS = [
  ['Stop', 'stop'], // queue: hand messages over when the turn ends
  ['UserPromptSubmit', 'prompt'], // queue: or with the next prompt
  ['PostToolUse', 'posttool'], // steer: between steps, without stopping
  ['SessionStart', 'sessionstart'], // remember which terminal runs the session (send now)
] as const;

/** Copy the bundled hook to a stable path, so hooks survive extension updates. */
export function installHookScript(bundled: string) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.copyFileSync(bundled, hookScriptPath());
}

const ours = (g: any) => (g?.hooks ?? []).some((h: any) => String(h.command ?? '').includes('agentlens/hook.js'));

/** 'all' | 'some' (older version installed, needs update) | 'none' */
export function hooksStatus(target = settingsPath()): 'all' | 'some' | 'none' {
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return 'none';
  }
  const have = EVENTS.filter(([e]) => (doc?.hooks?.[e] ?? []).some(ours)).length;
  return have === EVENTS.length ? 'all' : have ? 'some' : 'none';
}

export const hooksInstalled = () => hooksStatus() === 'all';

/** Merge our hooks into ~/.claude/settings.json (idempotent, with backup). Returns how many were added. */
export function installHooks(target = settingsPath()): number {
  let original: string | undefined;
  try {
    original = fs.readFileSync(target, 'utf8');
  } catch {
    /* no settings yet */
  }
  const doc: any = original?.trim() ? JSON.parse(original) : {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${target} is not a JSON object`);
  doc.hooks ??= {};
  let added = 0;
  for (const [event, arg] of EVENTS) {
    const groups: any[] = (doc.hooks[event] ??= []);
    if (!groups.some(ours)) {
      groups.push({ hooks: [{ type: 'command', command: cmd(arg) }] });
      added++;
    }
  }
  if (added) {
    if (original !== undefined) fs.writeFileSync(target + '.agentlens-bak', original);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(doc, null, 2) + '\n');
  }
  return added;
}
