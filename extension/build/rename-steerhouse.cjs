// One-off: rename AgentLens to Steerhouse everywhere in the extension (case-preserving), plus the
// repo README and CI workflow. Migration code that must name the old identifiers is added after.
const fs = require('fs');
const path = require('path');
const ext = path.join(__dirname, '..');
const repo = path.join(ext, '..');
const skipDirs = new Set(['node_modules', 'dist', '.vscode-test', '.git']);
const exts = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.mts', '.json', '.md', '.html', '.css', '.yml', '.yaml', '.svg', '.txt']);
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skipDirs.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (exts.has(path.extname(e.name)) && e.name !== 'rename-steerhouse.cjs') files.push(p);
  }
};
walk(ext);
files.push(path.join(repo, 'README.md'), path.join(repo, '.github', 'workflows', 'extension.yml'));
const map = [
  [/AgentLens/g, 'Steerhouse'],
  [/AGENTLENS/g, 'STEERHOUSE'],
  [/Agentlens/g, 'Steerhouse'],
  [/agentlens/g, 'steerhouse'],
];
let changed = 0;
let count = 0;
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  let s = before;
  for (const [re, to] of map) s = s.replace(re, (m) => (count++, to));
  if (s !== before) (fs.writeFileSync(f, s), changed++);
}
// file names containing the old name
for (const f of files) {
  const b = path.basename(f);
  if (/agentlens/i.test(b)) fs.renameSync(f, path.join(path.dirname(f), b.replace(/agentlens/gi, 'steerhouse')));
}
console.log(`replaced ${count} occurrences in ${changed} files`);
