// One-off: move tool summary out of Chat.tsx, local-date usage buckets, test + translation updates.
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
  const b = s.indexOf(to, a + 1);
  if (a < 0 || b < 0) {
    console.error('MISSING cut ' + f + ': ' + from.slice(0, 50));
    process.exit(1);
  }
  fs.writeFileSync(f, s.slice(0, a) + s.slice(b));
};

// 1) Chat.tsx uses toolSummary.ts
const C = 'webview/src/views/Chat.tsx';
cut(C, '// ---------------------------------------------------------------- grouped tool calls', 'function StepLabel(');
cut(C, '/** Consecutive plain tool calls become one group;', '/** A message waiting to be handed over');
R(C, "import { Composer, PRIORITY } from './Composer';", "import { Composer, PRIORITY } from './Composer';\nimport { fileOf, groupTools, inp, KIND, stat, summarizeTools, type ToolItem } from './toolSummary';");
R('test/chat-ui.test.cjs', "webview/src/views/Chat.tsx", 'webview/src/views/toolSummary.ts');

// 2) usage buckets by the user's local date
const U = 'src/usage.ts';
R(U, 'const rowsOf = ', "/** Local calendar day (YYYY-MM-DD), so 'today' matches the user's clock, not UTC. */\nexport const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;\n\nconst rowsOf = ");
R(U, '  for (let i = days - 1; i >= 0; i--) byDay.set(new Date(now - i * 86_400_000).toISOString().slice(0, 10), { cost: 0, tokens: 0, byModel: {} });', '  for (let i = days - 1; i >= 0; i--) byDay.set(localDay(new Date(now - i * 86_400_000)), { cost: 0, tokens: 0, byModel: {} });');
R(U, '      const d = byDay.get(r.ts.slice(0, 10));', '      const d = byDay.get(localDay(new Date(r.ts)));');

// 3) i18n test: Steer / Queue / Send now stay in English by design
R('test/i18n-accounts.test.cjs', "  assert.equal(t('Send now'), 'Enviar agora');", "  assert.equal(t('Send now'), 'Send now', 'developer terms stay in English');\n  assert.equal(t('Steer'), 'Steer');\n  assert.equal(t('Jump to latest'), 'Ir para o fim');");

// 4) runtime translations for the provider flow
const B = 'l10n/bundle.l10n.pt-br.json';
const b = JSON.parse(fs.readFileSync(B, 'utf8'));
Object.assign(b, {
  'Which models do you want to use?': 'Quais modelos você quer usar?',
  'Endpoint (Anthropic-compatible)': 'Endpoint (compatível com Anthropic)',
  'API key for {0} (stored in VS Code secure storage)': 'Chave de API para {0} (guardada no armazenamento seguro do VS Code)',
  'Could not list models from {0}: {1}. Type the model name instead.': 'Não foi possível listar os modelos de {0}: {1}. Digite o nome do modelo.',
  'Model to use': 'Modelo a usar',
  'Model name': 'Nome do modelo',
  'Name for this provider': 'Nome para este provedor',
  'Start a chat with it': 'Iniciar um chat com ele',
  'Provider "{0}" added.': 'Provedor "{0}" adicionado.',
  'Add model provider (Ollama, OpenRouter, LiteLLM…)': 'Adicionar provedor de modelos (Ollama, OpenRouter, LiteLLM…)',
});
fs.writeFileSync(B, JSON.stringify(b, null, 2) + '\n');

// 5) manifest strings for the new command + setting
R(
  'build/nls.cjs',
  "  'Claude Accounts…': 'Contas Claude…',",
  "  'Claude Accounts…': 'Contas Claude…',\n  'Add Model Provider (Ollama, OpenRouter, LiteLLM…)…': 'Adicionar provedor de modelos (Ollama, OpenRouter, LiteLLM…)…',\n  'Hide sessions that ran inside the system temp folder (scratch runs, automated tests).': 'Ocultar sessões que rodaram na pasta temporária do sistema (testes e execuções descartáveis).',",
);
console.log('ok');
