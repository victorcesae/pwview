import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function ago(ts?: string): string {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const clock = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

export const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function rel(file: string, root: string) {
  const f = file.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  return f.toLowerCase().startsWith(r.toLowerCase() + '/') ? f.slice(r.length + 1) : f;
}
