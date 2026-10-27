# OMP (oh-my-pi)

The integration was checked with OMP 18.12.6. It reads local session files without modifying them, calling models, or starting OMP.

## Session locations

- Default: `~/.omp/agent/sessions/<project>/*.jsonl`.
- `PI_CODING_AGENT_DIR` overrides the agent directory; `sessions` is appended.
- Named profiles are discovered in `~/.omp/profiles/<name>/agent/sessions`. `OMP_PROFILE` takes precedence over `PI_PROFILE`; the profile is included in the Resume command.
- On Linux and macOS, an existing `$XDG_DATA_HOME/omp/sessions` is used, or `$XDG_DATA_HOME/omp/profiles/<name>/sessions` for a profile. A profile that exists only in XDG must be selected via `OMP_PROFILE` or an explicit path.
- `WMAD_OMP_SESSIONS_DIR` or `--omp-dir <path>` overrides discovery. Specify the `sessions` root or a direct `omp --session-dir` directory. The flag takes precedence; `OMP_PROFILE`/`PI_PROFILE` selects the profile.

Restart the server after changing its environment or arguments. It cannot see variables set only in another terminal. Remote Redis/SQL storage is not read; local JSONL files are required.

## Discovery and reading

Directories and modification times are scanned every five seconds, including old projects and sessions resumed months later. The default activity window is 24 hours (`--hours` changes it). Known files are checked every second. Closing OMP without writing an exit event cannot be reliably detected from the log; normal inactivity timeouts apply.

Main session JSONL files are discovered in the session root and project directories. Nested agent logs are discovered in adjacent `<session-file-stem>/` directories, up to 20 levels deep. A child log is linked to its parent using its location and `parentSession`; `__advisor*.jsonl` files are recognized by name and location. A regular session with `parentSession` remains a separate conversation, not a subagent.

Subagents are shown in the list and office by default; the Subagents setting can hide them. Existing browser preferences are preserved. Resume commands are not offered for OMP subagents.

The real session ID and cwd come from the `type: "session"` header, not the file name. Arbitrary JSONL files without a valid header are excluded. The parser supports a preceding `type: "title"` slot, `title_change`, `model_change`, and messages with exact roles `user`, `assistant`, and `toolResult`. Auxiliary models such as `smol` and `tiny` do not overwrite the primary model. Thinking block contents are not displayed.

Large logs are initially read in 128 KiB chunks so metadata and pending tool calls are not lost. Memory retains short previews, pending tools, and an incomplete line rather than the entire log. Subsequent writes are tailed. UTF-8 and incomplete lines are preserved across reads. Truncation, replacement, or a same-size modification triggers a reread. The current title slot takes precedence over historical title changes.

## Status and limitations

- A user message becomes `thinking`.
- A `toolCall` or `custom/tool_execution_start` becomes `tool`.
- A pending `ask` becomes `waiting`; its result clears that wait.
- `toolResult` closes only the matching `toolCallId`. Other tools remain active; after the last result the state returns to `thinking`.
- An assistant response with `stopReason: "stop"` or `"length"` becomes `done` when no tools remain. `length` means a limit was reached, not that the response is complete.
- `stopReason: "error"` becomes `error`; `"aborted"` becomes `interrupted`. A tool error is shown until work continues and does not hide other tools.
- `custom/session_exit` marks fatal exits as errors and abnormal exits or exits with unfinished tools as interrupted.

OMP writes completed messages rather than every streamed fragment. The exact start of generation, API waits, permission requests, and user waits before an `ask` is recorded cannot be distinguished from the log. Approval events are not inferred. Third-party extension event formats are not recognized. The display reflects recorded events; full branch and extension context is not reconstructed.

## Resume and interface

OMP appears in the provider filter, legend, cards, 2D/3D office, and pop-out. The OMP monogram in `assets/agents/omp.svg` is neutral and is not an official logo. The server generates a command for its own platform, for example:

```powershell
omp --profile 'default' --cwd 'C:\project folder\O''Brien' --session-dir 'C:\sessions\project' --resume 'real-id'
```

Windows commands target PowerShell 5.1/7. Single quotes are doubled, and shell substitutions and double quotes inside strings remain literal. POSIX commands use their corresponding quoting rules. When viewing from another platform, use the server platform's shell. `--session-dir` supports custom storage, and `--cwd` avoids a separate directory change. Resume is never launched automatically and may require the active OMP process to release the session.

## Verification

`npm run test:watcher` runs isolated OMP and existing watcher tests. `npm run test:ui` exercises all four providers, icons, filters, Resume copying, 2D/3D, pop-out, and narrow screens with synthetic sessions. UI tests require development dependencies and Google Chrome.

The format was checked against the public OMP 18.12.6 sources: [sessions](https://github.com/can1357/oh-my-pi/blob/v18.12.6/docs/session.md), [paths](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/utils/src/dirs.ts), [entry types](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-entries.ts), and [nested sessions](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/sub-sessions.ts).
