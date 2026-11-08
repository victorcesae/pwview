import * as os from 'os';
import * as path from 'path';

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const dataDir = () => path.join(claudeDir(), 'agentlens');

/** Path key for comparisons: forward slashes, case-insensitive on Windows. */
export const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};
