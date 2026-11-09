// One-off codemod: Up/Down recall, suggested next prompt, quote into the composer, prompt stash.
const fs = require('fs');
const f = 'webview/src/views/Composer.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) throw new Error('MISSING ' + a.slice(0, 90));
  s = s.replace(a, b);
};
R(
  `  useEffect(() => {
    input.current?.focus();
  }, []);`,
  `  useEffect(() => {
    input.current?.focus();
  }, []);

  // ---- Up / Down: walk through the prompts you sent in this chat (when the box is empty or showing one)
  const sent = chat.items.filter((it): it is Extract<typeof it, { kind: 'user' }> => it.kind === 'user' && !!it.text.trim()).map((it) => it.text);
  const recall = useRef<{ i: number; shown: string } | null>(null);
  const showRecalled = (i: number) => {
    const v = sent[i];
    recall.current = { i, shown: v };
    input.current?.setMarkdown(v);
    setText(v);
    input.current?.focus();
  };
  const recallKey = (e: KeyboardEvent): boolean => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
    const cur = input.current?.getMarkdown() ?? '';
    const browsing = recall.current && cur === recall.current.shown.trim();
    if (!browsing && cur) return false; // a draft: arrows move the cursor as usual
    if (!sent.length) return false;
    if (e.key === 'ArrowUp') {
      const i = browsing ? Math.max(0, recall.current!.i - 1) : sent.length - 1;
      showRecalled(i);
      return true;
    }
    if (!browsing) return false;
    if (recall.current!.i >= sent.length - 1) {
      recall.current = null;
      input.current?.clear();
      setText('');
      return true;
    }
    showRecalled(recall.current!.i + 1);
    return true;
  };

  // ---- quote an answer into the box ("> " lines), from the Quote button on answers
  useEffect(() => {
    const onQuote = (e: Event) => {
      const q = String((e as CustomEvent).detail ?? '')
        .trim()
        .split('\\n')
        .map((l) => '> ' + l)
        .join('\\n');
      const cur = input.current?.getMarkdown() ?? '';
      const next = \`\${cur ? cur + '\\n\\n' : ''}\${q}\\n\\n\`;
      input.current?.setMarkdown(next);
      setText(next);
      input.current?.focus();
    };
    window.addEventListener('steerhouse:quote', onQuote);
    return () => window.removeEventListener('steerhouse:quote', onQuote);
  }, []);

  // ---- suggested next prompt (from Claude Code, after a turn): Tab or a click puts it in the box
  const useSuggestion = () => {
    if (!chat.suggestion) return;
    input.current?.setMarkdown(chat.suggestion);
    setText(chat.suggestion);
    input.current?.focus();
  };
  const showSuggestion = !!chat.suggestion && !text.trim() && !working;

  // ---- stash: put the current prompt aside, bring it back later (shared by all chats)
  const stashNow = () => {
    const md = input.current?.getMarkdown() ?? '';
    if (!md.trim()) return;
    post({ type: 'stash', text: md });
    input.current?.clear();
    setText('');
  };
  const unstash = (i: number) => {
    const v = chat.stash?.[i];
    if (v === undefined) return;
    const cur = input.current?.getMarkdown() ?? '';
    const next = cur ? \`\${cur}\\n\\n\${v}\` : v;
    input.current?.setMarkdown(next);
    setText(next);
    post({ type: 'unstash', index: i });
    input.current?.focus();
  };`,
);
// suggestion chip above the input
R(
  `      <RichInput
        ref={input}`,
  `      {showSuggestion && (
        <button className="text-muted-foreground hover:text-foreground hover:bg-accent -mb-0.5 flex max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 text-left text-[12px]" onClick={useSuggestion} title={t('Use this suggestion (Tab)')} data-suggestion>
          <Sparkles className="size-3.5 shrink-0" />
          <span className="truncate">{chat.suggestion}</span>
          <kbd className="bg-muted rounded px-1 text-[10px]">Tab</kbd>
        </button>
      )}
      <RichInput
        ref={input}`,
);
// keys: suggestion Tab and recall, before the slash menu
R(
  `        onKey={(e) => {
          if (!slash.length) return false;`,
  `        onKey={(e) => {
          if (showSuggestion && e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            useSuggestion();
            return true;
          }
          if (!slash.length) return recallKey(e);`,
);
// stash menu next to the + menu
R(
  `        <PlusMenu chat={chat} onFiles={() => fileInput.current?.click()} onSlash={(c) => pickSlash(c)} />`,
  `        <PlusMenu chat={chat} onFiles={() => fileInput.current?.click()} onSlash={(c) => pickSlash(c)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="text-muted-foreground hover:text-foreground hover:bg-accent data-[state=open]:bg-accent relative grid size-7 cursor-pointer place-items-center rounded-md" aria-label={t('Prompt stash')} title={t('Prompt stash: put a prompt aside, bring it back later')} data-stash>
              <Archive className="size-4" />
              {!!chat.stash?.length && <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full px-0.5 text-center text-[9px] leading-3.5">{chat.stash.length}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="max-w-96">
            <DropdownMenuItem onSelect={stashNow} disabled={!text.trim()}>
              <ArchiveRestore className="rotate-180" /> {t('Stash this prompt')}
            </DropdownMenuItem>
            {!!chat.stash?.length && <DropdownMenuSeparator />}
            {!!chat.stash?.length && <DropdownMenuLabel>{t('Stashed prompts')}</DropdownMenuLabel>}
            {(chat.stash ?? []).map((p, i) => (
              <DropdownMenuItem key={i} onSelect={() => unstash(i)} title={p} data-stashed>
                <span className="truncate">{p.split('\\n')[0]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>`,
);
R(`import { Blocks, Bot, `, `import { Archive, ArchiveRestore, Blocks, Bot, `);
fs.writeFileSync(f, s);
const i = 'webview/src/i18n.ts';
let t = fs.readFileSync(i, 'utf8');
t = t.replace(
  `  Context: 'Contexto',`,
  `  Context: 'Contexto',\n  'Use this suggestion (Tab)': 'Usar esta sugestão (Tab)',\n  'Prompt stash': 'Prompts guardados',\n  'Prompt stash: put a prompt aside, bring it back later': 'Guardar um prompt para depois e trazê-lo de volta',\n  'Stash this prompt': 'Guardar este prompt',\n  'Stashed prompts': 'Prompts guardados',`,
);
fs.writeFileSync(i, t);
console.log('ok');
