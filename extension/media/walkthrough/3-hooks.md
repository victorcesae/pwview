## Messages to agents running in a terminal

Steerhouse chats get **Queue / Steer / Send now** natively. For sessions you run in a plain terminal, two small Claude Code hooks deliver your messages:

| Mode | When the agent sees it |
|---|---|
| **Queue** | when its current turn ends |
| **Steer** (default) | at its next step, without stopping |
| **Send now** | immediately (interrupts) |

**Enable** adds the hooks to `~/.claude/settings.json` and keeps a backup next to it.
