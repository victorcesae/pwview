// Launches a clean VS Code (downloaded once into .vscode-test/) with AgentLens loaded from this
// folder, in English and in Portuguese (with the official pt-BR language pack), and runs
// suite.cjs inside it. Run: npm run test:editor
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

// When this runs from inside another Electron app (an editor's terminal), ELECTRON_RUN_AS_NODE is
// inherited and VS Code would start as plain Node. Clear it so it starts as the editor.
delete process.env.ELECTRON_RUN_AS_NODE;

const LOCALES = { en: null, 'pt-br': 'MS-CEINTL.vscode-language-pack-pt-BR' };

async function main() {
  const extensionDevelopmentPath = path.join(__dirname, '..', '..');
  const extensionTestsPath = path.join(__dirname, 'suite.cjs');
  const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-editor-ws-'));
  for (const [locale, pack] of Object.entries(LOCALES)) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), `agentlens-editor-${locale}-`));
    const extDir = path.join(extensionDevelopmentPath, '.vscode-test', `extensions-${locale}`);
    if (pack) {
      const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
      cp.spawnSync(cli, [...args, '--extensions-dir', extDir, '--install-extension', pack], { encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' });
    }
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--locale', locale, '--user-data-dir', userData, '--extensions-dir', extDir, '--disable-workspace-trust', '--skip-welcome'],
    });
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
