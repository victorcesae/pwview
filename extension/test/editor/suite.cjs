// Runs INSIDE a real VS Code instance (launched by test/editor/run.cjs).
const assert = require('assert');
const vscode = require('vscode');

const ID = 'victorcesae.agentlens';
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (e) {
    results.push(`✖ ${name}: ${e && e.message}`);
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const ext = vscode.extensions.getExtension(ID);
  await check('extension is installed', () => assert.ok(ext));
  await check('activates without errors', async () => {
    await ext.activate();
    assert.ok(ext.isActive);
  });

  const pkg = ext.packageJSON;
  const commands = await vscode.commands.getCommands(true);
  await check('every contributed command is registered', () => {
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !commands.includes(c));
    assert.deepEqual(missing, []);
  });
  await check('titles are localized for this editor language', () => {
    const lang = vscode.env.language;
    const titles = pkg.contributes.commands.map((c) => c.title);
    assert.ok(titles.every((t) => !/^%.*%$/.test(t)), 'no raw %keys% left');
    if (lang.startsWith('pt')) assert.ok(titles.includes('Novo chat'), `pt title expected, got: ${titles.slice(0, 3)}`);
    else assert.ok(titles.includes('New Chat'));
  });

  await check('sessions view opens', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.agentlens');
    await wait(500);
  });
  await check('dashboard panel opens', async () => {
    await vscode.commands.executeCommand('agentlens.dashboard');
    await wait(800);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.some((t) => t.startsWith('AgentLens')), `tabs: ${tabs.join(', ')}`);
  });
  await check('chat panel opens', async () => {
    await vscode.commands.executeCommand('agentlens.newChat');
    await wait(2500);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input?.viewType?.endsWith('agentlens.chat')), `tabs: ${tabs.join(', ')}`);
  });
  await check('check setup runs', async () => {
    await vscode.commands.executeCommand('agentlens.refresh');
  });
  await check('walkthrough opens', async () => {
    await vscode.commands.executeCommand('agentlens.walkthrough');
    await wait(500);
  });

  const failed = results.filter((r) => r.startsWith('✖'));
  console.log(`\n[${vscode.env.language}] AgentLens in VS Code ${vscode.version}\n` + results.join('\n'));
  if (failed.length) throw new Error(`${failed.length} editor check(s) failed`);
}

module.exports = { run };
