// Runs INSIDE a real VS Code instance (launched by test/editor/run.cjs).
const assert = require('assert');
const vscode = require('vscode');

const ID = 'victorcesae.steerhouse';
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
    await vscode.commands.executeCommand('workbench.view.extension.steerhouse');
    await wait(500);
  });
  await check('dashboard panel opens', async () => {
    await vscode.commands.executeCommand('steerhouse.dashboard');
    await wait(800);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(tabs.some((t) => t.startsWith('Steerhouse')), `tabs: ${tabs.join(', ')}`);
  });
  await check('chat panel opens', async () => {
    await vscode.commands.executeCommand('steerhouse.newChat');
    await wait(2500);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
    assert.ok(vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input?.viewType?.endsWith('steerhouse.chat')), `tabs: ${tabs.join(', ')}`);
  });
  await check('new chat here opens a chat in that folder', async () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'steerhouse-here-'));
    const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input?.viewType?.endsWith('steerhouse.chat')).length;
    vscode.commands.executeCommand('steerhouse.newChatHere', { kind: 'project', path: dir });
    // one account: no picker; several: pick the first
    await wait(800);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').then(undefined, () => {});
    await wait(2500);
    const after = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input?.viewType?.endsWith('steerhouse.chat')).length;
    assert.strictEqual(after, before + 1);
  });
  await check('open terminal here opens a shell in that folder', async () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'steerhouse-term-'));
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('steerhouse.openTerminalHere', { kind: 'project', path: dir });
    await wait(800);
    assert.strictEqual(vscode.window.terminals.length, before + 1);
    const term = vscode.window.terminals.at(-1);
    const cwd = term.creationOptions.cwd;
    assert.strictEqual(String(cwd?.fsPath ?? cwd).toLowerCase(), dir.toLowerCase());
    term.dispose();
  });
  await check('source control: VS Code Git reports a repo branch and changed files the way Steerhouse reads them', async () => {
    const cp = require('child_process'), fsx = require('fs'), pathx = require('path'), osx = require('os');
    const dir = fsx.realpathSync.native(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'steerhouse-scm-')));
    const g = (c) => cp.execSync('git -c user.name=t -c user.email=t@t -c init.defaultBranch=main ' + c, { cwd: dir });
    g('init -q');
    fsx.writeFileSync(pathx.join(dir, 'a.txt'), 'one');
    g('add .');
    g('commit -qm init');
    fsx.writeFileSync(pathx.join(dir, 'a.txt'), 'two');
    fsx.writeFileSync(pathx.join(dir, 'new.txt'), 'x');
    const ext = vscode.extensions.getExtension('vscode.git');
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    const repo = api.getRepository(vscode.Uri.file(dir)) ?? (await api.openRepository(vscode.Uri.file(dir)));
    assert.ok(repo, 'repository opened');
    await repo.status();
    const s = repo.state;
    assert.strictEqual(s.HEAD?.name, 'main');
    const names = [...s.workingTreeChanges, ...(s.untrackedChanges ?? [])].map((c) => pathx.basename(c.uri.fsPath));
    assert.ok(names.includes('a.txt') && names.includes('new.txt'), names.join(','));
    assert.strictEqual(typeof api.toGitUri, 'function');
    assert.ok(Array.isArray(s.indexChanges) && Array.isArray(s.mergeChanges));
  });
  await check('check setup runs', async () => {
    await vscode.commands.executeCommand('steerhouse.refresh');
  });
  await check('walkthrough opens', async () => {
    await vscode.commands.executeCommand('steerhouse.walkthrough');
    await wait(500);
  });

  const failed = results.filter((r) => r.startsWith('✖'));
  console.log(`\n[${vscode.env.language}] Steerhouse in VS Code ${vscode.version}\n` + results.join('\n'));
  if (failed.length) throw new Error(`${failed.length} editor check(s) failed`);
}

module.exports = { run };
