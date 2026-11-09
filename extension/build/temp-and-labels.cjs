// One-off codemod: model label in the tree; hide sessions that ran in the system temp folder.
const fs = require('fs');
const R = (f, a, b) => {
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(a)) {
    console.error('MISSING ' + f + ': ' + a.slice(0, 80));
    process.exit(1);
  }
  fs.writeFileSync(f, s.split(a).join(b));
};
R('src/tree.ts', "this.attached().has(i.id) ? '⌨ terminal' : '', i.branch,", "this.attached().has(i.id) ? '⌨ terminal' : '', i.model ? modelLabel(i.model) : '', i.branch,");
R('src/tree.ts', "import { listAccounts } from './accounts';", "import { listAccounts } from './accounts';\nimport { modelLabel } from './pricing';");

R(
  'src/extension.ts',
  "      sessions = engine.scan(cfg().get<number>('days', 3));",
  "      sessions = engine.scan(cfg().get<number>('days', 3)).filter((s) => !cfg().get<boolean>('hideTempSessions', true) || !isTempProject(s.info.project));",
);
R(
  'src/extension.ts',
  "const SCHEME = 'steerhouse';",
  `const SCHEME = 'steerhouse';

/** Sessions that ran inside the system temp folder (scratch runs, tests) are hidden by default. */
const tempRoots = (() => {
  const os = require('os') as typeof import('os');
  const roots = [os.tmpdir()];
  try {
    roots.push(fs.realpathSync.native(os.tmpdir()));
  } catch {
    /* ignore */
  }
  return [...new Set(roots.map((r) => norm(r)))];
})();
const isTempProject = (p: string) => tempRoots.some((r) => norm(p) === r || norm(p).startsWith(r + '/'));`,
);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.contributes.configuration.properties['steerhouse.hideTempSessions'] = {
  type: 'boolean',
  default: true,
  description: 'Hide sessions that ran inside the system temp folder (scratch runs, automated tests).',
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('ok');
