---
name: myoffice
description: Open a live office view of every Claude Code, Codex, Gemini CLI, Antigravity CLI, Copilot CLI, OMP, Kimi Code, DeepSeek Harness and Grok Build agent on this machine — who is thinking, running a tool, writing a reply, waiting for the user, or done. Use when the user types /myoffice, asks what their agents are doing, wants to see all running sessions, or which agent is stuck or finished ("我的 agent 在幹嘛", "show my agents").
---

# myoffice

Start the dashboard. It serves a local page and opens it in the browser.
Run it **in the background** so it keeps running and doesn't block the chat
(this skill's base directory is shown above as "Base directory for this skill"):

```bash
node "<base directory>/bin/cli.js"
```

If it is already running, the same command just reopens the browser tab.

To **update** it — `/myoffice update`, or the user asks to update / upgrade —
run `node "<base directory>/bin/cli.js" --update` (not in the background),
report the version it printed, then start it again as above. The page also
shows the version in the corner and an "Update" button when a new one is out.

To **close** it — `/myoffice stop`, or the user asks to stop / close / shut the
office down — run (not in the background):

```bash
node "<base directory>/bin/cli.js" --stop
```

and say it's stopped.
Then tell the user, in one line, that the office is open at the printed URL.
If the output also says **"Update available: vA → vB"**, tell the user a new
version is out and offer to update it (`/myoffice update`, below).
Requires Node.js 18+; if `node` is missing, say so and stop.

## Scenes (3D)

Besides the built-in office there are downloadable 3D scenes (e.g. a pirate
cove). When the user asks for another scene, a different look, "DLC", or names
one ("海盜船", "pirate"):

1. `node "<base directory>/bin/cli.js" --scenes` — lists every scene, whether
   it's installed, and its download size. Use the ids it prints; don't guess.
2. `node "<base directory>/bin/cli.js" --scene <id>` (in the background) —
   downloads it if needed (checksum-verified, data only) and opens the office
   in that scene. `--scene office` goes back to the office.

Scenes are only downloaded when asked for. `--remove-scene <id>` deletes one.

Options the user may ask for:

- `--private` — hide prompts/replies, show status only (for screen sharing)
- `--hours 4` — only sessions active in the last 4 hours (default 24)
- `--port 5000` — different port (default 4545)
- `--stop` — stop the running dashboard
- `--json` — print a one-off snapshot instead of opening a page. Use this when
  the user asks in chat what their other agents are doing: run
  `node "<base directory>/bin/cli.js" --json --hours 2` and summarize by status.

If the user wants Claude Code permission prompts to show as "Waiting for you"
(Claude Code doesn't log them), offer `node "<base directory>/bin/cli.js" --install-hook`.
It adds one Notification hook to their Claude Code settings; `--uninstall-hook` removes it.
Ask before running it, since it changes their settings.

Everything is read locally from the agents' own session folders (`~/.claude/projects`,
`~/.codex/sessions`, `~/.gemini/tmp`, `~/.gemini/antigravity-cli`, `~/.copilot/session-state`, `~/.omp`, `~/.kimi-code`,
`~/.dsh`, `~/.grok`); the server listens on 127.0.0.1 only and sends nothing anywhere.
