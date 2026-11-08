import { useEffect, useState } from 'react';
import { inVsCode, listen, onDevMessage, post } from './bridge';
import { TooltipProvider } from './components/ui/tooltip';
import * as mock from './mock';
import type { Data } from './types';
import { Overview } from './views/Overview';
import { SessionView } from './views/Session';
import { ChatView } from './views/Chat';

export function App() {
  const [data, setData] = useState<Data | undefined>(inVsCode ? undefined : location.hash === '#chat' ? mock.chat : mock.overview);
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

  useEffect(() => {
    const stop = listen(setData);
    if (!inVsCode) {
      onDevMessage((m) => {
        if (m.type === 'openSession') setData(mock.session(m.id, m.agentId));
        else if (m.type === 'overview') setData(mock.overview);
        else if (m.type === 'message') window.postMessage({ type: 'toast', text: m.mode === 'steer' ? 'steering: delivered at its next step' : m.mode === 'now' ? 'interrupted and sent' : 'queued: delivered when this turn ends' }, '*');
        else console.info('[dev] would send to extension:', m);
      });
    }
    post({ type: 'ready' });
    return stop;
  }, []);

  if (!data) return <div className="text-muted-foreground p-6">Loading sessions…</div>;
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
