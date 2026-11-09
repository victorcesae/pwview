// One-off: wrap the remaining hard-coded English UI strings in t() and add their Portuguese.
const fs = require('fs');
const PT = {
  'Loading sessions…': 'Carregando sessões…',
  Close: 'Fechar',
  'View image': 'Ver imagem',
  'Let this agent see what another session is doing': 'Deixe este agente ver o que outra sessão está fazendo',
  Unlink: 'Desvincular',
  'Send your last message again': 'Enviar sua última mensagem de novo',
  'Remove image': 'Remover imagem',
  Delivery: 'Entrega',
  'Message for this agent. Paste or drop screenshots here too…': 'Mensagem para este agente. Cole ou solte capturas de tela aqui também…',
  'Waiting to be delivered': 'Aguardando entrega',
  'Interrupt and send it now': 'Interromper e enviar agora',
  'The same files were changed by more than one session. Check that the changes fit together.': 'Os mesmos arquivos foram alterados por mais de uma sessão. Confira se as alterações combinam.',
  "Comments can't reach agents yet": 'Os comentários ainda não chegam aos agentes',
  'Install two Claude Code hooks so the comments you leave on changes are handed to the agent.': 'Instale dois hooks do Claude Code para que os comentários que você deixa nas alterações cheguem ao agente.',
  'New file. Open the diff to see it all.': 'Arquivo novo. Abra o diff para ver tudo.',
  'Toggle preview': 'Mostrar/ocultar prévia',
  'Open diff': 'Abrir diff',
  'No file changes in this session yet.': 'Nenhuma alteração de arquivo nesta sessão ainda.',
  'Nothing here yet.': 'Nada aqui ainda.',
  'Save this prompt so you can run it again in one click': 'Salve este prompt para rodá-lo de novo com um clique',
  "This session didn't start any sub-agents.": 'Esta sessão não iniciou sub-agentes.',
  'All sessions': 'Todas as sessões',
  "Let this session's agent see what another session is doing": 'Deixe o agente desta sessão ver o que outra sessão está fazendo',
  'Continue this session in an AgentLens chat': 'Continuar esta sessão em um chat do AgentLens',
  'Changes files that these sessions also changed:': 'Altera arquivos que estas sessões também alteraram:',
  'No agent sessions in the last days.': 'Nenhuma sessão de agente nos últimos dias.',
  'Start one with': 'Comece uma com',
  'New session': 'Nova sessão',
  'or run': 'ou rode',
  'in a terminal.': 'em um terminal.',
};
const files = ['App.tsx', 'components/Lightbox.tsx', 'views/Chat.tsx', 'views/Composer.tsx', 'views/Messages.tsx', 'views/Overview.tsx', 'views/Session.tsx'].map((f) => 'webview/src/' + f);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const q = (s) => `t(${JSON.stringify(s).replace(/^"|"$/g, "'").replace(/\\"/g, '"')})`.replace(/^t\('(.*)'\)$/, (m, inner) => `t('${inner.replace(/'/g, "\\'")}')`);
let n = 0;
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s;
  for (const k of Object.keys(PT)) {
    // attributes: title="…" aria-label="…" placeholder="…"
    s = s.replace(new RegExp(`(title|aria-label|placeholder)="${esc(k)}"`, 'g'), (_, a) => `${a}={${q(k)}}`);
    // JSX text between tags
    s = s.replace(new RegExp(`>(\\s*)${esc(k)}(\\s*)<`, 'g'), (_, a, b) => `>${a}{${q(k)}}${b}<`);
  }
  // the empty-overview sentence has inline markup
  s = s.replace('No agent sessions in the last days. Start one with <b>New session</b> or run <code>claude</code> in a terminal.', "{t('No agent sessions in the last days.')} {t('Start one with')} <b>{t('New session')}</b> {t('or run')} <code>claude</code> {t('in a terminal.')}");
  if (s !== before) {
    if (!/import \{ t \} from '@\/i18n'|import \{[^}]*\bt\b[^}]*\} from '@\/i18n'/.test(s)) s = s.replace(/^((?:\/\/[^\n]*\n)*)/, `$1import { t } from '@/i18n';\n`);
    fs.writeFileSync(f, s);
    n++;
  }
}
// Portuguese table
const I = 'webview/src/i18n.ts';
let i = fs.readFileSync(I, 'utf8');
const add = Object.entries(PT)
  .filter(([k]) => !i.includes(`  ${JSON.stringify(k)}:`) && !i.includes(`  '${k.replace(/'/g, "\\'")}':`) && !new RegExp(`^  ${esc(k)}:`, 'm').test(i))
  .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  .join('\n');
i = i.replace("  Context: 'Contexto',", "  Context: 'Contexto',\n" + add);
fs.writeFileSync(I, i);
console.log('files changed:', n);
