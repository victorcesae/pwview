// Adding MCP servers (connectors): a popular one or your own (a command, or a URL), for the team
// (.mcp.json, committed), just you in this project, or all your projects. Saved with Claude Code's
// own `claude mcp add`, so the CLI, the terminal and Steerhouse chats all see it.
import { execFile } from 'child_process';

export type McpScope = 'project' | 'local' | 'user';

export interface McpServer {
  name: string;
  /** stdio: a command to run; http: a URL */
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpPreset extends McpServer {
  label: string;
  detail: string;
}

export const MCP_PRESETS: McpPreset[] = [
  { label: 'Playwright', detail: 'Drive a browser: open pages, click, fill forms, screenshot', name: 'playwright', transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'] },
  { label: 'Context7', detail: 'Up-to-date library docs in the prompt', name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  { label: 'GitHub', detail: 'Issues, PRs, code search (signs in with GitHub)', name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
  { label: 'Sentry', detail: 'Errors and performance issues (signs in with Sentry)', name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp' },
  { label: 'Notion', detail: 'Pages and databases (signs in with Notion)', name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' },
];

/** Valid server name: letters, digits, dash, underscore. */
export const validName = (n: string) => /^[A-Za-z0-9_-]{1,64}$/.test(n);

/** "npx -y some-server --flag" → command and args (quotes keep spaces). */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] ?? '', args: parts.slice(1) };
}

/** Arguments for `claude mcp add`. */
export function mcpAddArgs(s: McpServer, scope: McpScope): string[] {
  if (s.transport === 'http') return ['mcp', 'add', '--scope', scope, '--transport', 'http', s.name, s.url!];
  return ['mcp', 'add', '--scope', scope, s.name, '--', s.command!, ...(s.args ?? [])];
}

/** The same server as an SDK config, to connect it to a running chat right away. */
export function sdkConfig(s: McpServer): Record<string, unknown> {
  return s.transport === 'http' ? { type: 'http', url: s.url } : { type: 'stdio', command: s.command, args: s.args ?? [] };
}

export function runClaude(exe: string, args: string[], cwd: string, env: Record<string, string | undefined>): Promise<{ ok: boolean; out: string }> {
  const isScript = /\.(cmd|bat)$/i.test(exe);
  return new Promise((resolve) =>
    execFile(isScript ? 'cmd.exe' : exe, isScript ? ['/c', exe, ...args] : args, { cwd, env: { ...process.env, ...env }, timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
    ),
  );
}
