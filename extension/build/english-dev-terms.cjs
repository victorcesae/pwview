// Steer / Queue / Send now are developer terms: keep them in English in every language.
const fs = require('fs');

const ui = 'webview/src/i18n.ts';
let s = fs.readFileSync(ui, 'utf8');
for (const key of ['  Queue: ', '  Steer: ', "  'Send now': "]) {
  s = s
    .split('\n')
    .filter((line) => !line.startsWith(key))
    .join('\n');
}
const swaps = {
  "'Switch to Queue': 'Mudar para Enfileirar'": "'Switch to Queue': 'Mudar para Queue'",
  "'Switch to Steer': 'Mudar para Direcionar'": "'Switch to Steer': 'Mudar para Steer'",
  'Direcionar: entregue quando o agente começar o próximo passo': 'Steer: entregue quando o agente começar o próximo passo',
  'Enfileirar: entregue quando o turno terminar': 'Queue: entregue quando o turno terminar',
  '(Enter direciona, Ctrl+Enter envia agora)': '(Enter = Steer, Ctrl+Enter = Send now)',
  "'Message / steer': 'Mensagem / direcionar'": "'Message / steer': 'Mensagem / steer'",
};
for (const [a, b] of Object.entries(swaps)) s = s.split(a).join(b);
fs.writeFileSync(ui, s);

const nls = 'package.nls.pt-br.json';
const p = JSON.parse(fs.readFileSync(nls, 'utf8'));
for (const k of Object.keys(p)) {
  p[k] = p[k]
    .replace('Direcionar agente…', 'Steer…')
    .replace('Enfileirar mensagem…', 'Queue…')
    .replace('Enviar agora (interromper)…', 'Send now (interromper)…')
    .replace(/^Enfileirar$/, 'Queue')
    .replace(/^Enviar agora$/, 'Send now')
    .replace('Enfileirar / Direcionar / Enviar agora', 'Queue / Steer / Send now');
}
fs.writeFileSync(nls, JSON.stringify(p, null, 2) + '\n');

const left = (s.match(/Enfileir|Direcion/g) ?? []).length + (JSON.stringify(p).match(/Enfileir|Direcion/g) ?? []).length;
console.log('Portuguese words left for steer/queue:', left);
