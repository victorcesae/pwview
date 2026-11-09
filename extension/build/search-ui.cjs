// One-off codemod: chat search (Ctrl+F) and "Load earlier messages".
const fs = require('fs');
const f = 'webview/src/views/Chat.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) {
    console.error('MISSING: ' + a.slice(0, 90));
    process.exit(1);
  }
  s = s.split(a).join(b);
};

// helpers before the page
R(
  '/** Which model and editor this chat runs on, for the answer avatars. */',
  `/** Searchable text of a transcript row. */
function rowText(g: ChatItem | ToolItem[]): string {
  if (Array.isArray(g)) return g.map((it) => \`\${it.name} \${it.summary} \${it.file ?? ''} \${it.result ?? ''}\`).join(' ');
  switch (g.kind) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'result':
      return g.text;
    case 'tool':
      return \`\${g.name} \${g.summary} \${g.result ?? ''}\`;
    case 'permission':
      return \`\${g.tool} \${g.summary}\`;
    case 'plan':
      return g.plan;
    case 'question':
      return g.questions.map((q) => q.question).join(' ');
  }
}

/** Which model and editor this chat runs on, for the answer avatars. */`,
);

// state + effects inside ChatView (after the virtualizer)
R(
  '  // follow new output while you\'re at the bottom',
  `  // ---- search (Ctrl+F)
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    return rows.flatMap((g, i) => (rowText(g).toLowerCase().includes(q) ? [i] : []));
  }, [rows, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const current = matches.length ? matches[Math.min(cursor, matches.length - 1)] : -1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchInput.current?.select());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (current < 0) return;
    stick.current = false;
    setAtBottom(false);
    virtualizer.scrollToIndex(current, { align: 'center' });
  }, [current]);
  const step = (d: number) => matches.length && setCursor((c) => (c + d + matches.length) % matches.length);

  // ---- load earlier history, keeping your place
  const pendingEarlier = useRef<number | null>(null);
  useEffect(() => {
    if (pendingEarlier.current === null) return;
    const added = rows.length - pendingEarlier.current;
    pendingEarlier.current = null;
    if (added > 0) virtualizer.scrollToIndex(added, { align: 'start' });
  }, [rows.length]);

  // follow new output while you're at the bottom`,
);

// search button in the header
R(
  "        <Button size=\"xs\" variant=\"ghost\" onClick={() => post({ type: 'link' })}",
  `        <Button size="xs" variant="ghost" onClick={() => (setSearchOpen((o) => !o), requestAnimationFrame(() => searchInput.current?.focus()))} title={t('Search (Ctrl+F)')} aria-label={t('Search')}>
          <Search />
        </Button>
        <Button size="xs" variant="ghost" onClick={() => post({ type: 'link' })}`,
);
// search bar under the header
R(
  '      {linked.length > 0 && (',
  `      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-1.5" role="search">
          <Search className="text-muted-foreground size-3.5" />
          <input
            ref={searchInput}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') setSearchOpen(false);
            }}
            placeholder={t('Search this chat…')}
            className="min-w-40 flex-1 bg-transparent text-[12.5px] outline-none"
          />
          <span className="text-muted-foreground text-[11px] tabular-nums">{query.trim() ? (matches.length ? \`\${Math.min(cursor, matches.length - 1) + 1} / \${matches.length}\` : t('No matches')) : ''}</span>
          <Button size="xs" variant="ghost" onClick={() => step(-1)} disabled={!matches.length} aria-label={t('Previous match')}>
            <ChevronUp />
          </Button>
          <Button size="xs" variant="ghost" onClick={() => step(1)} disabled={!matches.length} aria-label={t('Next match')}>
            <ChevronDown />
          </Button>
          {chat.earlier > 0 && (
            <Button size="xs" variant="outline" onClick={() => post({ type: 'loadEarlier', all: true })}>
              {t('Include {0} earlier', chat.earlier)}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setSearchOpen(false)} aria-label={t('Close search')}>
            <X />
          </Button>
        </div>
      )}
      {linked.length > 0 && (`,
);
// load earlier button at the top of the list
R(
  '          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>',
  `          {chat.earlier > 0 && (
            <div className="flex justify-center pb-3">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  pendingEarlier.current = rows.length;
                  post({ type: 'loadEarlier' });
                }}
              >
                <ChevronUp /> {t('Load earlier messages ({0} more)', chat.earlier)}
              </Button>
            </div>
          )}
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>`,
);
// highlight matching rows
R(
  '<div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full pb-3" style={{ transform: `translateY(${v.start}px)` }}>',
  "<div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={cn('absolute top-0 left-0 w-full pb-3', matchSet.has(v.index) && 'search-hit', v.index === current && 'search-current')} style={{ transform: `translateY(${v.start}px)` }}>",
);
R('import { Ban, Bot, ChevronUp, ', 'import { Ban, Bot, ChevronUp, Search, ');
fs.writeFileSync(f, s);

fs.appendFileSync(
  'webview/src/index.css',
  `
/* chat search hits */
.search-hit > * {
  box-shadow: -3px 0 0 color-mix(in srgb, var(--warn) 45%, transparent);
  border-radius: 6px;
}
.search-current > * {
  box-shadow: -3px 0 0 var(--warn), 0 0 0 1px color-mix(in srgb, var(--warn) 50%, transparent);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
}
`,
);
let i = fs.readFileSync('webview/src/i18n.ts', 'utf8');
i = i.replace(
  "  Context: 'Contexto',",
  "  Context: 'Contexto',\n  Search: 'Buscar',\n  'Search (Ctrl+F)': 'Buscar (Ctrl+F)',\n  'Search this chat…': 'Buscar neste chat…',\n  'No matches': 'Nenhum resultado',\n  'Previous match': 'Resultado anterior',\n  'Next match': 'Próximo resultado',\n  'Include {0} earlier': 'Incluir {0} anteriores',\n  'Close search': 'Fechar busca',\n  'Load earlier messages ({0} more)': 'Carregar mensagens anteriores ({0} a mais)',",
);
fs.writeFileSync('webview/src/i18n.ts', i);
console.log('ok');
