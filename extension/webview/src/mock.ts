// Realistic fake data so the dashboard can be designed in a normal browser (npm run dev:webview).
import type { Change, Data, SessionInfo, TimelineEvent } from './types';

const t = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const P = '/home/victor/intranet-v5';

const sessions: SessionInfo[] = [
  {
    id: 's1', project: P, title: 'Sales module: quotation flow', branch: 'feat/sales-quotes', model: 'claude-opus-5-5', state: 'working',
    started: t(48), updated: t(0.2), edits: 14, tools: 63, pendingComments: 1, linked: ['s2'],
    files: [`${P}/apps/api/src/sales/quote.service.ts`, `${P}/apps/web/app/sales/quotes/page.tsx`, `${P}/packages/db/schema.prisma`],
    lastPrompt: 'Add the approval step before a quote is sent to the client',
    agents: [
      { id: 'a1', description: 'Write e2e tests for quote approval', agentType: 'general-purpose', parentToolUseId: 'x', state: 'working', updated: t(0.3), edits: 3, tools: 18 },
      { id: 'a2', description: 'Research old intranet pricing rules', agentType: 'Explore', parentToolUseId: 'y', state: 'idle', updated: t(30), edits: 0, tools: 22 },
    ],
  },
  {
    id: 's2', project: P, title: 'Prisma: add approval columns', branch: 'feat/sales-quotes', model: 'claude-sonnet-5-5', state: 'recent',
    started: t(70), updated: t(6), edits: 4, tools: 21, pendingComments: 0, linked: ['s1'], files: [`${P}/packages/db/schema.prisma`], agents: [],
    lastPrompt: 'Add approvedBy/approvedAt to Quote and generate the migration',
  },
  {
    id: 's3', project: '/home/victor/pwview', title: 'Playwright tests visibility over SSH', branch: 'main', model: 'claude-opus-5-5', state: 'idle',
    started: t(400), updated: t(180), edits: 33, tools: 120, pendingComments: 0, linked: [], files: [], agents: [],
  },
];

const changes: Change[] = [
  {
    id: 'c1', sessionId: 's1', timestamp: t(20), file: `${P}/apps/api/src/sales/quote.service.ts`, kind: 'edit', added: 9, removed: 2,
    why: 'Quotes above the discount limit must wait for a manager. I gate `send()` on the new approval status and keep the old path for small discounts.',
    hunks: [{ oldStart: 40, oldLines: 6, newStart: 40, newLines: 13, lines: [
      '   async send(id: string) {', '     const quote = await this.repo.get(id);', '-    await this.mailer.sendQuote(quote);', '-    return quote;',
      '+    if (quote.discount > DISCOUNT_LIMIT && quote.status !== "approved") {', '+      await this.repo.update(id, { status: "awaiting_approval" });',
      '+      await this.notify.managers(quote);', '+      return { ...quote, status: "awaiting_approval" };', '+    }', '+    await this.mailer.sendQuote(quote);',
      '+    return quote;', '   }', ' ',
    ] }],
  },
  {
    id: 'c2', sessionId: 's1', agentId: 'a1', timestamp: t(4), file: `${P}/apps/web/e2e/quote-approval.spec.ts`, kind: 'create', added: 42, removed: 0,
    why: 'Covering both paths: small discount goes straight out, large discount waits for approval.', hunks: [],
  },
  {
    id: 'c3', sessionId: 's1', timestamp: t(2), file: `${P}/apps/web/app/sales/quotes/page.tsx`, kind: 'edit', added: 6, removed: 1,
    why: 'Show an "Awaiting approval" badge in the list.',
    hunks: [{ oldStart: 88, oldLines: 3, newStart: 88, newLines: 8, lines: [
      '   <TableCell>{q.client}</TableCell>', '-  <TableCell>{q.status}</TableCell>', '+  <TableCell>', '+    {q.status === "awaiting_approval"',
      '+      ? <Badge variant="warn">Awaiting approval</Badge>', '+      : q.status}', '+  </TableCell>', '   <TableCell>{money(q.total)}</TableCell>',
    ] }],
  },
];

const events: TimelineEvent[] = [
  { ts: t(48), kind: 'prompt', text: 'Add the approval step before a quote is sent to the client. Managers approve anything above the discount limit.' },
  { ts: t(47), kind: 'text', text: "I'll look at how quotes are sent today, then add an approval gate." },
  { ts: t(46), kind: 'tool', tool: 'Grep', text: 'sendQuote  apps/api' },
  { ts: t(45), kind: 'tool', tool: 'Agent', text: 'Research old intranet pricing rules', refId: 'y' },
  { ts: t(30), kind: 'tool', tool: 'WebFetch', text: 'https://github.com/NZero-Labs/intranet', agentId: 'a2' },
  { ts: t(21), kind: 'tool', tool: 'Edit', text: `${P}/apps/api/src/sales/quote.service.ts`, refId: 'c1' },
  { ts: t(20), kind: 'change', text: `${P}/apps/api/src/sales/quote.service.ts`, refId: 'c1' },
  { ts: t(12), kind: 'tool', tool: 'Agent', text: 'Write e2e tests for quote approval', refId: 'x' },
  { ts: t(8), kind: 'tool', tool: 'Bash', text: 'npx playwright test e2e/quote-approval.spec.ts', agentId: 'a1' },
  { ts: t(4), kind: 'change', text: `${P}/apps/web/e2e/quote-approval.spec.ts`, refId: 'c2', agentId: 'a1' },
  { ts: t(2), kind: 'change', text: `${P}/apps/web/app/sales/quotes/page.tsx`, refId: 'c3' },
  { ts: t(1), kind: 'text', text: 'The gate works. Running the full sales suite before I hand it back.' },
  { ts: t(0.3), kind: 'tool', tool: 'Bash', text: 'pnpm test --filter sales', agentId: 'a1' },
];

export const overview: Data = {
  view: 'overview',
  overview: { sessions, hot: [{ file: `${P}/packages/db/schema.prisma`, sessions: ['s1', 's2'], changes: 5, updated: t(6) }], hooks: false },
};

export function session(id: string, focusAgent?: string): Data {
  const info = sessions.find((s) => s.id === id) ?? sessions[0];
  return {
    view: 'session',
    focusAgent,
    session: {
      info,
      events: info.id === 's1' ? events : [],
      changes: info.id === 's1' ? changes : [],
      terminal: info.id === 's1',
      comments: info.id === 's1'
        ? [
            { id: 'k1', sessionId: 's1', file: changes[0].file, line: 42, mode: 'steer', text: 'Use the configured limit from settings, not the constant.', created: t(3), status: 'pending' },
            { id: 'k2', sessionId: 's1', mode: 'queue', text: 'When you finish, also update the API docs for /quotes/:id/send.', created: t(2), status: 'pending' },
            { id: 'k3', sessionId: 's1', mode: 'steer', text: 'Keep the old path for discounts under the limit.', created: t(15), status: 'delivered', deliveredAt: t(14), deliveredVia: 'step' },
            { id: 'k4', sessionId: 's1', mode: 'now', text: 'Stop. Use pnpm, not npm.', created: t(25), status: 'delivered', deliveredAt: t(25), deliveredVia: 'terminal' },
          ]
        : [],
      linkedTitles: { s2: 'Prisma: add approval columns', s1: 'Sales module: quotation flow' },
    },
  };
}

export const chat: Data = {
  view: 'chat',
  linked: [{ id: 's2', title: 'Prisma: add approval columns', state: 'recent', activity: 'Generated migration 20261108_quote_approval' }],
  chat: {
    key: 'k', sessionId: 's1', cwd: P, title: 'Sales module: quotation flow', model: 'claude-opus-5-5',
    models: [{ value: 'default', displayName: 'Default (Opus 5.5)' }, { value: 'sonnet', displayName: 'Sonnet 5.5' }, { value: 'haiku', displayName: 'Haiku 5.5' }],
    permissionMode: 'default', effort: 'high', fastMode: false, ultracode: true, status: 'working', activity: 'Searching for "sendQuote"…', costUsd: 0.42, account: { name: 'Work', email: 'victor@example.com', plan: 'max', organization: 'NZero Labs' }, slashCommands: ['compact', 'review', 'init', 'cost', 'model'], earlier: 0, mcp: [{ name: 'Metricool Social Media', status: 'connected', tools: 9 }, { name: 'Playwright', status: 'disabled', tools: 22 }, { name: 'GitHub', status: 'needs-auth', tools: 0, error: 'Sign in required' }],
    todos: [
      { content: 'Find how quotes are sent today', status: 'completed', activeForm: 'Finding how quotes are sent' },
      { content: 'Add approval gate to QuoteService.send', status: 'completed', activeForm: 'Adding the approval gate' },
      { content: 'Show "Awaiting approval" in the quotes list', status: 'in_progress', activeForm: 'Updating the quotes list' },
      { content: 'Write e2e tests for both paths', status: 'pending', activeForm: 'Writing e2e tests' },
    ],
    queue: [{ id: 'q1', text: 'Use the configured limit, not the constant', images: 0, priority: 'next' }, { id: 'q2', text: 'When you finish, also update the API docs for /quotes/:id/send', images: 0, priority: 'later' }],
    items: [
      { kind: 'user', id: 'u1', text: 'Add the approval step before a quote is sent. Managers approve anything above the discount limit.', images: [], ts: t(10) },
      { kind: 'assistant', id: 'a1', text: "I'll look at how quotes are sent today, then add an approval gate. Here's the plan:\n\n1. Find `sendQuote` callers\n2. Gate `send()` on **approval status**\n3. Update the list UI" },
      { kind: 'tool', id: 'g1', name: 'Grep', summary: 'sendQuote  in apps/api', input: {}, status: 'done', result: 'apps/api/src/sales/quote.service.ts:42' },
      { kind: 'tool', id: 'e1', name: 'Edit', summary: `${P}/apps/api/src/sales/quote.service.ts`, file: `${P}/apps/api/src/sales/quote.service.ts`, input: {}, status: 'done', patch: changes[0].hunks },
      { kind: 'tool', id: 'ag', name: 'Agent', summary: 'Write e2e tests for quote approval', input: {}, status: 'running', elapsed: 42 },
      { kind: 'tool', id: 'ag-b', name: 'Bash', summary: 'npx playwright test e2e/quote-approval.spec.ts', input: {}, status: 'running', parent: 'ag' },
      { kind: 'permission', id: 'p1', tool: 'Bash', summary: 'pnpm prisma migrate dev --name quote_approval', input: {}, canAlways: true, status: 'pending' },
      { kind: 'system', id: 's1x', text: 'Linked "Prisma: add approval columns"' },
    ],
  },
};

const schema = `${P}/packages/db/schema.prisma`;
(overview as Extract<Data, { view: 'overview' }>).overview.graph = {
  nodes: [
    { id: 's:s1', type: 'session', data: { sessionId: 's1', title: 'Sales module: quotation flow', state: 'working', project: P, branch: 'feat/sales-quotes' } },
    { id: 'p:s1:0', type: 'prompt', data: { sessionId: 's1', text: 'Add the approval step before a quote is sent to the client', ts: t(48), index: 1, edits: 9 } },
    { id: 'p:s1:1', type: 'prompt', data: { sessionId: 's1', text: 'Also show an "Awaiting approval" badge in the quotes list', ts: t(5), index: 2, edits: 5 } },
    { id: 'a:s1:a1', type: 'agent', data: { sessionId: 's1', agentId: 'a1', description: 'Write e2e tests for quote approval', state: 'working', edits: 3 } },
    { id: 'a:s1:a2', type: 'agent', data: { sessionId: 's1', agentId: 'a2', description: 'Research old intranet pricing rules', state: 'idle', edits: 0 } },
    { id: 's:s2', type: 'session', data: { sessionId: 's2', title: 'Prisma: add approval columns', state: 'recent', project: P, branch: 'feat/sales-quotes' } },
    { id: 'p:s2:0', type: 'prompt', data: { sessionId: 's2', text: 'Add approvedBy/approvedAt to Quote and generate the migration', ts: t(60), index: 1, edits: 4 } },
    { id: `f:${schema}`, type: 'file', data: { path: schema, sessions: 2, edits: 5 } },
    { id: 's:s3', type: 'session', data: { sessionId: 's3', title: 'Playwright tests visibility over SSH', state: 'idle', project: '/home/victor/pwview', branch: 'main' } },
    { id: 'p:s3:0', type: 'prompt', data: { sessionId: 's3', text: 'Make Playwright tests visible over SSH without using my RAM', ts: t(400), index: 1, edits: 33 } },
  ],
  edges: [
    { id: 'e1', source: 's:s1', target: 'p:s1:0', kind: 'start' },
    { id: 'e2', source: 'p:s1:0', target: 'p:s1:1', kind: 'next' },
    { id: 'e3', source: 'p:s1:0', target: 'a:s1:a2', kind: 'spawned' },
    { id: 'e4', source: 'p:s1:1', target: 'a:s1:a1', kind: 'spawned' },
    { id: 'e5', source: 'p:s1:0', target: `f:${schema}`, kind: 'edited' },
    { id: 'e6', source: 's:s2', target: 'p:s2:0', kind: 'start' },
    { id: 'e7', source: 'p:s2:0', target: `f:${schema}`, kind: 'edited' },
    { id: 'e8', source: 's:s1', target: 's:s2', kind: 'linked', label: 'linked' },
    { id: 'e9', source: 's:s3', target: 'p:s3:0', kind: 'start' },
  ],
};

// sample usage (last 7 days) for the Usage view
{
  const days = [...Array(7)].map((_, i) => new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10));
  const series = [
    [12.4, 3.1], [30.2, 8.4], [8.9, 0.6], [44.1, 12.2], [21.7, 5.3], [3.2, 0], [38.6, 9.9],
  ];
  const b = (cost: number, k: number) => ({ input: 40_000 * k, output: 120_000 * k, cacheWrite: 600_000 * k, cacheRead: 60_000_000 * k, cost, unpriced: 0 });
  (overview as Extract<Data, { view: 'overview' }>).overview.usage = {
    days: 7,
    totals: b(229.6, 12),
    byModel: [{ ...b(181.1, 9), model: 'claude-opus-5-5', label: 'Opus 5.5' }, { ...b(39.5, 2.5), model: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { ...b(9, 0.5), model: 'claude-haiku-5-5', label: 'Haiku 5.5' }],
    byDay: days.map((day, i) => ({ day, cost: series[i][0] + series[i][1], tokens: (series[i][0] + series[i][1]) * 300_000, byModel: { 'Opus 5.5': series[i][0], 'Sonnet 5.5': series[i][1] } })),
    byProject: [{ ...b(171.3, 9), project: P }, { ...b(58.3, 3), project: '/home/victor/pwview' }],
    topSessions: [
      { ...b(96.4, 5), id: 's1', title: 'Sales module: quotation flow', project: P },
      { ...b(58.3, 3), id: 's3', title: 'Playwright tests visibility over SSH', project: '/home/victor/pwview' },
      { ...b(31.7, 2), id: 's2', title: 'Prisma: add approval columns', project: P },
    ],
  };
}

// sample context breakdown (what Claude Code's getContextUsage returns)
(chat as Extract<Data, { view: 'chat' }>).chat.host = 'Cursor';
(chat as Extract<Data, { view: 'chat' }>).chat.context = {
  used: 187_400,
  max: 1_000_000,
  percentage: 18.7,
  detailed: true,
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 3_100, kind: 'used' },
    { id: 'system_tools', name: 'System tools', tokens: 14_800, kind: 'used' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 9_600, kind: 'used' },
    { id: 'memory_files', name: 'Memory files', tokens: 4_200, kind: 'used' },
    { id: 'skills', name: 'Skills', tokens: 2_700, kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 153_000, kind: 'used' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 21_000, kind: 'deferred' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 45_000, kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 746_600, kind: 'free' },
  ],
};

/** #long: a 2,000-message chat to check that only visible rows are rendered. */
export function longChat(): Data {
  const base = (chat as Extract<Data, { view: 'chat' }>).chat;
  const items = [] as typeof base.items;
  for (let i = 0; i < 2000; i++) {
    if (i % 4 === 0) items.push({ kind: 'user', id: `u${i}`, text: `Message ${i}: please continue with step ${i / 4}`, images: [], ts: t(2000 - i) });
    else if (i % 4 === 1) items.push({ kind: 'assistant', id: `a${i}`, text: `Answer ${i}. Here is **what I changed** and why, with some \`code\` and a list:\n\n- one\n- two` });
    else items.push({ kind: 'tool', id: `t${i}`, name: i % 4 === 2 ? 'Read' : 'Edit', summary: `/repo/file${i}.ts`, file: `/repo/file${i}.ts`, input: { file_path: `/repo/file${i}.ts` }, status: 'done', patch: i % 4 === 3 ? changes[0].hunks : undefined });
  }
  return { view: 'chat', linked: [], chat: { ...base, status: 'idle', activity: undefined, queue: [], items, earlier: 1240 } };
}

// plan usage, like Claude's /usage
const limits = {
  available: true, plan: 'max', source: 'claude' as const,
  windows: [
    { id: 'five_hour', label: 'Current session (5h)', pct: 42, resetsAt: new Date(Date.now() + 2.6 * 3_600_000).toISOString() },
    { id: 'seven_day', label: 'Weekly · all models', pct: 23, resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString() },
    { id: 'seven_day_opus', label: 'Weekly · Opus', pct: 61, resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString() },
  ],
  extra: { used: 3.4, limit: 50, currency: 'USD', label: 'Extra usage this month' },
};
(chat as Extract<Data, { view: 'chat' }>).chat.limits = limits;

export const prFiles = [
  { path: 'apps/web/app/sales/quotes/page.tsx', additions: 1, deletions: 1 },
  { path: 'apps/web/lib/api/quotes.ts', additions: 1, deletions: 1 },
  { path: 'apps/web/app/sales/quotes/[id]/page.tsx', additions: 1, deletions: 1 },
];

/** #multi: one prompt that changes three projects (web app, API, shared UI library) and opens PRs. */
export function multiChat(): Data {
  const base = (chat as Extract<Data, { view: 'chat' }>).chat;
  const W = '/home/victor/intranet-v5';
  const A = '/home/victor/api-gateway';
  const U = '/home/victor/shared-ui';
  const hunk = (old: string[], neu: string[], at = 12) => [{ oldStart: at, oldLines: old.length + 1, newStart: at, newLines: neu.length + 1, lines: [' export function handler() {', ...old.map((l) => '-' + l), ...neu.map((l) => '+' + l)] }];
  const edit = (id: string, file: string, old: string[], neu: string[]) => ({ kind: 'tool' as const, id, name: 'Edit', summary: file, file, input: { file_path: file }, status: 'done' as const, patch: hunk(old, neu) });
  const items: typeof base.items = [
    { kind: 'user', id: 'm-u1', text: 'Rename the "status" field of quotes to "approvalStatus" everywhere: the web app, the API gateway and the shared UI badge. Open one PR per repo.', images: [], ts: t(12) },
    { kind: 'assistant', id: 'm-a1', text: "This touches three repos. I'll change the API contract first, then the shared badge, then the web app, and open a PR in each." },
    { kind: 'tool', id: 'm-g1', name: 'Grep', summary: '"status"  in ../api-gateway, ../shared-ui, .', input: {}, status: 'done', result: `${A}/src/quotes/dto.ts:8\n${U}/src/QuoteBadge.tsx:3\n${W}/apps/web/app/sales/quotes/page.tsx:41` },
    edit('m-e1', `${A}/src/quotes/dto.ts`, ['  status: QuoteStatus;'], ['  approvalStatus: QuoteStatus;']),
    edit('m-e2', `${A}/src/quotes/quotes.controller.ts`, ['  return { ...q, status: q.status };'], ['  return { ...q, approvalStatus: q.status };']),
    { kind: 'tool', id: 'm-b1', name: 'Bash', summary: 'cd ../api-gateway && pnpm test quotes', input: { command: 'cd ../api-gateway && pnpm test quotes' }, status: 'done', result: ' ✓ quotes.controller.spec.ts (6 tests) 412ms\n\n Test Files  1 passed (1)' },
    edit('m-e3', `${U}/src/QuoteBadge.tsx`, ['export function QuoteBadge({ status }: Props) {'], ['export function QuoteBadge({ approvalStatus }: Props) {']),
    edit('m-e4', `${U}/src/index.ts`, ["export type { Props as QuoteBadgeProps } from './QuoteBadge';"], ["export type { Props as QuoteBadgeProps } from './QuoteBadge';", "export const QUOTE_BADGE_V = 2;"]),
    edit('m-e5', `${W}/apps/web/app/sales/quotes/page.tsx`, ['        <QuoteBadge status={q.status} />'], ['        <QuoteBadge approvalStatus={q.approvalStatus} />']),
    edit('m-e6', `${W}/apps/web/lib/api/quotes.ts`, ['  status: string;'], ['  approvalStatus: string;']),
    edit('m-e7', `${W}/apps/web/app/sales/quotes/[id]/page.tsx`, ['  const label = labels[quote.status];'], ['  const label = labels[quote.approvalStatus];']),
    { kind: 'tool', id: 'm-b2', name: 'Bash', summary: 'cd ../api-gateway && gh pr create --fill', input: { command: 'cd ../api-gateway && gh pr create --title "Rename quote status to approvalStatus" --fill' }, status: 'done', result: 'https://github.com/nzero-labs/api-gateway/pull/214' },
    { kind: 'tool', id: 'm-b3', name: 'Bash', summary: 'cd ../shared-ui && gh pr create --fill', input: { command: 'cd ../shared-ui && gh pr create --fill' }, status: 'done', result: 'https://github.com/nzero-labs/shared-ui/pull/57' },
    { kind: 'tool', id: 'm-b4', name: 'Bash', summary: 'gh pr create --fill', input: { command: 'gh pr create --fill' }, status: 'done', result: 'https://github.com/NZero-Labs/intranet-v5/pull/1288' },
    { kind: 'assistant', id: 'm-a2', text: 'Done. **7 files in 3 repos** now use `approvalStatus`:\n\n| Repo | Files | PR |\n|---|---|---|\n| api-gateway | 2 | [#214](https://github.com/nzero-labs/api-gateway/pull/214) |\n| shared-ui | 2 | [#57](https://github.com/nzero-labs/shared-ui/pull/57) |\n| intranet-v5 | 3 | [#1288](https://github.com/NZero-Labs/intranet-v5/pull/1288) |\n\nMerge them in that order: the web app needs the new badge and API field.' },
  ];
  // as right after a resume: Claude Code has not reported the model yet
  const prs = {
    'https://github.com/nzero-labs/api-gateway/pull/214': { state: 'merged' as const, title: 'Rename quote status to approvalStatus', tasks: { done: 3, total: 3 }, review: 'approved' as const, checks: [{"workflow":"CI","name":"test","state":"pass" as const,"url":"https://github.com/x/actions/runs/1"}, {"workflow":"CI","name":"lint","state":"pass" as const,"url":"https://github.com/x/actions/runs/1"}] },
    'https://github.com/nzero-labs/shared-ui/pull/57': { state: 'closed' as const, title: 'QuoteBadge: approvalStatus prop' },
    'https://github.com/NZero-Labs/intranet-v5/pull/1288': { state: 'open' as const, title: 'Use approvalStatus in quotes', tasks: { done: 2, total: 5 }, review: 'required' as const, checks: [{"workflow":"CI","name":"unit tests","state":"pass" as const,"url":"https://github.com/x/actions/runs/1"}, {"workflow":"CI","name":"e2e (playwright)","state":"fail" as const,"url":"https://github.com/x/actions/runs/1"}, {"workflow":"CI","name":"build","state":"pending" as const,"url":"https://github.com/x/actions/runs/1"}, {"workflow":"Deploy","name":"preview","state":"skipped" as const,"url":"https://github.com/x/actions/runs/1"}] },
  };
  (items[0] as any).forkAt = 'uuid-before-first';
  const tasks = [
    { id: 'dev1', command: 'pnpm --filter web dev', description: 'Start the web dev server', status: 'running' as const, started: t(6) },
    { id: 'wt1', command: 'pnpm test -- --watch quotes', description: 'Watch the quote tests', status: 'completed' as const, started: t(20), ended: t(12) },
  ];
  return { view: 'chat', linked: [], chat: { ...base, tasks, suggestion: 'Now update the API docs for /quotes/:id', stash: ['Check the e2e tests for approval', 'Draft the release note'], model: undefined, host: 'Visual Studio Code', cwd: W, title: 'Rename quote status across repos', status: 'idle', activity: undefined, queue: [], todos: [], items, limits, prs } };
}
