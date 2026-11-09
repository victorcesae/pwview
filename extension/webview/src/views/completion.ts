// Completing file names in the chat box. Kept free of UI components so it can be unit-tested in Node.

/** What is being completed when the text ends in @something; undefined otherwise. */
export function atQuery(text: string): string | undefined {
  // the box gives Markdown, where typing my_file arrives as my\_file
  return /(?:^|\s)@([^\s@`]*)$/.exec(text)?.[1].replace(/\\/g, '');
}

/** The text with the final @something replaced by the path, as code so Markdown leaves it alone (__init__.py). */
export const withFile = (text: string, file: string) => text.replace(/@[^\s@`]*$/, () => `\`${file}\` `);

/** The command when the message starts with !; undefined otherwise (also for a bare !). */
export function shellCommand(plainText: string): string | undefined {
  return /^!\s*([\s\S]*\S)\s*$/.exec(plainText)?.[1];
}

/** A file path from a URI VS Code hands over (file:, vscode-remote:), without the machine's name. */
function pathOfUri(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'file:' && !u.protocol.startsWith('vscode')) return undefined;
    const p = decodeURIComponent(u.pathname);
    return /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : p;
  } catch {
    return undefined;
  }
}

/** The files in a drop from VS Code (Explorer, editor tabs, Sessions tree). */
export function droppedPaths(getData: (type: string) => string): string[] {
  for (const type of ['application/vnd.code.uri-list', 'text/uri-list']) {
    const list = getData(type).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const paths = list.flatMap((l) => pathOfUri(l) ?? []);
    if (paths.length) return paths;
  }
  try {
    const files = JSON.parse(getData('codefiles') || '[]');
    if (Array.isArray(files)) return files.filter((f): f is string => typeof f === 'string');
  } catch {
    /* not this format */
  }
  return [];
}

/** How a file is written in a prompt: relative to the chat's folder when inside it, as code. */
export function mention(file: string, cwd: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const [f, root] = [norm(file), norm(cwd)];
  const inside = root && f.toLowerCase().startsWith(root.toLowerCase() + '/');
  return `\`${inside ? f.slice(root.length + 1) : f}\``;
}
