// Files dropped from the person's own computer. Over Remote-SSH the agent can't open a path on that
// computer, so the content is saved on this machine, in a private folder, and the prompt gets that path.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60_000;

export const uploadsRoot = () => path.join(os.tmpdir(), `steerhouse-uploads-${process.getuid?.() ?? 'user'}`);

/** A file name that stays inside its folder, whatever the sender claims. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  return !base || /^\.+$/.test(base) ? 'file' : base;
}

/** Saves the content under its own name, and returns the path. Older uploads are removed. */
export function saveUpload(name: string, data: Uint8Array, root = uploadsRoot(), now = Date.now()): string {
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error(`${name} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const d of fs.readdirSync(root)) {
    const old = path.join(root, d);
    try {
      if (now - fs.statSync(old).mtimeMs > KEEP_MS) fs.rmSync(old, { recursive: true, force: true });
    } catch {
      /* being removed */
    }
  }
  const dir = path.join(root, randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, safeName(name));
  fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}
