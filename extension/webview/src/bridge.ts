import type { Data, ToExtension } from './types';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; setState(s: unknown): void };

const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
export const inVsCode = !!api;

let devHandler: ((m: ToExtension) => void) | undefined;
/** Browser dev mode (`npm run dev:webview`): mock data answers instead of the extension. */
export const onDevMessage = (h: (m: ToExtension) => void) => (devHandler = h);

export function post(m: ToExtension) {
  if (api) api.postMessage(m);
  else devHandler?.(m);
}

/** Kept by VS Code across Reload Window; the extension reads it to reopen this chat. */
export const saveState = (s: unknown) => api?.setState(s);

export function listen(cb: (d: Data) => void) {
  const h = (e: MessageEvent) => e.data?.type === 'data' && cb(e.data.data);
  window.addEventListener('message', h);
  return () => window.removeEventListener('message', h);
}
