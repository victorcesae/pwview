// Lists vscode.l10n.t strings in src/ that have no pt-BR text yet (same rule as the i18n test).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readdirSync(path.join(root, 'src')).map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
const used = [...src.matchAll(/vscode\.l10n\.t\('((?:[^'\\]|\\.)+)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
const pt = JSON.parse(fs.readFileSync(path.join(root, 'l10n', 'bundle.l10n.pt-br.json'), 'utf8'));
for (const s of new Set(used)) if (!pt[s]) console.log(JSON.stringify(s));
