# 👀 whatsmyagentdoing

**A Claude Code / Codex skill: type `/myoffice` and see what every Claude Code, Codex, Gemini CLI, Copilot CLI and OMP (oh-my-pi) agent on your machine is doing — live, in a little office.**

OMP support: [paths, profiles, Resume and limitations](docs/omp.md).

![The 3D office: agents at their desks, off-duty ones wandering around](docs/office-3d.gif)

| Medium (2D) | List |
|---|---|
| ![2D office](docs/office-2d.gif) | ![List view](docs/list.gif) |

<sub>Recorded with `--demo` (a made-up team), so no real sessions are shown.</sub>

## Install

**Easiest: ask your agent.** Paste this into Claude Code or Codex:

> Install the myoffice skill from https://github.com/Charonyuu/whatsmyagentdoing: clone it with `git clone --depth 1` into `~/.claude/skills/myoffice` (for Codex: `~/.codex/skills/myoffice`), check that `node --version` is 18 or newer, then tell me to start a new session and type /myoffice.

Or do it yourself:

```bash
# Claude Code
git clone --depth 1 https://github.com/Charonyuu/whatsmyagentdoing ~/.claude/skills/myoffice

# Codex
git clone --depth 1 https://github.com/Charonyuu/whatsmyagentdoing ~/.codex/skills/myoffice
```

Then type **`/myoffice`** (or just ask *"what are my agents doing?"*). The office opens in your browser. Update later with `git -C ~/.claude/skills/myoffice pull`.

Needs Node.js 18+. Nothing to `npm install` — the repo runs as cloned. Prefer no skill? `node bin/cli.js` from a clone works too.

It opens an isometric **office**. Agents that are working sit at cubicle desks: a thought bubble while thinking, typing with code scrolling on the monitor while a tool runs, standing up and waving when they need you. A handful of recently finished agents stay around off duty and wander: coffee and water in the pantry, the couch and beanbags, the bookshelf, the meeting-room whiteboard, the arcade cabinet, ping-pong and foosball (when two of them are free), the phone booth, or a nap at an empty desk. Everyone else has gone home. The windows follow your local time of day (and in Medium there's an office cat). Hover anyone to see what they're on.

Two looks: **Medium** is a hand-drawn 2D canvas (zero dependencies). **High (3D)** renders the same office with real-time lighting and shadows using [Kenney](https://kenney.nl)'s CC0 *Mini Characters* (with their walk / sit / interact animations) and *Furniture Kit*; drag to rotate, scroll to zoom. The 3D bundle (three.js, ~180 KB gzipped) and models (~1.3 MB, meshopt-compressed) only load when you pick High.

**Scenes (3D):** the office is built in; other scenes are small downloadable packs (Pirate Cove, Café, Space Station and Castle are 100–160 KB each), fetched only when you pick one from the scene buttons, run `--scene pirate`, or ask your agent for it. Packs are data only (a manifest plus Kenney CC0 models) and are checked against a pinned SHA-256 before they're installed into `~/.whatsmyagentdoing/scenes`.

Prefer plain cards? Switch to **List**. Either way, each session updates in real time:

| Status | Meaning |
|---|---|
| 💭 Thinking | reasoning, or reading a tool result |
| ⏳ Running | a tool call is in flight — shows which (`Bash: npm test`, `Edit app.ts`, `github · create_pr`) |
| ✍️ Writing reply | started its answer, turn not finished yet |
| 🟠 Waiting for you | asked you a question / needs approval |
| ✅ Done | turn finished, with the last reply |
| ■ Interrupted / ❗ Error / – Idle | |

The UI speaks English, 繁體中文, 简体中文, 日本語, 한국어, Español, Français, Deutsch and Português. By default it uses the language you write your prompts in (falling back to your browser's); pick one from the 🌐 menu to override.

In list view, sessions are grouped into **Needs you → Working → Finished**, with a live timer for the current turn, a copy button for the resume command (`claude --resume …` / `codex resume …` / `copilot --resume …`), optional browser notifications when an agent finishes, and filters for Claude / Codex / Copilot / subagents. The tab title shows how many agents are working.

**Agent badges:** in both 2D and 3D, transparent official Claude, Codex and Gemini logos identify each agent beside its name, including subagents. The same icons appear in the legend, list cards and filters. Open **Settings → Agent badges** to hide the office markers and legend; your choice is saved. Icons are bundled locally, with initials as a fallback if an image cannot load. See [icon sources and attribution](assets/agents/README.md).

The toolbar keeps the view, 2D/3D and pop-out controls visible. Scene selection, agent filters, display options, notifications and language are grouped under **Settings**.

**Pop out:** browsers with the [Document Picture-in-Picture API](https://developer.chrome.com/docs/web-platform/document-picture-in-picture) can open the office or list in an interactive, always-on-top window. The compact list shows **Needs you** and **Working**. View, quality, scene, filters, language and badge settings stay in sync with the main tab when browser storage is available. Closing the pop-out restores the main view, and only the main tab sends notifications.

When Document PiP isn't available, **Pop out** in office view starts a local, view-only video preview of the 2D or 3D office. Use its video PiP button, or the browser's own video controls/context menu (such as Firefox's), to float it. Stop the preview when finished. No screen-sharing permission is needed and no video is uploaded. Background animation may run at a lower frame rate, depending on browser throttling; this fallback doesn't support list cards or clicking agents.

Works with Claude Code (CLI, desktop, IDE), Codex (CLI, desktop, IDE), Gemini CLI, Copilot CLI and OMP — anything that writes session logs to disk. Copilot CLI sessions are labeled `workspace-<foldername>` so sessions from different project folders are easy to distinguish. (Google Antigravity keeps its conversations in an undocumented binary store and isn't supported yet.)

## Options

```
-p, --port <n>    Port (default 4545; next free one if taken)
--hours <n>       Sessions active in the last n hours (default 24)
--omp-dir <path>  OMP sessions root, or a directory passed to omp --session-dir
--no-open         Don't open the browser
--private         Hide prompts, replies and titles — status only (screen-share safe)
--json            Print one snapshot as JSON and exit
--demo            Show a made-up team instead of your sessions (screenshots, trying it out)
--stop            Stop a running dashboard (or say /myoffice stop)
--update          git pull the latest version and restart (or say /myoffice update)
--scenes          List 3D scenes, installed and downloadable
--scene <id>      Download a scene if needed and open the office in it
```

Running it again while it's up just reopens the tab.

**Updates:** the page shows its version in the corner and an **Update** button when a newer one is out (it checks the `package.json` on this repo's main branch about every half hour; set `WMAD_NO_UPDATE_CHECK=1` to turn that off). The button — or `--update`, or `/myoffice update` — runs `git pull` in the install folder and restarts the dashboard.

## How it works

No hooks, no config, no API keys. Both tools already append every message and tool call to JSONL files as they work:

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl` (+ `subagents/`)
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Date folders record when a chat started; discovery checks all dates and uses log modification times to find recently active chats, including months-old conversations. Inactive log contents are not read.
- Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.jsonl` (project paths from `~/.gemini/projects.json`)
- Copilot CLI: `~/.copilot/session-state/<session>/events.jsonl`
- OMP: `~/.omp/agent/sessions/<project>/*.jsonl`, plus named profiles. Override with `WMAD_OMP_SESSIONS_DIR` or `--omp-dir`. Details: [OMP](docs/omp.md).

`whatsmyagentdoing` tails those files (read-only), turns the latest event into a status, and pushes it to the page over Server-Sent Events. Set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` if yours live elsewhere.

**Privacy:** nothing leaves your machine. The server binds to `127.0.0.1` only and rejects requests that aren't addressed to localhost. No runtime dependencies — read `src/` in five minutes. (`web/office3d.js` is the 3D source; `npm run build` bundles it with three.js into `public/office3d.js`.)

## Limits

- Logs are written per finished block, not per token, so "Writing reply" means a reply block has landed and the turn isn't over — not a live keystroke stream.
- Claude Code doesn't log permission prompts, so a tool waiting on your approval shows as "Running" until you answer (Codex and Gemini CLI do log it, so those show "Waiting for you").
- Gemini CLI writes its thoughts together with the reply, so between your prompt and its first tool call or reply it simply shows "Thinking".
- The log formats aren't public APIs. If an update changes them, statuses may degrade — please open an issue.

## Development checks

`npm run test:watcher` runs isolated filesystem regression checks for session discovery, resumed old chats, the hours window, unreadable paths and large logs. It requires Node.js 18+ and never reads your real agent history.

Browser development checks require Node.js 20+ (the dashboard itself still runs on Node.js 18+). Run `npm install`, then `npm run build` to rebuild the committed 3D bundle. With Google Chrome installed, `npm run test:ui` runs the browser regression checks against a temporary local server and made-up sessions. Use `WMAD_HEADED=1 npm run test:ui` to see the test windows, or set `WMAD_SCREENSHOTS` to an output folder to save screenshots. The checks cover logo rendering, compact views, settings synchronization, notifications, PiP recovery, video-stream cleanup and responsive settings in light and dark themes. They use Chrome; Firefox and Safari's native video controls still need manual testing.

## License

MIT. 3D models in `assets/kenney/` are by [Kenney](https://kenney.nl), released under CC0 (see the license files there).
