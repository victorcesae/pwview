// Real e2e chats write a session into ~/.claude/projects for their temp working folder.
// Remove exactly that folder (and only folders of our own temp test dirs) after the test.
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Claude Code names a project's session folder after its path, with every non-alphanumeric char as '-'. */
const projectDirFor = (cwd) => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

async function removeTestSession(cwd) {
  if (!/agentlens-(e2e|steer)-/.test(path.basename(cwd))) return; // never touch anything else
  await new Promise((r) => setTimeout(r, 1500)); // let the CLI finish writing after close
  fs.rmSync(projectDirFor(cwd), { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
}

module.exports = { removeTestSession, projectDirFor };
