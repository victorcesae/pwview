// One-off codemod: the dashboard overview carries a usage report for a chosen range.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
R('src/panel.ts', '    private onMessage: (m: FromWebview) => void,\n  ) {}', '    private onMessage: (m: FromWebview) => void,\n    private usageFor: (days: number) => UsageReport,\n  ) {}\n\n  private usageDays = 7;\n\n  showUsage(days: number) {\n    this.usageDays = days;\n    this.post();\n  }');
R('src/panel.ts', "import { loadLinks } from './links';", "import { loadLinks } from './links';\nimport type { UsageReport } from './usage';");
R('src/panel.ts', "hooks: this.hooksOk(), graph: buildGraph(sessions, loadLinks()) } },", "hooks: this.hooksOk(), graph: buildGraph(sessions, loadLinks()), usage: this.usageFor(this.usageDays) } },");
R('src/extension.ts', "  const dashboard = new Dashboard(ctx, () => sessions, hooksOk, () => attachedSessions(), (m) => onWebview(m));", "  const dashboard = new Dashboard(ctx, () => sessions, hooksOk, () => attachedSessions(), (m) => onWebview(m), (days) => usageReport(engine.scan(Math.max(days, cfg().get<number>('days', 3))), days));");
R('src/extension.ts', "import { Chats } from './chatPanel';", "import { Chats } from './chatPanel';\nimport { usageReport } from './usage';");
R('webview/src/types.ts', 'hooks: boolean; graph?: GraphData } }', 'hooks: boolean; graph?: GraphData; usage?: UsageReport } }');
fs.appendFileSync(
  'webview/src/types.ts',
  `
// ---- usage (mirrors src/usage.ts)
export type UsageBucket = { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number; unpriced: number };
export interface UsageReport {
  days: number;
  totals: UsageBucket;
  byModel: (UsageBucket & { model: string; label: string })[];
  byDay: { day: string; cost: number; tokens: number; byModel: Record<string, number> }[];
  byProject: (UsageBucket & { project: string })[];
  topSessions: (UsageBucket & { id: string; title: string; project: string })[];
}
`,
);
console.log('ok');
