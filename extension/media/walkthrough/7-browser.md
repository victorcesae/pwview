## Watch the browser

In a web project, every chat can drive a real browser with no setup. The first time the agent uses it, Steerhouse starts it (and downloads Chromium if there is none).

**Open Live Browser** shows it in a tab, next to the chat: every page the agent opens, live. **Stop Live Browser** closes it. Over Remote-SSH it all runs on the remote machine, and nothing needs forwarding.

Turn it off with the `steerhouse.pwview.enabled` setting.
