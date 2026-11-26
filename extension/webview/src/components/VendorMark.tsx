// Small marks for the model vendor and the editor (e.g. "Cursor + Claude"). Simple shapes and
// monograms in each vendor's color, not the companies' logos (those are trademarks).
import { cn } from '@/lib/utils';

export type Vendor = 'cursor' | 'anthropic' | 'openai' | 'google' | 'meta' | 'qwen' | 'deepseek' | 'mistral' | 'xai' | 'other';

export function vendorOf(model?: string): Vendor {
  const m = (model ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return 'anthropic';
  if (/gpt|o1|o3|o4|codex|openai/.test(m)) return 'openai';
  if (/gemini|gemma|google/.test(m)) return 'google';
  if (/llama|meta/.test(m)) return 'meta';
  if (/qwen/.test(m)) return 'qwen';
  if (/deepseek/.test(m)) return 'deepseek';
  if (/mistral|mixtral|codestral|devstral/.test(m)) return 'mistral';
  if (/grok|xai/.test(m)) return 'xai';
  return 'other';
}

const V: Record<Vendor, { name: string; bg: string; fg: string; text?: string }> = {
  cursor: { name: 'Cursor', bg: '#2B2B2B', fg: '#fff', text: 'C' },
  anthropic: { name: 'Claude', bg: '#D97757', fg: '#fff' },
  openai: { name: 'GPT', bg: '#10A37F', fg: '#fff', text: 'GPT' },
  google: { name: 'Gemini', bg: '#4285F4', fg: '#fff' },
  meta: { name: 'Llama', bg: '#0866FF', fg: '#fff', text: 'L' },
  qwen: { name: 'Qwen', bg: '#615CED', fg: '#fff', text: 'Q' },
  deepseek: { name: 'DeepSeek', bg: '#4D6BFE', fg: '#fff', text: 'DS' },
  mistral: { name: 'Mistral', bg: '#FA520F', fg: '#fff', text: 'M' },
  xai: { name: 'Grok', bg: '#111111', fg: '#fff', text: 'X' },
  other: { name: 'Model', bg: 'var(--muted)', fg: 'var(--foreground)', text: '?' },
};

export const vendorName = (v: Vendor) => V[v].name;

/** A model vendor's mark in its color, without a tile (like the official Claude Code tab icon). */
export function VendorMark({ vendor, className, title }: { vendor: Vendor; className?: string; title?: string }) {
  const v = V[vendor];
  const color = vendor === 'cursor' || vendor === 'xai' || vendor === 'other' ? 'var(--muted-foreground)' : v.bg;
  return (
    <span className={cn('inline-grid size-4 shrink-0 place-items-center text-[9px] leading-none font-extrabold', className)} style={{ color }} title={title ?? v.name} aria-label={title ?? v.name} role="img">
      {vendor === 'anthropic' ? (
        // the Claude starburst: rounded rays
        <svg viewBox="0 0 16 16" className="size-full" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden>
          {[7, 5.6, 6.6, 5.2, 7, 5.8, 6.4, 5.4, 6.9, 5.5, 6.5, 5.3].map((len, i) => {
            const a = ((i * 30 - 90 + 7 * (i % 2)) * Math.PI) / 180;
            return <line key={i} x1={8 + 1.2 * Math.cos(a)} y1={8 + 1.2 * Math.sin(a)} x2={8 + len * Math.cos(a)} y2={8 + len * Math.sin(a)} />;
          })}
        </svg>
      ) : vendor === 'google' ? (
        <svg viewBox="0 0 16 16" className="size-full" fill="currentColor" aria-hidden>
          <path d="M8 .8c.6 3.8 3.4 6.6 7.2 7.2-3.8.6-6.6 3.4-7.2 7.2C7.4 11.4 4.6 8.6.8 8 4.6 7.4 7.4 4.6 8 .8z" />
        </svg>
      ) : vendor === 'cursor' ? (
        <svg viewBox="0 0 16 16" className="size-full" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" aria-hidden>
          <path d="M8 1.2 14.2 4.8v6.4L8 14.8 1.8 11.2V4.8z" />
          <path d="M1.8 4.8 8 8.4l6.2-3.6M8 8.4v6.4" />
          <path d="M8 1.2 14.2 4.8 8 8.4z" fill="currentColor" />
        </svg>
      ) : (
        v.text
      )}
    </span>
  );
}

/** The editor the agent runs in (VS Code, Cursor, Windsurf…). */
export function HostMark({ host, icon, className }: { host?: string; icon?: string; className?: string }) {
  if (!host) return null;
  const h = host.toLowerCase();
  const label = h.includes('cursor') ? 'Cursor' : h.includes('windsurf') ? 'Windsurf' : h.includes('codium') ? 'VSCodium' : 'VS Code';
  // the editor's own app icon, read from its install
  if (icon) return <img src={icon} alt={label} title={label} className={cn('inline-block size-4 shrink-0 rounded-[3px] object-contain', className)} />;
  // over SSH the editor's install is on the other machine, and the server has no icon: the VS Code
  // mark from Microsoft's codicons (@vscode/codicons, CC BY 4.0)
  if (label === 'VS Code')
    return (
      <span title={label} role="img" aria-label={label} className={cn('inline-grid size-4 shrink-0 place-items-center', className)} style={{ color: '#007ACC' }}>
        <svg viewBox="0 0 16 16" className="size-full" fill="currentColor" aria-hidden>
          <path d="M15.434 1.72887L12.14 0.144875C12.002 0.078875 11.855 0.046875 11.709 0.046875C11.353 0.046875 11.18 0.211875 11.155 0.228875C11.073 0.270875 11.005 0.337875 11.004 0.338875L4.698 6.08888L1.951 4.00488C1.832 3.91388 1.69 3.86987 1.548 3.86987C1.387 3.86987 1.226 3.92788 1.1 4.04288L0.219 4.84387C0.074 4.97587 0.001 5.15688 0.001 5.33687C0.001 5.51687 0.073 5.69688 0.218 5.82888L2.6 8.00088L0.217 10.1719C0.072 10.3039 0 10.4839 0 10.6639C0 10.8439 0.073 11.0249 0.218 11.1569L1.099 11.9579C1.226 12.0729 1.386 12.1309 1.547 12.1309C1.688 12.1309 1.83 12.0859 1.95 11.9959L4.697 9.91187L11.003 15.6619C11.003 15.6619 11.072 15.7299 11.155 15.7719C11.179 15.7889 11.353 15.9529 11.709 15.9529C11.855 15.9529 12.003 15.9209 12.141 15.8549L15.435 14.2709C15.781 14.1049 16.001 13.7539 16.001 13.3699V2.62888C16.001 2.24487 15.781 1.89488 15.435 1.72787L15.434 1.72887ZM7.217 7.99988L12.002 4.36987V11.6299L7.217 7.99988Z" />
        </svg>
      </span>
    );
  const style = h.includes('cursor')
    ? { background: '#000', color: '#fff', text: 'Cu' }
    : h.includes('windsurf')
      ? { background: '#0B9C87', color: '#fff', text: 'W' }
      : { background: '#007ACC', color: '#fff', text: 'VS' };
  return (
    <span className={cn('inline-grid size-4 shrink-0 place-items-center rounded-[4px] text-[7px] leading-none font-bold', className)} style={{ background: style.background, color: style.color }} title={label} aria-label={label} role="img">
      {style.text}
    </span>
  );
}

export const hostName = (host?: string) => {
  const h = (host ?? '').toLowerCase();
  return h.includes('cursor') ? 'Cursor' : h.includes('windsurf') ? 'Windsurf' : h.includes('codium') ? 'VSCodium' : host ? 'VS Code' : '';
};
