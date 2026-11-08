// One-off codemod: sticky headers + bottom "Collapse" for expanded tool details; minimal markers.
const fs = require('fs');
const f = 'webview/src/views/Chat.tsx';
let s = fs.readFileSync(f, 'utf8');
const R = (a, b) => {
  if (!s.includes(a)) {
    console.error('MISSING: ' + a.slice(0, 80));
    process.exit(1);
  }
  s = s.split(a).join(b);
};
// ToolStep: sticky row header while open + collapse bar at the bottom
R(
  '<button onClick={() => setOpen(!open)} className="hover:bg-accent/50 text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-[12.5px]">',
  '<button onClick={() => setOpen(!open)} className={cn(\'hover:bg-accent/50 text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left text-[12.5px]\', open && \'bg-card sticky top-0 z-10 border-b\')}>',
);
R(
  '        <div className="bg-background/40 border-t">\n          <ToolDetails it={it} sessionId={sessionId} />\n        </div>',
  '        <div className="bg-background/40">\n          <ToolDetails it={it} sessionId={sessionId} />\n          <CollapseBar onClick={() => setOpen(false)} />\n        </div>',
);
// ToolGroup: sticky summary while open
R(
  '<button onClick={() => setOpen(!open)} className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-left text-[13px]">',
  '<button onClick={() => setOpen(!open)} className={cn(\'text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1.5 text-left text-[13px]\', open && \'bg-background sticky top-0 z-20 w-full py-1\')}>',
);
// single ToolRow (sub-agents): sticky header + collapse bar
R(
  '<button disabled={!expandable} onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default">',
  '<button disabled={!expandable} onClick={() => setOpen(!open)} className={cn(\'flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default\', open && \'bg-card sticky top-0 z-10 rounded-t-lg border-b\')}>',
);
R(
  '      {open && (\n        <div className="border-t">\n          {children && <div className="flex flex-col gap-1.5 p-2 pl-4">{children}</div>}',
  '      {open && (\n        <div>\n          {children && <div className="flex flex-col gap-1.5 p-2 pl-4">{children}</div>}',
);
// add the CollapseBar component before ToolStep
R(
  'function ToolStep({',
  `function CollapseBar({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-muted-foreground hover:text-foreground hover:bg-accent/50 flex w-full cursor-pointer items-center justify-center gap-1 border-t py-1 text-[11px]">
      <ChevronUp className="size-3.5" /> {t('Collapse')}
    </button>
  );
}

function ToolStep({`,
);
s = s.replace(/import \{ Ban, Bot, /, 'import { Ban, Bot, ChevronUp, ');
// minimal "sent as" marker on user messages: icon only, label in the tooltip
R(
  `            <span className="text-muted-foreground inline-flex items-center gap-1 text-[10.5px] opacity-80" title={PRIORITY[it.priority].hint}>
              {(() => {
                const I = PRIORITY[it.priority].icon;
                return <I className="size-3" />;
              })()}
              {PRIORITY[it.priority].label}
            </span>`,
  `            <span className="text-muted-foreground opacity-60" title={\`\${PRIORITY[it.priority].label}: \${PRIORITY[it.priority].hint}\`} aria-label={PRIORITY[it.priority].label}>
              {(() => {
                const I = PRIORITY[it.priority].icon;
                return <I className="size-3" />;
              })()}
            </span>`,
);
// compact queued rows: icon buttons with tooltips
R("<Navigation /> {t('Steer')}\n                  </Button>", "<Navigation />\n                  </Button>");
R("<Zap /> {t('Send now')}\n                  </Button>", "<Zap />\n                  </Button>");
fs.writeFileSync(f, s);
console.log('ok');
