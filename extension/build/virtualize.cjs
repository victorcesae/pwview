// One-off codemod: virtualize the chat transcript (only rows near the viewport are mounted).
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

R(
  `  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: 'end' });
  }, [chat.items, chat.activity]);`,
  `  // Long chats: only rows near the viewport are in the DOM; heights are measured as they render.
  const rows = useMemo(() => groupTools(top), [top]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 72,
    overscan: 6,
    getItemKey: (i) => {
      const g = rows[i];
      return Array.isArray(g) ? 'g:' + g[0].id : g.id;
    },
  });

  // follow new output while you're at the bottom
  const lastText = chat.items.at(-1)?.kind === 'assistant' ? (chat.items.at(-1) as { text: string }).text.length : 0;
  useEffect(() => {
    if (!stick.current) return;
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [rows.length, lastText, chat.activity, chat.queue.length]);`,
);

R(
  `          {groupTools(top).map((g) =>
            Array.isArray(g) ? (
              <ToolGroup key={g[0].id} items={g} sessionId={chat.sessionId} />
            ) : (
              <Item key={g.id} it={g} sessionId={chat.sessionId}>
                {g.kind === 'tool' && byParent.get(g.id)?.map((c) => <Item key={c.id} it={c} sessionId={chat.sessionId} />)}
              </Item>
            ),
          )}`,
  `          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const g = rows[v.index];
              return (
                <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute top-0 left-0 w-full pb-3" style={{ transform: \`translateY(\${v.start}px)\` }}>
                  {Array.isArray(g) ? (
                    <ToolGroup items={g} sessionId={chat.sessionId} />
                  ) : (
                    <Item it={g} sessionId={chat.sessionId}>
                      {g.kind === 'tool' && byParent.get(g.id)?.map((c) => <Item key={c.id} it={c} sessionId={chat.sessionId} />)}
                    </Item>
                  )}
                </div>
              );
            })}
          </div>`,
);
R('        <div className="mx-auto flex max-w-[860px] flex-col gap-3 px-4 py-4">', '        <div className="mx-auto flex max-w-[860px] flex-col gap-1 px-4 py-4">');
R(
  `              stick.current = true;
              setAtBottom(true);
              end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });`,
  `              stick.current = true;
              setAtBottom(true);
              virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
              requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end' }));`,
);
R("import { useEffect, useMemo, useRef, useState } from 'react';", "import { useVirtualizer } from '@tanstack/react-virtual';\nimport { useEffect, useMemo, useRef, useState } from 'react';");
fs.writeFileSync(f, s);
console.log('ok');
