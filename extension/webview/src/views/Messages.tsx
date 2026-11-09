import { ImagePlus, ListOrdered, Navigation, Pencil, SquareTerminal, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { post } from '@/bridge';
import { t } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ago, cn, rel } from '@/lib/utils';
import type { Comment, Mode, SessionInfo } from '@/types';

type Data = { info: SessionInfo; comments: Comment[]; terminal?: boolean };

const MODE_INFO: Record<Mode, { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = {
  steer: { label: 'Steer', icon: Navigation, hint: 'The agent gets it at its next step, without stopping.' },
  queue: { label: 'Queue', icon: ListOrdered, hint: 'Delivered when the current turn ends; then the agent works on it.' },
  now: { label: 'Send now', icon: Zap, hint: 'Interrupts the agent (Esc) and sends it as your next prompt.' },
};

type Img = { data: string; mime: string; name: string };
const readImage = (f: File) =>
  new Promise<Img>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok({ data: String(r.result), mime: f.type || 'image/png', name: f.name || 'pasted image' });
    r.onerror = bad;
    r.readAsDataURL(f);
  });

export function MessagesTab({ data }: { data: Data }) {
  const working = data.info.state === 'working';
  const [mode, setMode] = useState<Mode>('steer');
  const [text, setText] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [over, setOver] = useState(false);

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length) {
      const read = await Promise.all(imgs.map(readImage));
      setImages((prev) => [...prev, ...read]);
    }
  };
  const send = () => {
    if (!text.trim() && !images.length) return;
    post({ type: 'message', id: data.info.id, text, mode, images: images.map(({ data, mime }) => ({ data, mime })) });
    setText('');
    setImages([]);
  };
  const info = MODE_INFO[mode];
  const hint = mode === 'now' && !data.terminal ? 'No VS Code terminal runs this session, so this will steer instead.' : working ? info.hint : 'The agent is idle: it gets this as its next prompt.';
  const pending = data.comments.filter((c) => c.status === 'pending');
  const history = data.comments.filter((c) => c.status !== 'pending').reverse();

  return (
    <div className="flex flex-col gap-4">
      <Card
        className={cn('transition-colors', over && 'border-ring')}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        <CardContent className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted inline-flex rounded-lg p-[3px]" role="radiogroup" aria-label={t('Delivery')}>
              {(Object.keys(MODE_INFO) as Mode[]).map((m) => {
                const I = MODE_INFO[m].icon;
                return (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium transition-colors',
                      mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <I className="size-3.5" />
                    {MODE_INFO[m].label}
                  </button>
                );
              })}
            </div>
            <span className="text-muted-foreground text-[11px]">{hint}</span>
            {data.terminal && (
              <Badge variant="outline" className="ml-auto">
                <SquareTerminal />
                terminal attached
              </Badge>
            )}
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && send()}
            placeholder={t('Message for this agent. Paste or drop screenshots here too…')}
          />
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={i} className="group relative">
                  <img src={img.data} alt={img.name} className="h-16 w-auto rounded-md border object-cover" />
                  <button
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                    className="bg-background absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full border opacity-0 group-hover:opacity-100"
                    aria-label={t('Remove image')}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
              <ImagePlus className="size-3.5" />
              Paste or drop images · Ctrl+Enter to send
            </span>
            <Button size="sm" className="ml-auto" onClick={send} disabled={!text.trim() && !images.length}>
              <info.icon /> {info.label}
            </Button>
          </div>
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">{t('Waiting to be delivered')}</h3>
          {pending.map((c) => (
            <MessageRow key={c.id} c={c} project={data.info.project} />
          ))}
        </section>
      )}
      {history.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">Sent</h3>
          {history.map((c) => (
            <MessageRow key={c.id} c={c} project={data.info.project} />
          ))}
        </section>
      )}
    </div>
  );
}

function MessageRow({ c, project }: { c: Comment; project: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.text);
  const m = MODE_INFO[c.mode ?? 'queue'];
  const where = { step: 'mid-task', terminal: 'to the terminal', 'turn-end': 'at turn end', prompt: 'with your prompt' }[c.deliveredVia ?? 'prompt'];
  const status =
    c.status === 'pending' ? (c.mode === 'steer' ? 'at its next step' : 'when the turn ends') : c.status === 'cancelled' ? 'cancelled' : `delivered ${where} ${ago(c.deliveredAt)}`;
  return (
    <div className={cn('flex gap-3 rounded-lg border px-3 py-2.5', c.status === 'cancelled' && 'opacity-50')}>
      <m.icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
          <Badge variant={c.status === 'pending' ? 'warn' : c.status === 'delivered' ? 'recent' : 'outline'}>
            {m.label} · {status}
          </Badge>
          {c.file && (
            <button className="text-muted-foreground cursor-pointer font-mono hover:underline" onClick={() => post({ type: 'openFile', path: c.file! })}>
              {rel(c.file, project)}
              {c.line !== undefined ? `:${c.line + 1}` : ''}
            </button>
          )}
          <span className="text-muted-foreground ml-auto">{ago(c.created)}</span>
          {c.status === 'pending' && !editing && (
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              <Pencil /> {t('Edit')}
            </Button>
          )}
          {c.status === 'pending' && (
            <Button size="xs" variant="secondary" onClick={() => post({ type: 'promoteComment', commentId: c.id })} title={t('Interrupt and send it now')}>
              <Zap /> Send now
            </Button>
          )}
          {c.status === 'pending' && (
            <Button size="xs" variant="ghost" onClick={() => post({ type: 'cancelComment', commentId: c.id })}>
              <X /> Cancel
            </Button>
          )}
        </div>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus className="min-h-12" />
            <div className="flex gap-1.5">
              <Button
                size="xs"
                onClick={() => {
                  post({ type: 'editComment', commentId: c.id, text });
                  setEditing(false);
                }}
              >
                {t('Save')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setText(c.text);
                  setEditing(false);
                }}
              >
                {t('Cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-[13px] whitespace-pre-wrap">{c.text}</div>
        )}
        {c.snippet && <code className="bg-muted mt-1.5 block truncate rounded px-2 py-1 text-[11px]">{c.snippet.trim()}</code>}
      </div>
    </div>
  );
}
