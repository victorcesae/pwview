# AgentLens

**Mission control for AI coding agents, made for developers who read the code.**

Run as many Claude Code sessions as you like, in the terminal as usual. AgentLens shows what each one is
doing, which sub-agents it spawned, and every line it changed, with the real before/after. Comment on a
line and the agent picks it up. Works in VS Code, Cursor, Windsurf and VSCodium, locally or over Remote-SSH
(then it runs on the remote host, so your laptop does no work).

## What you get

- **AgentLens chat:** Claude Code with a real UI instead of a terminal. You get streaming answers, the
  agent's **plan as a live checklist**, what it's doing right now ("Searching…", "Editing page.tsx…"), every
  edit as a diff, permission / plan / question cards with buttons, pasted or dropped screenshots, model and
  permission-mode pickers, slash commands, and **Steer (default) / Queue / Send now** while it works. A queued
  message can still be sent now or cancelled. **Link session** lets the agent see what another session is
  doing, and you can jump to that session.
- **Graph:** sessions → prompts → sub-agents → files, drawn with xyflow. Prompts from different sessions
  that touched the same file are connected, and sessions you linked show a dashed edge.
- **Follows your theme:** colors, fonts and light / dark / high contrast come from your VS Code or Cursor theme.

- **Sessions view:** every session grouped by project (this workspace first), live state
  (working / waiting / idle), branch, edit count, and a sub-agent tree under each session.
- **Real diffs:** click any change to open VS Code's own diff editor with the file exactly as it was
  before and after that edit, plus the agent's reasoning for it.
- **Comments that reach the agent:** click the gutter in a diff (or any file) and choose **Send to Agent**.
  The comment is handed to that session when it finishes its turn, so it keeps working on it. Messages
  work the same way from the dashboard.
- **Linked changes:** files touched by more than one session are flagged, and sessions show which other
  sessions they overlap with, including across sub-agents and worktrees.
- **Dashboard:** an overview of everything that's working, plus a session view with activity timeline,
  changes by file with inline diffs, sub-agents and comments.
- **Prompts:** reusable prompts in `.agentlens/prompts/*.md` (shared with the team) or in your user folder.
  `mode: interactive` opens a session, `mode: headless` runs `claude -p` once. Variables: `${file}`,
  `${selection}`, `${workspace}`, `${input:Question}`.
- **Skills:** browse and create Claude Code skills (`.claude/skills/<name>/SKILL.md`) for the project or
  for yourself.
- **Start / resume:** new session with a prompt, or `claude --resume` any session, in a VS Code terminal.

## Models and accounts

AgentLens doesn't call any model itself. It watches and launches your agent CLI, so whatever Claude Code
is set up with works: a Claude subscription (`/login`), an API key, Amazon Bedrock, Google Vertex, or any
compatible gateway through `ANTHROPIC_BASE_URL`. Pick a model per run with `agentlens.agentArgs`
(e.g. `["--model", "opus"]`) or per prompt with `model:` in its front matter.

## Install, step by step (about 2 minutes)

> Using **Remote-SSH**? Do every step in the **SSH window**. Everything runs on the remote machine.

1. **Install the extension.** In VS Code or Cursor: Extensions view → `⋯` → **Install from VSIX…** →
   pick `agentlens-<version>.vsix`. Over SSH, click **Install in SSH: <host>** when asked.
2. **Reload the window.** `Ctrl+Shift+P` → *Developer: Reload Window*. The **Get started with AgentLens**
   guide opens by itself. You can reopen it any time from `⋯` → *Get Started* in the AgentLens view.
3. **Check Claude Code.** Click **Check setup**. If Claude Code is missing, **Install Claude Code** types the
   official installer into a terminal; press Enter.
4. **Log in once.** Click **Log in**, type `/login` in the terminal and follow the link. Every chat and
   terminal reuses this login, whether it's a subscription, an API key or Bedrock/Vertex. The Claude desktop
   app's login is separate, which is why a terminal can ask even when the app is logged in.
5. **Enable message delivery.** Click **Enable**. This adds four small Claude Code hooks to
   `~/.claude/settings.json` (with a backup) so Queue / Steer / Send now also reach agents running in a plain
   terminal. AgentLens chats don't need them.
6. **Start a chat.** Click **New chat** (or the `💬` button in the Sessions view).

Something not working? Run **AgentLens: Check Setup**. It lists each requirement with a one-click fix.

## Settings

| Setting | Default | |
|---|---|---|
| `agentlens.defaultSurface` | `chat` | open new and resumed sessions in the AgentLens chat or in a terminal |
| `agentlens.days` | 3 | show sessions active in the last N days |
| `agentlens.pollSeconds` | 3 | refresh interval |
| `agentlens.agentCommand` | `claude` | agent CLI to launch |
| `agentlens.agentArgs` | `[]` | extra args for every terminal run, e.g. `["--model", "opus"]` |

## Develop

```bash
npm install
npm run build         # extension + hook (esbuild) and the React/shadcn UI (vite)
npm test              # 22 tests: transcripts, hooks, chat engine, queue/steer/now, links, graph, skills, bundle load
AGENTLENS_E2E=1 npm run test:e2e   # real chat through your Claude Code (Haiku, ~$0.03)
npm run dev:webview   # UI in a browser with mock data (#chat for the chat view)
npm run package       # agentlens-<version>.vsix
```

Data comes only from files Claude Code already writes (`~/.claude/projects`). Comments are stored in
`~/.claude/agentlens/comments.json`. Nothing leaves the machine.
