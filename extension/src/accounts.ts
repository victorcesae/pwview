// Several Claude accounts side by side. Claude Code keeps each login in its config folder
// (CLAUDE_CONFIG_DIR), so an account = a folder. "default" is the normal ~/.claude.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeDir, dataDir } from './paths';

export interface Account {
  id: string;
  name: string;
  configDir: string;
}

interface Store {
  accounts: Account[];
  defaultId?: string;
}

const file = () => path.join(dataDir(), 'accounts.json');

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

function save(s: Store) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

export const defaultAccount = (): Account => ({ id: 'default', name: 'Default', configDir: claudeDir() });

export function listAccounts(): Account[] {
  return [defaultAccount(), ...load().accounts.filter((a) => fs.existsSync(a.configDir))];
}

export function preferredAccount(): Account {
  const s = load();
  return listAccounts().find((a) => a.id === s.defaultId) ?? defaultAccount();
}

export function setPreferred(id: string) {
  save({ ...load(), defaultId: id });
}

/** Create a new account folder. Shared settings (hooks, permissions) are copied from the default account; the login is not. */
export function addAccount(name: string): Account {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
  const s = load();
  let id = slug;
  for (let i = 2; s.accounts.some((a) => a.id === id) || id === 'default'; i++) id = `${slug}-${i}`;
  const configDir = path.join(os.homedir(), '.claude-accounts', id);
  fs.mkdirSync(configDir, { recursive: true });
  const settings = path.join(claudeDir(), 'settings.json');
  if (fs.existsSync(settings) && !fs.existsSync(path.join(configDir, 'settings.json'))) fs.copyFileSync(settings, path.join(configDir, 'settings.json'));
  const acc = { id, name: name.trim(), configDir };
  save({ ...s, accounts: [...s.accounts, acc] });
  return acc;
}

export function removeAccount(id: string) {
  const s = load();
  save({ ...s, accounts: s.accounts.filter((a) => a.id !== id), defaultId: s.defaultId === id ? undefined : s.defaultId });
}

/** Env for running the agent CLI as this account. */
export const accountEnv = (a: Account): Record<string, string> => (a.id === 'default' ? {} : { CLAUDE_CONFIG_DIR: a.configDir });
