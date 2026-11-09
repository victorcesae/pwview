# pwview

Watch Playwright, and the AI driving it, from your browser. Everything (Claude Code,
Playwright, Chromium) runs on the **host** you SSH into; your laptop only opens a web page.

One binary, Windows + Linux (+ macOS), no runtime besides the Node.js your project already has.

```
your laptop (browser tab)          SSH host (all the RAM / CPU)
───────────────────────            ──────────────────────────────────────────
localhost:6080  live screen  ◄──── noVNC ◄ x11vnc ◄ Xvfb ◄ Chromium (headed)   [Linux, vnc mode]
localhost:9222  each tab     ◄──── Chromium DevTools port (screencast per tab)
localhost:8080  UI mode      ◄──── npx playwright test --ui
                                     ▲
                       Claude Code ──┘  .mcp.json → `pwview mcp` → Playwright MCP --cdp-endpoint
```

> **Using Steerhouse?** You don't need any of the steps below: chats in web projects get the browser
> automatically, and **Open Live Browser** shows it in a VS Code tab. Everything below is for using
> pwview by itself, from a terminal.

## Install (each developer, once)

**Linux / macOS**
```bash
curl -fsSL https://raw.githubusercontent.com/victorcesae/pwview/main/install.sh | sh
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/victorcesae/pwview/main/install.ps1 | iex
```

**With Rust** (any OS): `cargo install --git https://github.com/victorcesae/pwview`

## Add to a project (once, then commit)

```bash
cd intranet-v5
pwview init        # writes pwview.toml, .mcp.json entry, .gitignore lines
git add pwview.toml .mcp.json .gitignore
```

## Daily use (on the SSH host)

```bash
pwview setup            # once: Playwright's Chromium. Linux: `pwview setup --system` adds Xvfb/noVNC
pwview up               # optional: start the shared browser (+ live screen on Linux)
claude                  # Claude drives that browser through the Playwright MCP (started on first use)
pwview status           # what's running + URLs
pwview pages            # every open tab, each with its own DevTools link
pwview ui               # Playwright UI mode: timeline, DOM snapshots, watch mode
pwview report           # last HTML report
pwview run npx playwright test --headed   # headed tests appear on the live screen
pwview down
```

VS Code Remote-SSH forwards the ports automatically. With plain `ssh`, `pwview status` prints
the `ssh -L ...` line to use.

## Modes

| mode | where | what you see |
|------|-------|--------------|
| `vnc` | Linux with Xvfb, x11vnc, websockify, noVNC | the real headed browser, all tabs, live at `http://localhost:6080/vnc.html` |
| `cdp` | anywhere (Windows, Linux without X tools, macOS) | headless browser. Open `chrome://inspect` → Configure → `localhost:9222`, or a link from `pwview pages`, for a live screencast of each tab you can also click and type in |
| `auto` (default) | | `vnc` when possible, otherwise `cdp` |

## Config

`pwview.toml` is committed and shared. Put personal overrides in `pwview.local.toml` (git-ignored).
That matters when several developers share one SSH host, because each one needs different ports
and a different display:

```toml
# pwview.local.toml
[ports]
ui = 8180
report = 9423
cdp = 9322
novnc = 6180
vnc = 5910
[display]
number = 100
```

Everything is bound to `127.0.0.1` and VNC has no password, so reach it **only** through SSH port
forwarding. Never expose these ports publicly.

Runtime files (pids, logs, browser profile, MCP output) live in `.pwview/`.
Logs: `.pwview/logs/<service>.log`.

## Releasing

Push a tag `v*`. `.github/workflows/release.yml` builds Linux (x86_64/aarch64, static musl),
Windows, and macOS (Apple Silicon) binaries and attaches them to the GitHub release that the install
scripts download. The scripts pick the newest `vX.Y.Z` release, so Steerhouse releases (`steerhouse-v*`)
in the same repo don't get in the way. On an Intel Mac, use `cargo install`.

---

## Steerhouse (VS Code extension)

[`extension/`](extension/) contains Steerhouse, the session/changes/comments companion for Claude Code.
It shows every agent session and sub-agent, real before/after diffs, and comments that reach the agent,
plus prompts and skills. See [extension/README.md](extension/README.md).
