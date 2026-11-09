# Changelog

## 1.0.5
- **Source control** under each project and worktree in the Sessions tree (VS Code's own Git): branch, ahead / behind, changed files with their diff, Commit (all changes when nothing is staged), Push, Pull, Sync, Open Source Control.

## 1.0.4
- Code blocks: no more highlighted box behind each line (VS Code's own code background is removed inside blocks); inline code keeps a subtle background.

## 1.0.3
- The readable code blocks from 1.0.2 now really ship: packaging rebuilds first (the 1.0.2 package had the previous chat page).
- Right-click on files and folders in the Sessions tree, like the Explorer: Open to the Side, Reveal in Explorer (every other extension's actions are there), Reveal in File Explorer, Open in Terminal, New File / Folder, Find in Folder, Select for Compare / Compare with Selected, Copy Path / Relative Path, Rename (F2), Delete (to the trash), New Chat Here, New Chat in a Worktree.

## 1.0.2
- Readable code everywhere: code blocks, tool and command output, inline code and background-command output use the normal text colour (not VS Code's dim code colour) and wrap long lines instead of scrolling sideways. Code blocks show their language and a Copy button.

## 1.0.1
- Same as 1.0.0, republished under a new version (Open VSX keeps removed version numbers reserved).

## 1.0.0
- **Background commands**: dev servers, watchers and long test runs the agent started, per session (tree) and per chat (side bar): status, live output, local URLs, Stop, Follow in terminal, Open output.
- **Open Terminal Here** from a chat (header button), a project or a folder in the Sessions tree.
- **Renamed AgentLens to Steerhouse**, with a new icon. Settings (`agentlens.*` → `steerhouse.*`), the data folder and Claude Code hook entries carry over on first start.

## 0.12.0
- Worktree per chat (own branch and folder); Remove worktree.
- PR review: changed files with your GitHub viewed marks; Merge (squash / merge / rebase) after a confirmation.
- Edit an earlier message and run again (optionally undoing file changes); Quote, Copy, Up-arrow recall, prompt stash, suggested next prompt.
- Pin and archive projects; Open on Phone (key-protected page with Steer / Queue / Send now).

## 0.11.0
- Add MCP server (popular or your own; team, project or everywhere), connected to open chats at once.

## 0.10.0
- Chats reopen after Reload Window; agent picker; Accounts in the tree; same-account links; Delete session; notifications.

## 0.9.x
- Live PR status with tasks, CI checks and reviews; New chat here; folders worked in; plan usage ring; side rail; real editor icon; browser choice; Files and Rules in the tree.

## 0.8.0 and earlier
- Chat on the Claude Agent SDK with Steer / Queue / Send now, context view, usage and cost, accounts and model providers, graph, real diffs, comments that reach the agent, prompts and skills.
