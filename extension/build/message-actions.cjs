// One-off codemod: Quote on answers, "Edit and run again" on your messages.
const fs = require('fs');
const f = 'webview/src/views/Chat.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) throw new Error('MISSING ' + a.slice(0, 90));
  s = s.replace(a, b);
};
R(
  `    case 'user':
      return (
        <div className="flex flex-col items-end gap-1">`,
  `    case 'user':
      return <UserMessage it={it} />;
    case 'assistant':
      if (!it.text.trim() && !it.streaming) return null;
      return (
        <div className="group/answer flex gap-2.5">
          <AgentAvatar />
          <div className="min-w-0 flex-1">
            <Markdown text={it.text} />
            {it.streaming && <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />}
            {!it.streaming && (
              <div className="mt-0.5 flex gap-1 opacity-0 transition-opacity group-hover/answer:opacity-100 focus-within:opacity-100">
                <Button size="xs" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('agentlens:quote', { detail: it.text }))} title={t('Quote this answer in your next message')} data-quote>
                  <Quote /> {t('Quote')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => navigator.clipboard?.writeText(it.text)} title={t('Copy')} aria-label={t('Copy')}>
                  <Copy />
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    case '__user_old' as never:
      return (
        <div className="flex flex-col items-end gap-1">`,
);
// drop the old assistant case (now above) — it follows the old user case
R(
  `    case 'assistant':
      if (!it.text.trim() && !it.streaming) return null;
      return (
        <div className="flex gap-2.5">
          <AgentAvatar />
          <div className="min-w-0 flex-1">
            <Markdown text={it.text} />
            {it.streaming && <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />}
          </div>
        </div>
      );
`,
  '',
);
// the user message component with Edit and run again
R(
  `function Item({ it, children, sessionId }: { it: ChatItem; children?: React.ReactNode; sessionId?: string }) {`,
  `/** Your message, with "Edit and run again" (forks the conversation at this point). */
function UserMessage({ it }: { it: Extract<ChatItem, { kind: 'user' }> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(it.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) requestAnimationFrame(() => (area.current?.focus(), area.current?.select()));
  }, [editing]);
  const submit = () => {
    if (!draft.trim()) return;
    setEditing(false);
    post({ type: 'editPrompt', id: it.id, text: draft });
  };
  return (
    <div className="group/msg flex flex-col items-end gap-1">
      {it.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {it.images.map((src, i) => (
            <Zoomable key={i} src={src} className="h-20 rounded-md border object-cover" />
          ))}
        </div>
      )}
      {editing ? (
        <div className="bg-muted flex w-full max-w-[85%] flex-col gap-1.5 rounded-2xl rounded-br-md p-2" data-editing>
          <textarea
            ref={area}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), submit());
              if (e.key === 'Escape') (setEditing(false), setDraft(it.text));
            }}
            rows={Math.min(10, Math.max(2, draft.split('\\n').length))}
            className="w-full resize-y bg-transparent px-1.5 text-[13px] outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-muted-foreground mr-auto text-[11px]">{t('Runs the conversation again from here')}</span>
            <Button size="xs" variant="ghost" onClick={() => (setEditing(false), setDraft(it.text))}>
              {t('Cancel')}
            </Button>
            <Button size="xs" onClick={submit} disabled={!draft.trim()}>
              <RotateCcw /> {t('Run again')}
            </Button>
          </div>
        </div>
      ) : (
        it.text && <Markdown text={it.text} className="bg-muted max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-1.5" />
      )}
      <div className="flex items-center gap-1">
        {!editing && it.forkAt && (
          <Button size="xs" variant="ghost" className="opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100" onClick={() => setEditing(true)} title={t('Edit this message and run the conversation again from here')} data-edit-prompt>
            <Pencil /> {t('Edit')}
          </Button>
        )}
        {it.priority && it.priority !== 'later' && (
          <span className="text-muted-foreground opacity-60" title={\`\${PRIORITY[it.priority].label}: \${PRIORITY[it.priority].hint}\`} aria-label={PRIORITY[it.priority].label}>
            {(() => {
              const I = PRIORITY[it.priority].icon;
              return <I className="size-3" />;
            })()}
          </span>
        )}
      </div>
    </div>
  );
}

function Item({ it, children, sessionId }: { it: ChatItem; children?: React.ReactNode; sessionId?: string }) {`,
);
// remove the now-unreachable old user body
const a = s.indexOf(`    case '__user_old' as never:`);
const b = s.indexOf(`    case 'tool':`, a);
s = s.slice(0, a) + s.slice(b);
R(`import { Ban, Bot, ChevronUp, Search, Trash2, `, `import { Ban, Bot, ChevronUp, Copy, Quote, Search, Trash2, `);
fs.writeFileSync(f, s);
const i = 'webview/src/i18n.ts';
let t = fs.readFileSync(i, 'utf8');
t = t.replace(
  `  Context: 'Contexto',`,
  `  Context: 'Contexto',\n  Quote: 'Citar',\n  'Quote this answer in your next message': 'Citar esta resposta na sua próxima mensagem',\n  Copy: 'Copiar',\n  'Runs the conversation again from here': 'Roda a conversa de novo a partir daqui',\n  'Run again': 'Rodar de novo',\n  'Edit this message and run the conversation again from here': 'Editar esta mensagem e rodar a conversa de novo a partir daqui',`,
);
fs.writeFileSync(i, t);
console.log('ok');
