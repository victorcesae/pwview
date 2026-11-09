// Several Claude accounts side by side. Claude Code keeps each login in its config folder
// (CLAUDE_CONFIG_DIR), so an account = a folder. "default" is the normal ~/.claude.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeDir, dataDir } from './paths';
import { providerEnv, type Provider } from './providers';

export interface Account {
  id: string;
  name: string;
  configDir: string;
  /** set for model providers (Ollama, OpenRouter…): Claude Code runs against that endpoint */
  provider?: Provider;
}

/**
 * A second login for Cursor Agent. It keeps its login under XDG_CONFIG_HOME (CURSOR_CONFIG_DIR only
 * moves its settings), so an account = a folder there.
 */
export interface CursorAccount {
  id: string;
  name: string;
  dir: string;
}

interface Store {
  accounts: Account[];
  defaultId?: string;
  /** what the user calls the default account */
  defaultName?: string;
  cursorAccounts?: CursorAccount[];
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

export const defaultAccount = (): Account => ({ id: 'default', name: load().defaultName || 'Default', configDir: claudeDir() });

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

/** A new display name; ids and folders stay, so logins and sessions keep working. */
export function renameAccount(id: string, name: string) {
  const n = name.trim();
  if (!n) return;
  const s = load();
  if (id === 'default') return save({ ...s, defaultName: n });
  save({
    ...s,
    accounts: s.accounts.map((a) => (a.id === id ? { ...a, name: n, ...(a.provider ? { provider: { ...a.provider, name: n } } : {}) } : a)),
    cursorAccounts: s.cursorAccounts?.map((a) => (a.id === id ? { ...a, name: n } : a)),
  });
}

export const listCursorAccounts = (): CursorAccount[] => (load().cursorAccounts ?? []).filter((a) => fs.existsSync(a.dir));

/** Create a Cursor account folder. Tools the agent runs read this folder too, so gh and git keep their own settings. */
export function addCursorAccount(name: string): CursorAccount {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
  const s = load();
  const taken = s.cursorAccounts ?? [];
  let id = `cursor-${slug}`;
  for (let i = 2; taken.some((a) => a.id === id); i++) id = `cursor-${slug}-${i}`;
  const dir = path.join(os.homedir(), '.cursor-accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  const real = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  for (const tool of ['gh', 'git']) {
    const from = path.join(real, tool);
    const to = path.join(dir, tool);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, 'junction');
  }
  const acc = { id, name: name.trim(), dir };
  save({ ...s, cursorAccounts: [...taken, acc] });
  return acc;
}

export function removeCursorAccount(id: string) {
  const s = load();
  save({ ...s, cursorAccounts: (s.cursorAccounts ?? []).filter((a) => a.id !== id) });
}

export const cursorAccountEnv = (a: CursorAccount): Record<string, string> => ({ XDG_CONFIG_HOME: a.dir });

export function removeAccount(id: string) {
  const s = load();
  save({ ...s, accounts: s.accounts.filter((a) => a.id !== id), defaultId: s.defaultId === id ? undefined : s.defaultId });
}

/** Env for running the agent CLI as this account (key: the provider's API key from SecretStorage). */
export const accountEnv = (a: Account, key?: string): Record<string, string> => {
  if (a.provider) return providerEnv(a.provider, key);
  return a.id === 'default' ? {} : { CLAUDE_CONFIG_DIR: a.configDir };
};

/** A model provider shares the default Claude Code folder (sessions, skills, hooks) but not its login. */
export function addProvider(p: Omit<Provider, 'id'>): Account {
  const s = load();
  const slug = p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
  let id = 'p-' + slug;
  for (let i = 2; s.accounts.some((a) => a.id === id); i++) id = `p-${slug}-${i}`;
  const acc: Account = { id, name: p.name, configDir: claudeDir(), provider: { ...p, id } };
  save({ ...s, accounts: [...s.accounts, acc] });
  return acc;
}

/** Who is signed in to a Claude account (from Claude Code's own .claude.json), if anyone. */
export function accountIdentity(a: Account): { email?: string; organization?: string } | undefined {
  if (a.provider) return undefined;
  const isDefault = a.id === defaultAccount().id && !process.env.CLAUDE_CONFIG_DIR;
  const file = isDefault ? path.join(os.homedir(), '.claude.json') : path.join(a.configDir, '.claude.json');
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
    return o?.emailAddress ? { email: o.emailAddress, organization: o.organizationName } : undefined;
  } catch {
    return undefined;
  }
}
