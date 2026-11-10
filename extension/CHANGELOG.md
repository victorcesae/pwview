# Changelog

## 1.0.17
- Links in the chat and panel open once instead of twice: VS Code no longer opens them as well.
- A subagent's report shows as a "Report from subagent" card named after the agent, and a background task ending as a one-line status, instead of raw <task-notification> text in your own message (or nothing at all, in reopened chats).

## 1.0.16
- Published to the VS Code Marketplace and Open VSX straight from GitHub Actions with trusted publishing: no stored access token, and both registries show which repository and workflow the release came from.

## 1.0.15
- Tab with the Claude subscription no longer fails with "API Error: Claude's response exceeded the 256 output token maximum" after a long wait: a long suggestion is trimmed right away instead.
- Suggestions are shorter, like the editor's own: the rest of the line, or a few lines of the current block (at most 8).

## 1.0.14
- Uses pwview 0.2.1, which caps each project's browser cache at 100 MB (it reached 807 MB in one project).
- Pictures a tool returns (the agent reading a .png, a screenshot) are shown in its output, and enlarge on click, instead of the word [image]. Up to 4 per call.

## 1.0.13
- Jump to latest stays readable on hover: themes with a see-through hover colour (the GitHub themes) made it transparent over the chat.
- The VS Code mark in the chat header is just the blue icon, with no box behind it.

## 1.0.12
- Faster Tab with the Claude subscription: it asks after a 0.25 s pause instead of 0.7 s, with thinking off, and shows the suggestion as soon as its text ends. Most of the remaining wait (about 2 s) is before the model starts answering; a provider like Ollama or OpenRouter answers in well under a second.

## 1.0.11
- **Code completion with your Claude subscription**, through Claude Code, on Haiku. No key or server to set up, but slower than a provider (1 to 3 s after you pause), and each suggestion counts toward your plan limits.
- **Add any file from your own computer** to a chat: Attach files… in the + menu, or Shift+drag it from your file manager. Over Remote-SSH the content is copied to the remote machine (up to 100 MB, kept 7 days) and the prompt gets that path.

## 1.0.10
- Open and Stop Live Browser from the command palette act on the chat in front, not on the workspace's first folder.
- The chat box's hint stays on one line in a narrow chat.
- The VS Code mark instead of the letters VS over Remote-SSH.
- New Chat's pickers keep the keyboard: the Get Started page took it the first time, and closed them.
- **Add files to a chat**: Add to Chat when you right-click a file (Explorer, editor tab, Sessions tree), or Shift+drag it onto the chat. Without Shift, VS Code itself opens the file: extensions can't change that.
- Follow in terminal is a read-only view with no shell, so other extensions can't type into it (the Python extension's `source .venv/bin/activate`).

## 1.0.9
- Messages go as typed: Shift+Enter no longer sends a backslash, and `my_file` or `<div>` are no longer changed.
- Follow in terminal: one terminal per command, named after its chat, and it looks in the chat's own session first.
- **Prompts survive Reload Window and closing VS Code**: chats keep working and reconnect when reopened, also when a permission request was waiting. Closing a chat's tab still stops it. With nobody connected, a chat stops 15 minutes after finishing, or after 24 hours if it is still waiting. Off with `steerhouse.keepChatsRunning`.

## 1.0.8
- **Code completion in the editor**: gray suggestions, Tab to accept, from a model provider you added (Ollama, LM Studio, LiteLLM, OpenRouter, custom). Off by default; turn it on from the Tab item in the status bar. Files like `.env` and private keys are never sent.
- Expanded command lists in a chat are no longer cut off with their title underneath (the "empty black bar").
- Background commands: live output and Follow for commands the agent waits on too, and their result once finished (Claude Code deletes their output file at that moment).

## 1.0.7
- **Much faster start**: only transcripts inside the day window are read at startup, instead of all of them (17 s and 843 MB down to 2.4 s and 276 MB on a 2.1 GB history).
- No more "Webview is disposed" errors after closing a chat.
- **New chats ask which folder**: when the workspace holds several repositories, pick one (last used first), or browse.
- **Browser with no setup**: chats in web projects can drive a shared browser through pwview, downloaded when needed. It starts on the first browser action. **Open Live Browser** shows it in a tab. Off with `steerhouse.pwview.enabled`.
- Background commands: no more phantom "running" commands when the agent merely read text about one.
- **Run a command from the chat box**: start a message with `!` to run it in your shell, in the chat's folder, with live output and Stop. The agent sees the result with your next message; it starts no turn by itself.
- **Tab completion in the chat box**: type @ to find a file, Tab to complete it. Turn it off in the + menu or with `steerhouse.tabCompletion`.
- **Rename any account**, including Default (the id and folder stay, so logins and sessions keep working).
- **Several Cursor accounts**: add one, log in, and pick it for a new chat. Cursor Agent has its own icon.
- **Get Started** is always one click away: a rocket button on the Sessions view, and a row at the top of the tree until Claude Code is set up.

## 1.0.6
- Deleting works over Remote-SSH, WSL and containers: they have no trash, so the confirmation says the delete is permanent. Files in the Sessions tree too.
- **Delete All Chats…** on a project (also older chats not listed); the project folder and its files are not touched.
- The Delete key now deletes what is selected in the Sessions tree, one or many.
- A failed delete no longer reports success.

## 1.0.5
- Background commands are shown in the chat side panel only (removed from the Sessions tree).
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
