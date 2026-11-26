// Small, safe markdown renderer for agent messages (no HTML injection: builds React nodes; the only
// raw HTML is highlight.js output, which escapes the code, and mermaid SVG rendered in strict mode).
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { post } from '@/bridge';
import { t } from '@/i18n';

type Highlighter = typeof import('@/lib/highlight');
let hl: Highlighter | undefined;
let hlLoad: Promise<Highlighter> | undefined;
/** highlight.js loads once, the first time a finished code block with a language shows up. */
const loadHighlighter = () => (hlLoad ??= import('@/lib/highlight').then((m) => (hl = m)));

type Mermaid = typeof import('mermaid').default;
let mermaidLoad: Promise<Mermaid> | undefined;
let mermaidSeq = 0;
const loadMermaid = () => (mermaidLoad ??= import('mermaid').then((m) => m.default));

/** Dark unless the editor theme is a light one (VS Code puts the kind on <body>), updated live. */
function useDarkTheme() {
  const read = () => typeof document !== 'undefined' && !/\bvscode-(light|high-contrast-light)\b/.test(document.body.className);
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setDark(read()));
    o.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/**
 * A fenced code block: header with the language and Copy, readable text (long lines wrap, tall blocks
 * scroll). Highlighted only once the block is closed, so streaming text isn't re-highlighted per token.
 */
function CodeBlock({ lang, code, closed = true, children }: { lang?: string; code: string; closed?: boolean; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(!!hl);
  const language = lang?.toLowerCase();
  useEffect(() => {
    if (closed && language && !children) loadHighlighter().then(() => setReady(true), () => {});
  }, [closed, language, children]);
  const html = useMemo(() => (ready && closed && language && hl ? hl.highlight(code, language) : undefined), [ready, closed, language, code]);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="bg-muted my-2 overflow-hidden rounded-lg border" data-code-block>
      <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1 text-[11px]">
        <span className="font-mono">{lang || 'text'}</span>
        <button className="hover:text-foreground inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5" onClick={copy} aria-label={t('Copy')} data-copy-code>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      {children ?? (
        <pre className="text-foreground m-0 max-h-[28rem] overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">
          {html !== undefined ? (
            <code className="hljs text-foreground bg-transparent p-0 font-mono" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <code className="text-foreground bg-transparent p-0 font-mono">{code}</code>
          )}
        </pre>
      )}
    </div>
  );
}

/** A ```mermaid block drawn as a diagram (mermaid loads on first use); the code block if it doesn't parse. */
function MermaidBlock({ code, closed }: { code: string; closed: boolean }) {
  const dark = useDarkTheme();
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!closed) return;
    let live = true;
    const id = `steerhouse-mermaid-${++mermaidSeq}`;
    (async () => {
      try {
        const m = await loadMermaid();
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        await m.parse(code);
        const out = await m.render(id, code);
        if (live) {
          setSvg(out.svg);
          setFailed(false);
        }
      } catch {
        // mermaid leaves its error drawing in the page; take it out
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [code, closed, dark]);
  if (!closed || failed || !svg) return <CodeBlock lang="mermaid" code={code} closed={closed} />;
  return (
    <CodeBlock lang="mermaid" code={code}>
      <div className="flex max-h-[36rem] justify-center overflow-auto p-3 [&_svg]:h-auto [&_svg]:max-w-full" data-mermaid dangerouslySetInnerHTML={{ __html: svg }} />
    </CodeBlock>
  );
}

/** `src/foo.ts:12`, `./a/b.tsx`, `/abs/x.py:3:7`: a path with a folder or a line number. */
const FILE_REF = /^(?:\.{1,2}\/|\/|~\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?$/;
const isFileRef = (s: string) => FILE_REF.test(s) && (s.includes('/') || /:\d+/.test(s));
const openRef = (path: string) => post({ type: 'openFile', path });

import { cn } from '@/lib/utils';
import { Zoomable } from '@/components/Lightbox';

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!?\[[^\]]*\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) {
      const body = t.slice(1, -1);
      out.push(
        isFileRef(body) ? (
          <code
            key={k}
            role="link"
            tabIndex={0}
            title={body}
            data-file-ref
            onClick={() => openRef(body)}
            onKeyDown={(e) => e.key === 'Enter' && openRef(body)}
            className="bg-muted cursor-pointer rounded px-1 py-px font-mono text-[0.92em] text-[var(--vscode-textLink-foreground,#60a5fa)] [overflow-wrap:anywhere] hover:underline"
          >
            {body}
          </code>
        ) : (
          <code key={k} className="bg-muted rounded px-1 py-px font-mono text-[0.92em] [overflow-wrap:anywhere]">{body}</code>
        ),
      );
    }
    else if (m[2]) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (m[3] && t.startsWith('![')) {
      // an inline picture joins the gallery; a local file path shows as a preview card under the answer
      const [, alt, src] = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(t)!;
      if (src.startsWith('data:image/')) out.push(<Zoomable key={k} src={src} className="max-h-64 max-w-full rounded-md border object-contain" />);
      else out.push(<span key={k} className="text-muted-foreground">{alt || src}</span>);
    } else if (m[3]) {
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
      const closed = i < lines.length; // still streaming while the closing fence hasn't arrived
      i++;
      blocks.push(
        fence[1]?.toLowerCase() === 'mermaid' ? (
          <MermaidBlock key={k++} code={code.join('\n')} closed={closed} />
        ) : (
          <CodeBlock key={k++} lang={fence[1]} code={code.join('\n')} closed={closed} />
        ),
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
                  <th key={j} style={{ textAlign: align[j] as 'left' }} className="border-r border-b px-2.5 py-1.5 font-semibold last:border-r-0">
                    {inline(c, `th${k}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="even:bg-muted/40 border-b last:border-b-0">
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] as 'left' }} className="border-r px-2.5 py-1.5 align-top last:border-r-0">
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
