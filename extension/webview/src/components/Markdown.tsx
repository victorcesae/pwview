// Small, safe markdown renderer for agent messages (no HTML injection: builds React nodes).
import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="bg-muted rounded px-1 py-px font-mono text-[0.92em]">{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (m[3]) {
      const [, label, href] = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(t)!;
      out.push(<a key={k} href={href} className="text-[var(--vscode-textLink-foreground,#60a5fa)] underline-offset-2 hover:underline">{label}</a>);
    } else if (m[4]) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w+)?/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={k++} className="bg-muted/70 my-2 overflow-x-auto rounded-md border px-3 py-2 font-mono text-[12px] leading-relaxed">
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const size = ['text-[17px]', 'text-[15px]', 'text-[14px]', 'text-[13px]'][h[1].length - 1];
      blocks.push(<div key={k++} className={cn('mt-4 mb-1.5 font-semibold first:mt-0', size)}>{inline(h[2], `h${k}`)}</div>);
      i++;
      continue;
    }
    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={k++} className="my-3 border-t" />);
      i++;
      continue;
    }
    // table: header row, separator row (|---|:--:|), body rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={k++} className="my-2.5 overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead className="bg-muted/60">
              <tr>
                {head.map((c, j) => (
                  <th key={j} style={{ textAlign: align[j] as 'left' }} className="border-b px-2.5 py-1.5 font-semibold">
                    {inline(c, `th${k}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b last:border-b-0">
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] as 'left' }} className="px-2.5 py-1.5 align-top">
                      {inline(r[j] ?? '', `td${k}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={k++} className={cn('my-2 space-y-1 pl-5 leading-[1.6]', ordered ? 'list-decimal' : 'list-disc')}>
          {items.map((it, j) => (
            <li key={j}>{inline(it.replace(/^\[( |x)\]\s*/, (_, x) => (x === 'x' ? '☑ ' : '☐ ')), `l${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++} className="text-muted-foreground my-1 border-l-2 pl-3">{inline(q.join(' '), `q${k}`)}</blockquote>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|>)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(
      <p key={k++} className="my-2 leading-[1.65] first:mt-0 last:mb-0">
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p, `p${k}-${j}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className={cn('text-[13px] break-words', className)}>{blocks}</div>;
}
