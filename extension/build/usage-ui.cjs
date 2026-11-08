// One-off codemod: Usage tab in the overview, editable queue rows in the chat, Edit in Messages, header tokens.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};

// ---- overview: List | Graph | Usage
const O = 'webview/src/views/Overview.tsx';
R(O, "import { GraphView } from './Graph';", "import { GraphView } from './Graph';\nimport { UsageView } from './Usage';");
R(O, "import type { GraphData, HotFile, SessionInfo } from '@/types';", "import type { GraphData, HotFile, SessionInfo, UsageReport } from '@/types';");
R(O, 'hooks: boolean; graph?: GraphData } }) {', 'hooks: boolean; graph?: GraphData; usage?: UsageReport } }) {');
R(O, "useState<'list' | 'graph'>('list')", "useState<'list' | 'graph' | 'usage'>('list')");
R(O, "{(['list', 'graph'] as const).map((v) => (", "{(['list', 'graph', 'usage'] as const).map((v) => (");
R(O, "{v === 'list' ? t('List') : t('Graph')}", "{v === 'list' ? t('List') : v === 'graph' ? t('Graph') : t('Usage')}");
R(O, "      {view === 'graph' && data.graph && <GraphView graph={data.graph} />}", "      {view === 'graph' && data.graph && <GraphView graph={data.graph} />}\n      {view === 'usage' && data.usage && <UsageView report={data.usage} />}");

// ---- chat header: tokens next to cost
const C = 'webview/src/views/Chat.tsx';
R(
  C,
  '{chat.costUsd > 0 && <span className="text-muted-foreground text-[11px] tabular-nums">${chat.costUsd.toFixed(2)}</span>}',
  [
    '{chat.costUsd > 0 && (',
    "          <span className=\"text-muted-foreground text-[11px] tabular-nums\" title={t('Tokens and API-equivalent cost of this chat')}>",
    "            {chat.tokens ? `${chat.tokens >= 1e6 ? (chat.tokens / 1e6).toFixed(1) + 'M' : (chat.tokens / 1e3).toFixed(1) + 'k'} ${t('tokens')} · ` : ''}${chat.costUsd.toFixed(2)}",
    '          </span>',
    '        )}',
  ].join('\n'),
);

// ---- chat queue rows: replaced by <QueuedRow/>
{
  const a = fs.readFileSync(C, 'utf8');
  const start = a.indexOf('        {chat.queue.length > 0 && (');
  const end = a.indexOf('        <Composer chat={chat} />');
  if (start < 0 || end < 0) {
    console.error('MISSING queue block');
    process.exit(1);
  }
  const block = ['        {chat.queue.length > 0 && (', '          <div className="flex flex-col gap-1">', '            {chat.queue.map((q) => (', '              <QueuedRow key={q.id} q={q} />', '            ))}', '          </div>', '        )}', ''].join('\n');
  fs.writeFileSync(C, a.slice(0, start) + block + a.slice(end));
}
R(C, '// ---------------------------------------------------------------- page', fs.readFileSync(__dirname + '/queued-row.tsx.txt', 'utf8') + '\n// ---------------------------------------------------------------- page');
R(C, 'import { Ban, Bot, ChevronUp, ', 'import { Ban, Bot, ChevronUp, Pencil, ');

// ---- Messages tab (terminal sessions): Edit pending messages
const M = 'webview/src/views/Messages.tsx';
R(M, 'function MessageRow({ c, project }: { c: Comment; project: string }) {', 'function MessageRow({ c, project }: { c: Comment; project: string }) {\n  const [editing, setEditing] = useState(false);\n  const [text, setText] = useState(c.text);');
R(M, '        <div className="text-[13px] whitespace-pre-wrap">{c.text}</div>', fs.readFileSync(__dirname + '/message-edit.tsx.txt', 'utf8').trimEnd());
R(
  M,
  "          {c.status === 'pending' && (\n            <Button size=\"xs\" variant=\"secondary\" onClick={() => post({ type: 'promoteComment', commentId: c.id })}",
  "          {c.status === 'pending' && !editing && (\n            <Button size=\"xs\" variant=\"ghost\" onClick={() => setEditing(true)}>\n              <Pencil /> {t('Edit')}\n            </Button>\n          )}\n          {c.status === 'pending' && (\n            <Button size=\"xs\" variant=\"secondary\" onClick={() => post({ type: 'promoteComment', commentId: c.id })}",
);
R(M, "import { ImagePlus, ListOrdered, Navigation, SquareTerminal, X, Zap } from 'lucide-react';", "import { ImagePlus, ListOrdered, Navigation, Pencil, SquareTerminal, X, Zap } from 'lucide-react';");
if (!fs.readFileSync(M, 'utf8').includes("import { t } from '@/i18n';")) R(M, "import { post } from '@/bridge';", "import { post } from '@/bridge';\nimport { t } from '@/i18n';");
console.log('ok');
