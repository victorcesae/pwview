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

/** Rounded square mark for a model vendor. */
export function VendorMark({ vendor, className, title }: { vendor: Vendor; className?: string; title?: string }) {
  const v = V[vendor];
  return (
    <span
      className={cn('inline-grid size-4 shrink-0 place-items-center rounded-[4px] text-[7.5px] leading-none font-bold', className)}
      style={{ background: v.bg, color: v.fg }}
      title={title ?? v.name}
      aria-label={title ?? v.name}
      role="img"
    >
      {vendor === 'anthropic' ? (
        // generic 8-point spark
        <svg viewBox="0 0 16 16" className="size-[72%]" fill="currentColor" aria-hidden>
          <path d="M8 1.2 9 6.1l3.6-3.4L10.4 7l4.9.9-4.9 1 2.2 4.4L9 9.9 8 14.8 7 9.9l-3.6 3.4L5.6 9 .7 8l4.9-1-2.2-4.3L7 6.1z" />
        </svg>
      ) : vendor === 'google' ? (
        // generic 4-point star
        <svg viewBox="0 0 16 16" className="size-[78%]" fill="currentColor" aria-hidden>
          <path d="M8 1c.6 3.6 3.4 6.4 7 7-3.6.6-6.4 3.4-7 7-.6-3.6-3.4-6.4-7-7 3.6-.6 6.4-3.4 7-7z" />
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
      <span title={label} role="img" aria-label={label} className={cn('inline-grid size-4 shrink-0 place-items-center rounded-[3px]', className)} style={{ background: '#007ACC', color: '#fff' }}>
        <svg viewBox="0 0 16 16" className="size-[78%]" fill="currentColor" aria-hidden>
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
