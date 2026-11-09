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
    // agents installed on this machine (Cursor Agent, Codex…) bring up a picker: take the first
    await wait(800);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem').then(undefined, () => {});
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
  await check('file search works in a folder outside the workspace (@ completion)', async () => {
    const fsx = require('fs'), pathx = require('path'), osx = require('os');
    const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'steerhouse-at-'));
    fsx.writeFileSync(pathx.join(dir, 'My_File.ts'), '');
    fsx.writeFileSync(pathx.join(dir, 'other.ts'), '');
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(dir), '**/*[mM][yY]_*'), undefined, 8);
    assert.deepStrictEqual(found.map((u) => pathx.basename(u.fsPath)), ['My_File.ts']);
  });
  await check('code completion: a suggestion from the provider is accepted into the file', async () => {
    const fsx = require('fs'), pathx = require('path'), osx = require('os'), http = require('http');
    let asked = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        asked++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: 'return 42;' }], stop_reason: 'end_turn' }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const config = vscode.workspace.getConfiguration('steerhouse.codeCompletion');
    const dir = process.env.CLAUDE_CONFIG_DIR;
    assert.ok(dir, 'tests run with their own config folder');
    fsx.mkdirSync(pathx.join(dir, 'steerhouse'), { recursive: true });
    const provider = { id: 'p-test', name: 'Test', preset: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'm', hasKey: false };
    fsx.writeFileSync(pathx.join(dir, 'steerhouse', 'accounts.json'), JSON.stringify({ accounts: [{ id: 'p-test', name: 'Test', configDir: dir, provider }] }));
    const accept = async (start) => {
      const file = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'steerhouse-tab-')), 'a.js');
      fsx.writeFileSync(file, start);
      const off = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(off);
      const end = off.positionAt(off.getText().length);
      editor.selection = new vscode.Selection(end, end);
      // typing is what asks again: VS Code keeps its answer while the text and cursor stay the same
      await vscode.commands.executeCommand('type', { text: ' ' });
      for (let i = 0; i < 20 && !off.getText().includes('return 42;'); i++) {
        await wait(500);
        await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
      }
      return off;
    };
    try {
      const first = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'steerhouse-tab-')), 'off.js');
      fsx.writeFileSync(first, 'let a =');
      const offDoc = await vscode.workspace.openTextDocument(first);
      const offEditor = await vscode.window.showTextDocument(offDoc);
      offEditor.selection = new vscode.Selection(offDoc.positionAt(7), offDoc.positionAt(7));
      await vscode.commands.executeCommand('type', { text: ' ' });
      await wait(1200);
      assert.strictEqual(asked, 0, 'off by default: nothing is sent');
      await config.update('provider', 'p-test', vscode.ConfigurationTarget.Global);
      await config.update('delayMs', 0, vscode.ConfigurationTarget.Global);
      await config.update('enabled', true, vscode.ConfigurationTarget.Global);
      const results = [];
      for (const start of ['const answer =', 'function f() {\n  ']) {
        const before = asked;
        const d = await accept(start);
        results.push(`${JSON.stringify(start)}: asked ${asked - before}x, accepted ${d.getText().endsWith('return 42;')}, text ${JSON.stringify(d.getText())}`);
      }
      console.log('COMPLETION ' + results.join(' | '));
      assert.ok(results.every((r) => r.includes('accepted true')), results.join(' | '));
    } finally {
      await config.update('enabled', undefined, vscode.ConfigurationTarget.Global);
      await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
      await config.update('delayMs', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => {});
      server.close();
    }
  });
  await check('follow in terminal: a read-only view with no shell', async () => {
    const fsx = require('fs'), pathx = require('path'), osx = require('os');
    const file = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'steerhouse-follow-')), 'x.output');
    fsx.writeFileSync(file, 'hello');
    const before = vscode.window.terminals.length;
    await vscode.commands.executeCommand('steerhouse.followTask', { outputFile: file, description: 'test', chatTitle: 'My chat' });
    await vscode.commands.executeCommand('steerhouse.followTask', { outputFile: file, description: 'test', chatTitle: 'My chat' });
    await wait(500);
    assert.strictEqual(vscode.window.terminals.length, before + 1, 'following twice reuses the terminal');
    const term = vscode.window.terminals.at(-1);
    assert.match(term.name, /My chat/);
    assert.ok(term.creationOptions.pty, 'no shell for other extensions to type into');
    term.dispose();
  });
  await check('add to chat: the command exists and is on the right-click menus', async () => {
    assert.ok(commands.includes('steerhouse.addToChat'));
    const menus = pkg.contributes.menus;
    for (const where of ['explorer/context', 'editor/title/context', 'view/item/context']) assert.ok(menus[where].some((m) => m.command === 'steerhouse.addToChat'), where);
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
