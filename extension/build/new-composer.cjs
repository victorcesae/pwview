// One-off codemod: swap the old composer for views/Composer.tsx; context usage; starting state;
// jump-to-bottom button.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
const cut = (f, from, to) => {
  const s = fs.readFileSync(f, 'utf8');
  const a = s.indexOf(from);
  const b = s.indexOf(to, a);
  if (a < 0 || b < 0) {
    console.error('MISSING cut ' + f + ': ' + from.slice(0, 50));
    process.exit(1);
  }
  fs.writeFileSync(f, s.slice(0, a) + s.slice(b));
};

const C = 'webview/src/views/Chat.tsx';
// drop the old PRIORITY / MODES tables and the old composer
cut(C, 'const PRIORITY: Record<Priority,', '// ---------------------------------------------------------------- plan / todos');
cut(C, '// ---------------------------------------------------------------- composer', '/** Consecutive plain tool calls');
R(C, "import { HunkView } from './Session';", "import { HunkView } from './Session';\nimport { Composer, PRIORITY } from './Composer';");
// jump to bottom
R(C, '  const stick = useRef(true);', '  const stick = useRef(true);\n  const [atBottom, setAtBottom] = useState(true);');
R(C, '          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;', '          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;\n          setAtBottom(stick.current);');
R(
  C,
  '      <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2 px-4 pt-1 pb-3">',
  `      <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-2 px-4 pt-1 pb-3">
        {!atBottom && (
          <button
            onClick={() => {
              stick.current = true;
              setAtBottom(true);
              end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
            }}
            className="bg-popover text-popover-foreground hover:bg-accent absolute -top-11 left-1/2 z-30 inline-flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-[11.5px] shadow-md"
            aria-label={t('Jump to latest')}
          >
            <ChevronDown className="size-3.5" /> {t('Jump to latest')}
          </button>
        )}`,
);
// starting state in the header
R(
  C,
  '        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title}</h1>',
  `        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{chat.title}</h1>
        {chat.status === 'starting' && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11.5px]" role="status">
            <Loader2 className="size-3.5 animate-spin" /> {t('Starting Claude Code…')}
          </span>
        )}`,
);
// stray old textarea import is no longer needed
R(C, "import { Textarea } from '@/components/ui/textarea';\n", '');

// ---- engine: context usage after each turn, 'starting' until init
const E = 'src/chat.ts';
R(E, '  tokens?: number;\n', "  tokens?: number;\n  /** Context window usage after the last turn (for the ring next to the input). */\n  context?: { used: number; max: number; percentage: number; categories?: { name: string; tokens: number }[] };\n");
R(E, "          this.state.sessionId = m.session_id;", "          this.state.sessionId = m.session_id;\n          if (this.state.status === 'starting') this.state.status = 'idle';");
R(E, "    this.state.status = 'idle';\n    this.changed();\n  }", "    this.changed();\n  }");
R(
  E,
  '        // the turn ended: steers that never found a next step go first',
  `        this.q
          ?.getContextUsage({ detail: 'summary' })
          .then((u: any) => {
            this.state.context = {
              used: u.totalTokens,
              max: u.maxTokens,
              percentage: u.percentage,
              categories: (u.categories ?? []).filter((c: any) => c.kind === 'used' && c.tokens > 0).map((c: any) => ({ name: c.name, tokens: c.tokens })),
            };
            this.changed();
          })
          .catch(() => {});
        // the turn ended: steers that never found a next step go first`,
);
R('webview/src/types.ts', 'tokens?: number;', 'tokens?: number; context?: { used: number; max: number; percentage: number; categories?: { name: string; tokens: number }[] };');
console.log('ok');
