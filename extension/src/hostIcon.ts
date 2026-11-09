// The editor's own app icon (VS Code, Cursor, Windsurf…), read from the running editor's install so
// the badge is the real icon without shipping anyone's logo. Returned as a data: URI for webviews.
import * as fs from 'fs';
import * as path from 'path';

const MIME: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml' };

/** Icon files to try, relative to vscode.env.appRoot, best first. */
export function hostIconCandidates(appName: string): string[] {
  const cursorLike = !/visual studio code|vs ?code|codium/i.test(appName);
  return [
    'resources/win32/code_70x70.png',
    'resources/linux/code.png',
    'resources/win32/code_150x150.png',
    // VS Code ships its real logo here; other forks keep a generic picture under the same name
    ...(cursorLike ? ['out/media/logo.png'] : ['out/media/code-icon.svg']),
  ];
}

let cached: string | undefined | null = null;

export function hostIcon(appRoot: string | undefined, appName: string): string | undefined {
  if (cached !== null) return cached;
  cached = undefined;
  if (!appRoot) return cached;
  for (const rel of hostIconCandidates(appName)) {
    const file = path.join(appRoot, rel);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) continue; // a big picture would bloat every update
      cached = `data:${MIME[path.extname(file)]};base64,${fs.readFileSync(file).toString('base64')}`;
      break;
    } catch {}
  }
  return cached;
}
