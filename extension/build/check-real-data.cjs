// Read-only sanity check against the real ~/.claude data: history with mid-turn messages, and usage.
// Run: node build/check-real-data.cjs  (after: npx esbuild ... --outdir=$TEMP/al-check)
const os = require('os');
const path = require('path');
const dir = path.join(os.tmpdir(), 'al-check');
const { historyFromTranscript } = require(path.join(dir, 'chat.js'));
const { Engine } = require(path.join(dir, 'engine.js'));
const { usageReport } = require(path.join(dir, 'usage.js'));

const transcript = process.argv[2];
if (transcript) {
  const users = historyFromTranscript(transcript).items.filter((i) => i.kind === 'user');
  console.log(`your messages in history: ${users.length} (sent mid-turn: ${users.filter((u) => u.priority === 'next').length})`);
}
const r = usageReport(new Engine().scan(30), 30);
const M = (n) => (n / 1e6).toFixed(2) + 'M';
console.log(`usage 30d: $${r.totals.cost.toFixed(2)} API-equivalent · input ${M(r.totals.input)} · output ${M(r.totals.output)} · cache write ${M(r.totals.cacheWrite)} · cache read ${M(r.totals.cacheRead)}`);
console.log('by model:', r.byModel.map((m) => `${m.label} $${m.cost.toFixed(2)}`).join(', '));
console.log(`days with usage: ${r.byDay.filter((d) => d.cost > 0).length} · top session: ${r.topSessions[0]?.title.slice(0, 50)} ($${r.topSessions[0]?.cost.toFixed(2)})`);
