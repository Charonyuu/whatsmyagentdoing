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

Works with Claude Code (CLI, desktop, IDE), Codex (CLI, desktop, IDE), Gemini CLI, Copilot CLI,
OMP, Kimi Code, DeepSeek Harness (DSH) and Grok Build through their local session
logs. (Google Antigravity keeps its conversations in an undocumented binary
store and isn't supported yet.)

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
- Kimi Code: `~/.kimi-code/sessions/<project>/<session>/agents/<agent>/wire.jsonl`, with names and folders from `state.json`
- DSH: `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`; only the latest format in a session folder is read
- Grok Build: `~/.grok/sessions/<project>/<session>/updates.jsonl`, with metadata from `summary.json`
- OMP: `~/.omp/agent/sessions/<project>/*.jsonl`, plus named profiles. Override with `WMAD_OMP_SESSIONS_DIR` or `--omp-dir`. Details: [OMP](docs/omp.md).

`whatsmyagentdoing` tails those files (read-only), turns the latest event into a status, and pushes it to the page over Server-Sent Events. Set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` if yours live elsewhere.

Kimi Code, DSH and Grok Build use `KIMI_CODE_HOME`, `DSH_HOME` and `GROK_HOME`
respectively to override their home directories. Each native session gets its
own person; Kimi's separate agent wire files and explicitly identified DSH and
Grok subagent sessions use the existing subagent filter. These clients use
locally bundled Magpie icons in the existing badge positions, with initials
as a loading fallback. Resume buttons use `kimi --session`,
`dsh tui --resume` and `grok --resume`, respectively.

The office legend follows the current sessions and client/subagent filters:
clients appear when present and disappear when no matching sessions remain.

Kimi's `turn.ended` / `agent.turn.ended`, DSH's `turn/end` and Grok's
`turn_completed` drive completed, interrupted and failed states. Individual
model calls, finished tools and background subtasks never mark the main turn
Done. Kimi interaction requests and DSH approval requests show Waiting for you.
Grok's persisted tool Pending state does not prove an approval wait, so it
remains Running. A reply without a terminal turn event eventually becomes
Idle, never Done merely from a timeout.

Kimi and Grok logs are replayed in full on discovery, in bounded read blocks,
then tailed incrementally. Skipping the middle would lose pending tools and
approvals. Incomplete lines and UTF-8 characters wait for the next append.

DSH's compressed logs use Node's built-in zstd decoder after a one-time
concatenated-frame check, otherwise the existing `zstd` executable on PATH.
Nothing is installed automatically. Compressed DSH logs cannot be read without either decoder;
the dashboard warns and other clients continue. DSH replays changed logs
whole, at most every 5 seconds, bounded to 32 MB of decoded data. Kimi Code and Grok Build
logs up to 32 MB are replayed whole on discovery; larger ones are read head + tail. An incomplete compressed write
preserves the last readable snapshot and is retried. Large unsupported logs
are reported rather than truncated into a misleading status.

### Magpie (optional)

To include sessions observed by a local Magpie gateway, set `WMAD_MAGPIE_URL`
to its web management origin (for example, `http://127.0.0.1:3430`) and
`WMAD_MAGPIE_KEY` to its web sign-in key, then start the dashboard normally.
The key is the `k` value in Magpie's sign-in link (or its configured
`MAGPIE_WEB_KEY`), not a model-provider API key. Supply it through your local
environment; do not put it in a command-line argument, saved URL, or repository
file. Loopback origins and IP addresses assigned to this computer (including
its Tailscale interface) are accepted; arbitrary remote hosts are not.
The server uses Magpie's sign-in exchange to obtain the cookie name instead
of guessing it from the URL port. Docker's published port can therefore differ
from Magpie's internal port. No container access or Magpie changes are needed.

For multiple local Magpie instances, set `WMAD_MAGPIE_SOURCES` to a JSON array
of `{"url":"http://127.0.0.1:3430","key":"<web-sign-in-key>"}` objects, one per
instance with its own URL and key. This replaces the single-source variables.
Keep this JSON in your local process environment, not in the repository.
Each instance is polled and authenticated independently; one failed instance
does not stop the others.

The server polls `GET /api/sessions` and `GET /api/gateway/trace` every five
seconds per instance. Each `(agent, session ID)` is one person, even when two
gateways observe it; models, accounts and individual requests never become
extra people. Magpie's session list already combines its native records and
gateway records. Across instances, native metadata takes precedence, with the
newest record breaking ties, while an in-flight request from either healthy
instance means Thinking. Explicit subagent and parent-session metadata is
preserved. A session also found in local logs keeps its native status,
previews and resume command. Magpie only fills missing metadata and parent
relationships; it never overwrites the local tracker.

For gateway-only sessions, an unfinished foreground model request means
**Thinking**. Between requests the state is **Idle**, not **Done**: a request
ending does not prove the agent finished its turn or task. Title, guardian and
compaction helper requests are ignored. Magpie's current web API does not
expose tool execution, approval waits or reliable turn-completion events;
native logs are needed for those states. The transcript API is not polled
because its conversation blocks do not establish those lifecycle events.
Gateway-only sessions do not offer a local resume command. Other clients keep
their own names and get filters in Settings, using the existing office and
list views. Idle visibility and off-duty limits remain unchanged.

`--hours`, `--private` and `--json` also apply to Magpie. Failed polls print a
credential-free warning identifying the source, clear that source's observed
activity and retry; other sources and local logs continue normally. `--json`
waits for one poll from each source and exits with an error if any fails.
The web keys and sign-in cookies stay on the server and are never sent to the
dashboard's browser.

**Privacy:** nothing leaves your machine. The server binds to `127.0.0.1` only and rejects requests that aren't addressed to localhost. No runtime dependencies — read `src/` in five minutes. (`web/office3d.js` is the 3D source; `npm run build` bundles it with three.js into `public/office3d.js`.)

## Limits

- Logs are written per finished block, not per token, so "Writing reply" means a reply block has landed and the turn isn't over — not a live keystroke stream.
- Claude Code doesn't log permission prompts, so a tool waiting on your approval shows as "Running" until you answer (Codex and Gemini CLI do log it, so those show "Waiting for you").
- Gemini CLI writes its thoughts together with the reply, so between your prompt and its first tool call or reply it simply shows "Thinking".
- The log formats aren't public APIs. If an update changes them, statuses may degrade — please open an issue.

## Development checks

`npm run test:watcher` runs isolated filesystem regression checks for session discovery, resumed old chats, the hours window, unreadable paths and large logs. It requires Node.js 18+ and never reads your real agent history.

`npm run test:magpie` checks the optional adapter against a local fake Magpie,
including request/turn distinctions, cross-instance deduplication, independent
authentication, Docker port mapping, local interface URLs, privacy and failures.

`npm run test:clients` checks isolated Kimi Code, DSH and Grok histories,
including concurrent tools, approvals, explicit turn endings, metadata
changes, forks, subagents and DSH compressed-log recovery. Compressed checks
need either Node's zstd support or the `zstd` executable.

Browser development checks require Node.js 20+ (the dashboard itself still runs on Node.js 18+). Run `npm install`, then `npm run build` to rebuild the committed 3D bundle. With Google Chrome installed, `npm run test:ui` runs the browser regression checks against a temporary local server and made-up sessions. Use `WMAD_HEADED=1 npm run test:ui` to see the test windows, or set `WMAD_SCREENSHOTS` to an output folder to save screenshots. The checks cover logo rendering, compact views, settings synchronization, notifications, PiP recovery, video-stream cleanup and responsive settings in light and dark themes. They use Chrome; Firefox and Safari's native video controls still need manual testing.

## License

MIT. 3D models in `assets/kenney/` are by [Kenney](https://kenney.nl), released under CC0 (see the license files there).
