import { t } from '@/i18n';
import { useEffect, useState } from 'react';
import { inVsCode, listen, onDevMessage, post, saveState } from './bridge';
import { TooltipProvider } from './components/ui/tooltip';
import * as mock from './mock';
import type { ChatItem, Data } from './types';
import { Overview } from './views/Overview';
import { SessionView } from './views/Session';
import { ChatView } from './views/Chat';

export function App() {
  const [data, setData] = useState<Data | undefined>(inVsCode ? undefined : location.hash === '#multi' ? mock.multiChat() : location.hash === '#long' ? mock.longChat() : location.hash === '#chat' ? mock.chat : mock.overview);
  const [toast, setToast] = useState<string>();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onToast = (e: MessageEvent) => {
      if (e.data?.type !== 'toast') return;
      setToast(e.data.text);
      clearTimeout(timer);
      timer = setTimeout(() => setToast(undefined), 3500);
    };
    window.addEventListener('message', onToast);
    return () => window.removeEventListener('message', onToast);
  }, []);

  const restoreKey = data?.view === 'chat' ? `${data.chat.sessionId}|${data.chat.cwd}|${data.chat.title}|${data.chat.account.name}` : '';
  useEffect(() => {
    if (data?.view === 'chat' && data.chat.sessionId) saveState({ sessionId: data.chat.sessionId, cwd: data.chat.cwd, title: data.chat.title, account: data.chat.account.name });
  }, [restoreKey]);

  useEffect(() => {
    if (!inVsCode) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !/^https?:/i.test(a.href)) return;
      e.preventDefault();
      post({ type: 'openUrl', url: a.href } as never);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    const stop = listen(setData);
    // chats send only what changed after the first paint: merge it into what we have
    const onPatch = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type !== 'chatPatch') return;
      setData((prev) => {
        if (!prev || prev.view !== 'chat') return prev;
        const byId = new Map(prev.chat.items.map((it) => [it.id, it]));
        for (const it of m.upserts as ChatItem[]) byId.set(it.id, it);
        const order: string[] = m.order ?? prev.chat.items.map((it) => it.id);
        const items = order.map((id) => byId.get(id)).filter((x): x is ChatItem => !!x);
        return { view: 'chat', chat: { ...m.chat, items }, linked: m.linked ?? prev.linked };
      });
    };
    window.addEventListener('message', onPatch);
    if (!inVsCode) {
      onDevMessage((m) => {
        if (m.type === 'openSession') setData(mock.session(m.id, m.agentId));
        else if (m.type === 'overview') setData(mock.overview);
        else if (m.type === 'message') window.postMessage({ type: 'toast', text: m.mode === 'steer' ? 'steering: delivered at its next step' : m.mode === 'now' ? 'interrupted and sent' : 'queued: delivered when this turn ends' }, '*');
        else console.info('[dev] would send to extension:', m);
      });
    }
    post({ type: 'ready' });
    return () => {
      stop();
      window.removeEventListener('message', onPatch);
    };
  }, []);

  if (!data) return <div className="text-muted-foreground p-6">{t('Loading sessions…')}</div>;
  if (data.view === 'chat') return <ChatView data={data} />;
  return (
    <TooltipProvider>
      <div className="mx-auto max-w-[1180px] px-4 py-4 sm:px-6">
        {data.view === 'overview' ? <Overview data={data.overview} /> : <SessionView data={data.session} focusAgent={data.focusAgent} />}
      </div>
      {toast && (
        <div role="status" className="bg-popover text-popover-foreground animate-in fade-in-0 slide-in-from-bottom-2 fixed right-4 bottom-4 z-50 rounded-lg border px-3.5 py-2 text-[12px] shadow-lg">
          {toast}
        </div>
      )}
    </TooltipProvider>
  );
}
