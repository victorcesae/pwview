const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) { console.error('MISSING ' + f + ': ' + a.slice(0, 80)); process.exit(1); }
  fs.writeFileSync(f, s.split(a).join(b));
};
const A = 'src/accounts.ts';
R(A, "import { claudeDir, dataDir } from './paths';", "import { claudeDir, dataDir } from './paths';\nimport { providerEnv, type Provider } from './providers';");
R(A, "export interface Account {\n  id: string;\n  name: string;\n  configDir: string;\n}", "export interface Account {\n  id: string;\n  name: string;\n  configDir: string;\n  /** set for model providers (Ollama, OpenRouter…): Claude Code runs against that endpoint */\n  provider?: Provider;\n}");
R(A, "/** Env for running the agent CLI as this account. */\nexport const accountEnv = (a: Account): Record<string, string> => (a.id === 'default' ? {} : { CLAUDE_CONFIG_DIR: a.configDir });",
`/** Env for running the agent CLI as this account (key: the provider's API key from SecretStorage). */
export const accountEnv = (a: Account, key?: string): Record<string, string> => {
  if (a.provider) return providerEnv(a.provider, key);
  return a.id === 'default' ? {} : { CLAUDE_CONFIG_DIR: a.configDir };
};

/** A model provider shares the default Claude Code folder (sessions, skills, hooks) but not its login. */
export function addProvider(p: Omit<Provider, 'id'>): Account {
  const s = load();
  const slug = p.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
  let id = 'p-' + slug;
  for (let i = 2; s.accounts.some((a) => a.id === id); i++) id = \`p-\${slug}-\${i}\`;
  const acc: Account = { id, name: p.name, configDir: claudeDir(), provider: { ...p, id } };
  save({ ...s, accounts: [...s.accounts, acc] });
  return acc;
}`);
fs.writeFileSync('build/.ok', '');
console.log('ok');
