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
