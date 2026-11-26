// Finds local media and document files an answer or a tool call mentions, for the preview cards
// under a message. Pure (no DOM, no React): the unit tests load it directly.

export type MediaKind = 'image' | 'video' | 'audio' | 'pdf' | 'doc';

const KINDS: Record<string, MediaKind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']) KINDS[e] = 'image';
for (const e of ['mp4', 'webm', 'mov', 'm4v', 'ogv']) KINDS[e] = 'video';
for (const e of ['mp3', 'wav', 'ogg', 'm4a', 'flac']) KINDS[e] = 'audio';
KINDS.pdf = 'pdf';
for (const e of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'csv', 'tsv', 'zip', 'tar', 'gz', 'tgz', '7z', 'epub']) KINDS[e] = 'doc';

/** The preview kind for a path, by its extension; undefined for anything else (source code…). */
export function mediaKind(p: string): MediaKind | undefined {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(p);
  return m ? KINDS[m[1].toLowerCase()] : undefined;
}

const EXT = Object.keys(KINDS).sort((a, b) => b.length - a.length).join('|');
// optional root (/, ~/, ./, ../, C:\), folder parts, a file name, a known extension, then not a word char
const PATH_RE = new RegExp(String.raw`(?:file:\/\/)?((?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])?(?:[\w@%+=,.-]+[\\/])*[\w@%+=,.-]*\.(?:${EXT}))(?![\w/\\-])`, 'gi');
// paths with spaces only count when quoted or in backticks
const QUOTED_RE = new RegExp(String.raw`[\`"']((?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/])?[^\`"'\n<>|*?]*?\.(?:${EXT}))[\`"']`, 'gi');

/**
 * Local file paths with a previewable extension in `text`, in order of appearance, without
 * repeats, at most `max`. URLs (http://…/a.png) and bare extensions (".png") are skipped.
 */
export function detectMediaPaths(text: string, max = 8): string[] {
  if (!text) return [];
  const found: { at: number; p: string }[] = [];
  const take = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1];
      const at = m.index + m[0].indexOf(p);
      const before = text.slice(Math.max(0, at - 3), at);
      if (/:\/\/?$|\w:\/$/.test(before) && !m[0].startsWith('file://')) continue; // part of a URL
      if (/^[a-z][\w+.-]*:\/\//i.test(p)) continue;
      const name = p.split(/[\\/]/).pop()!;
      if (!name || name.startsWith('.') && name.indexOf('.', 1) < 0) continue; // ".png" alone
      if (/^\*|\*/.test(p)) continue; // globs
      found.push({ at, p });
    }
  };
  take(QUOTED_RE);
  take(PATH_RE);
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  const seen = new Set<string>();
  // "my file.png" also yields "file.png": the host keeps whichever exists
  for (const f of found) {
    if (seen.has(f.p)) continue;
    seen.add(f.p);
    out.push(f.p);
    if (out.length >= max) break;
  }
  return out;
}

/** The text a tool call can mention files in: its path/command inputs and its output. */
export function toolText(input: unknown, result?: string): string {
  const parts: string[] = [];
  if (input && typeof input === 'object')
    for (const k of ['file_path', 'path', 'notebook_path', 'command', 'output', 'filename'])
      if (typeof (input as Record<string, unknown>)[k] === 'string') parts.push((input as Record<string, string>)[k]);
  if (result) parts.push(result.length > 20000 ? result.slice(0, 20000) : result);
  return parts.join('\n');
}
