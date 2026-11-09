// One-off: move user-facing manifest strings into package.nls.json (English) and
// package.nls.pt-br.json (Portuguese). Re-runnable: keys already in %key% form are kept.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const en = fs.existsSync(path.join(root, 'package.nls.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')) : {};

const PT = {
  'AgentLens': 'AgentLens',
  'Sessions': 'Sessões',
  'Prompts': 'Prompts',
  'Skills': 'Skills',
  'Refresh': 'Atualizar',
  'Open Dashboard': 'Abrir painel',
  'Open Session': 'Abrir sessão',
  'Open Change Diff': 'Abrir diff da alteração',
  'Open in Chat': 'Abrir no chat',
  'New Agent Session…': 'Nova sessão de agente…',
  'Send Message to Agent…': 'Enviar mensagem ao agente…',
  'Enable Comment Delivery (install Claude Code hooks)': 'Ativar entrega de mensagens (instalar hooks do Claude Code)',
  'Send to Agent': 'Enviar ao agente',
  'New Prompt…': 'Novo prompt…',
  'Run Prompt': 'Executar prompt',
  'New Skill…': 'Nova skill…',
  'Open': 'Abrir',
  'Add Starter Prompts': 'Adicionar prompts iniciais',
  'Add Skill (npx skills)…': 'Adicionar skill (npx skills)…',
  'Find Skills on skills.sh…': 'Buscar skills no skills.sh…',
  'Update Skills': 'Atualizar skills',
  'Refresh Skills': 'Atualizar lista de skills',
  'Enable for More Agents…': 'Ativar para mais agentes…',
  'Remove Skill': 'Remover skill',
  'Paste Image for the Agent': 'Colar imagem para o agente',
  'Save as Prompt': 'Salvar como prompt',
  'Steer Agent…': 'Direcionar agente…',
  'Queue Message…': 'Enfileirar mensagem…',
  'Send Now (interrupt)…': 'Enviar agora (interromper)…',
  'Queue': 'Enfileirar',
  'Send Now': 'Enviar agora',
  'New Chat': 'Novo chat',
  'Resume in Terminal': 'Retomar no terminal',
  'Link Another Session…': 'Vincular outra sessão…',
  'Check Setup': 'Verificar configuração',
  'Install Claude Code': 'Instalar Claude Code',
  'Log in to Claude Code': 'Entrar no Claude Code',
  'Get Started (step by step)': 'Primeiros passos (passo a passo)',
  'Add Claude Account…': 'Adicionar conta Claude…',
  'Claude Accounts…': 'Contas Claude…',
  'Add Model Provider (Ollama, OpenRouter, LiteLLM…)…': 'Adicionar provedor de modelos (Ollama, OpenRouter, LiteLLM…)…',
  'Manage Connectors (MCP)': 'Gerenciar conectores (MCP)',
  'Hide sessions that ran inside the system temp folder (scratch runs, automated tests).': 'Ocultar sessões que rodaram na pasta temporária do sistema (testes e execuções descartáveis).',
  'Show sessions active in the last N days.': 'Mostrar sessões ativas nos últimos N dias.',
  'How often to look for session updates.': 'Com que frequência verificar atualizações das sessões.',
  'Agent CLI used to start, resume and run prompts.': 'CLI do agente usada para iniciar, retomar e executar prompts.',
  'Extra arguments for every agent run, e.g. ["--model", "opus"].': 'Argumentos extras para cada execução do agente, ex.: ["--model", "opus"].',
  'Where new and resumed sessions open: the AgentLens chat, or a terminal running the agent CLI.': 'Onde sessões novas e retomadas abrem: no chat do AgentLens ou em um terminal com a CLI do agente.',
  'See every AI coding agent session, sub-agent and change. Review real diffs, comment on lines and the agent picks it up, run prompts and skills, without leaving your editor.':
    'Veja cada sessão de agente de IA, sub-agente e alteração. Revise diffs reais, comente linhas e o agente recebe, rode prompts e skills, sem sair do editor.',
  'Get started with AgentLens': 'Primeiros passos com o AgentLens',
  'Two minutes: Claude Code, login, message delivery, your first chat.': 'Dois minutos: Claude Code, login, entrega de mensagens e seu primeiro chat.',
  'Check Claude Code': 'Verificar o Claude Code',
  'AgentLens drives your own Claude Code and its login.\n[Check setup](command:agentlens.doctor)\n[Install Claude Code](command:agentlens.installClaude)':
    'O AgentLens usa o seu próprio Claude Code e o login dele.\n[Verificar configuração](command:agentlens.doctor)\n[Instalar Claude Code](command:agentlens.installClaude)',
  'Log in once': 'Faça login uma vez',
  'One login is reused by every chat and terminal.\n[Log in](command:agentlens.login)': 'Um único login vale para todos os chats e terminais.\n[Entrar](command:agentlens.login)',
  'Enable messages to terminal agents': 'Ativar mensagens para agentes no terminal',
  'Queue / Steer / Send now for sessions running in a terminal.\n[Enable](command:agentlens.installHooks)': 'Enfileirar / Direcionar / Enviar agora para sessões rodando em um terminal.\n[Ativar](command:agentlens.installHooks)',
  'Start your first chat': 'Comece seu primeiro chat',
  'Claude Code with a real UI: plan, live status, diffs, images.\n[New chat](command:agentlens.newChat)': 'Claude Code com uma interface de verdade: plano, status ao vivo, diffs e imagens.\n[Novo chat](command:agentlens.newChat)',
  'See every session, diff and link': 'Veja cada sessão, diff e vínculo',
  'Sessions, sub-agents, changes and the graph.\n[Open dashboard](command:agentlens.dashboard)': 'Sessões, sub-agentes, alterações e o grafo.\n[Abrir painel](command:agentlens.dashboard)',
  'Skills for every agent': 'Skills para todos os agentes',
  'One skill, visible to Claude Code, Cursor, Codex and more.\n[Add a skill](command:agentlens.skillAdd)': 'Uma skill, visível para Claude Code, Cursor, Codex e outros.\n[Adicionar uma skill](command:agentlens.skillAdd)',
};

const pt = {};
const keyOf = (s) => s.toLowerCase().replace(/\(command:[^)]*\)/g, '').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 60);
function loc(obj, field, prefix) {
  const v = obj[field];
  if (typeof v !== 'string') return;
  if (/^%.*%$/.test(v)) return; // already localized
  const key = `${prefix}.${keyOf(v)}`;
  en[key] = v;
  if (PT[v] === undefined) console.warn('no pt-BR for:', v);
  else pt[key] = PT[v];
  obj[field] = `%${key}%`;
}

const c = p.contributes;
loc(p, 'description', 'ext');
c.viewsContainers.activitybar.forEach((v) => loc(v, 'title', 'container'));
c.views.agentlens.forEach((v) => loc(v, 'name', 'view'));
c.commands.forEach((cmd) => loc(cmd, 'title', 'cmd'));
for (const [, prop] of Object.entries(c.configuration.properties)) loc(prop, 'description', 'setting');
for (const w of c.walkthroughs) {
  loc(w, 'title', 'walk');
  loc(w, 'description', 'walk');
  w.steps.forEach((s) => (loc(s, 'title', 'step'), loc(s, 'description', 'step')));
}
p.l10n = './l10n';
fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'package.nls.json'), JSON.stringify(en, null, 2) + '\n');
const ptPath = path.join(root, 'package.nls.pt-br.json');
const prevPt = fs.existsSync(ptPath) ? JSON.parse(fs.readFileSync(ptPath, 'utf8')) : {};
fs.writeFileSync(ptPath, JSON.stringify({ ...prevPt, ...pt }, null, 2) + '\n');
console.log(`localized ${Object.keys(en).length} manifest strings; pt-BR: ${Object.keys({ ...prevPt, ...pt }).length}`);
