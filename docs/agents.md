# How each agent is read

[Back to README](../README.md)

No hooks, no config, no API keys. Every supported agent already writes its messages and tool calls to local files as it works:

- Claude Code: `~/.claude/projects/<project>/<session>.jsonl` (+ `subagents/`)
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Date folders record when a chat started; discovery checks all dates and uses log modification times to find recently active chats, including months-old conversations. Inactive log contents are not read.
- Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.jsonl` (project paths from `~/.gemini/projects.json`)
- Antigravity CLI: `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`, with folders from `history.jsonl` and titles from `annotations/`. Override with `ANTIGRAVITY_HOME`. Subagents appear under their parent; Resume uses `agy --conversation`.
- Copilot CLI: `~/.copilot/session-state/<session>/events.jsonl`
- Kimi Code: `~/.kimi-code/sessions/<project>/<session>/agents/<agent>/wire.jsonl`, with names and folders from `state.json`
- DSH: `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]`; only the latest format in a session folder is read
- Grok Build: `~/.grok/sessions/<project>/<session>/updates.jsonl`, with metadata from `summary.json`
- OMP: `~/.omp/agent/sessions/<project>/*.jsonl`, plus named profiles. Override with `WMAD_OMP_SESSIONS_DIR` or `--omp-dir`. Details: [OMP](omp.md).
- Pi: `~/.pi/agent/sessions/<project>/*.jsonl`. Override with `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR`; Resume uses `pi --session`.
- OpenCode: `~/.local/share/opencode/opencode.db`, sessions and messages from its `session` / `message` / `part` tables. Override with `OPENCODE_DB`.
- Hermes: `%LOCALAPPDATA%\hermes\state.db`, sessions and messages from its `sessions` / `messages` tables. Override with `HERMES_HOME`.

`whatsmyagentdoing` tails those files (read-only), turns the latest event into a status, and pushes it to the page over Server-Sent Events. Set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` if yours live elsewhere.

Kimi Code, DSH and Grok Build use `KIMI_CODE_HOME`, `DSH_HOME` and `GROK_HOME`
respectively to override their home directories. Each native session gets its
own person; Kimi's separate agent wire files and explicitly identified DSH and
Grok subagent sessions use the existing subagent filter. These clients use
locally bundled Magpie icons in the existing badge positions, with initials
as a loading fallback. Resume buttons use `kimi --session`,
`dsh tui --resume` and `grok --resume`, respectively.

OpenCode and Hermes keep every session in one SQLite database instead of a log
file per session, so they are read through Node's built-in `node:sqlite` (22.13
and newer) rather than tailed. A Node without it simply leaves these two agents
out. Both databases are opened read-only, and Resume buttons use
`opencode --session` and `hermes --resume`.

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

## Agent-specific limits

- Logs are written per finished block, not per token, so "Writing reply" means a reply block has landed and the turn isn't over — not a live keystroke stream.
- Claude Code doesn't log permission prompts, so a tool waiting on your approval shows as "Running" until you answer (Codex and Gemini CLI do log it, so those show "Waiting for you"). Run `node bin/cli.js --install-hook` once to add an optional Notification hook to your Claude Code settings: on a permission or question prompt it writes a small marker to `~/.whatsmyagentdoing/waiting`, and the session shows "Waiting for you" until its log moves on. New Claude Code sessions pick it up; `--uninstall-hook` removes it. If you switch Node versions, run `--install-hook` again.
- Gemini CLI writes its thoughts together with the reply, so between your prompt and its first tool call or reply it simply shows "Thinking".
- OpenCode and Hermes keep their sessions in SQLite, which is read through Node's built-in `node:sqlite` (Node.js 22.13 and newer). On an older Node those two agents are skipped — the rest of the dashboard is unaffected — and the CLI prints a line saying so at startup.
- The log formats aren't public APIs. If an update changes them, statuses may degrade — please open an issue.
