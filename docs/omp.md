# OMP (oh-my-pi)

Tested against a local OMP `18.12.6`. It only reads session files: it never
changes logs, talks to models or starts OMP.

## Directories

- Default: `~/.omp/agent/sessions/<project>/*.jsonl`.
- `PI_CODING_AGENT_DIR` sets the agent directory; `sessions` is appended to it.
- Named profiles are found under `~/.omp/profiles/<name>/agent/sessions`.
  `OMP_PROFILE` and the compatible `PI_PROFILE` are honored; `OMP_PROFILE` wins.
  The profile is passed to Resume so its settings and auth are kept.
- On Linux/macOS an existing `$XDG_DATA_HOME/omp/sessions` is used, and
  `$XDG_DATA_HOME/omp/profiles/<name>/sessions` for a profile. A profile that
  exists only under XDG and not in `~/.omp/profiles` has to be selected with
  `OMP_PROFILE` or pointed at explicitly.
- `WMAD_OMP_SESSIONS_DIR` or `--omp-dir <path>` replaces the automatic list.
  It is the `sessions` root, or a single directory used with `omp --session-dir`.
  The flag wins over the variable. For an explicit directory the profile comes
  from `OMP_PROFILE`/`PI_PROFILE`.

PowerShell example:

```powershell
node 'C:\path to myoffice\bin\cli.js' --omp-dir 'D:\OMP sessions' --no-open
```

Restart the server after changing variables or flags; it can't see variables
set only in another OMP terminal. Remote Redis/SQL stores are not read: a local
JSONL is required.

## Discovery and reading

Directories and modification times are checked every 5 seconds, including old
projects and sessions resumed months later. Activity from the last 24 hours is
shown by default (`--hours` changes the window). Known files are checked every
second. Closing an OMP window without writing an event can't be detected from
the log; the usual UI timeouts apply.

Main sessions are JSONL files directly in the root or one level of project
directories. Nested agents live in the sibling artifact directory
`<session-file-stem>/`, up to 20 levels deep, and appear as subagents of their
parent. A child counts only when its `parentSession` points at the log whose
directory it was found in (compared by real path, so symlinked homes work);
`__advisor*.jsonl` files there are shown as advisors. A regular session with
`parentSession` elsewhere is a separate conversation, not a subagent.
Symlinked directories are not followed. To keep scans cheap, the artifact
directory of a parent that is outside the activity window is only walked if it
gained entries inside the window.

Subagents follow the existing Subagents setting (off by default). They are
labeled with their agent name and have no Resume command, since OMP can't
resume a subagent on its own.

The real ID and cwd come from the `type: "session"` record, not the file name.
A JSONL without that header is not shown. Supported: a leading `type: "title"`
slot, `title_change`, `model_change`, and messages with exactly the roles
`user`, `assistant` and `toolResult`. Helper models (`smol`, `tiny`, …) in
`model_change` don't replace the main model; a reply shows the model it actually
used. Thinking blocks are never shown.

A log up to 32 MiB is replayed whole on discovery, in 128 KiB chunks, so the
model, the last prompt and any open tool call mid-file are kept. Bigger logs
read the first 128 KiB for metadata and the last 768 KiB for the current state,
like the other providers. Only short previews, open tool calls and the
unfinished line stay in memory, not the log. Later appends are read from the
saved position, with UTF-8 and a partial last line carried across polls.
Truncation, file replacement and a change without growth trigger a full
re-read. The current title slot wins over historical title records.

## States and limits

- User prompt → `thinking`.
- `toolCall` in assistant content, or `custom/tool_execution_start` → `tool`.
- An unfinished `ask` call → `waiting`; its result ends the wait.
- A `toolResult` closes only its own `toolCallId`. Other open calls keep
  showing; after the last result → `thinking`.
- A reply with `stopReason: "stop"` or `"length"` → `done` once no tools are
  open. `length` means it hit a limit, not that the reply is complete.
- `stopReason: "error"` → `error`, `"aborted"` → `interrupted`. A tool error
  shows until work continues; one failed call doesn't hide other running tools.
- `custom/session_exit`: fatal → `error`; a signal, abnormal exit, or exit with
  open tools → `interrupted`.

OMP saves finished messages, not every streaming fragment. So the exact start of
generation, waiting on the API, tool permission prompts, and waiting on the user
before an `ask` call is written can't be told apart. Approval events are never
invented, and a question mark in a reply doesn't mean waiting. Third-party
extensions with their own event formats are not recognized. The latest saved
events of the file are shown; OMP's branch tree and extension context are not
rebuilt.

## Resume and UI

OMP is in the filter, legend, cards, 2D/3D office and pop-out, with a neutral
monogram from `assets/agents/omp.svg` rather than an official logo.

The server builds the command for its own platform:

```powershell
omp --profile 'default' --cwd 'C:\project with space\O''Brien' --session-dir 'C:\sessions\project' --resume 'real-id'
```

On Windows it targets PowerShell 5.1/7: single quotes are doubled, and `$()`,
backticks and double quotes inside strings stay literal. POSIX shells get the
matching escaping. If the browser runs on another platform, use the server
platform's shell. `--session-dir` finds a session in a custom store, and
`--cwd` avoids a separate `cd`. Resume never runs by itself and may need the
current OMP process to let go of the session first.

## Tests

`npm run test:watcher` runs the isolated OMP checks plus the existing watcher
tests. `npm run test:ui` checks four providers, icons, filters, Resume copy,
2D/3D, pop-out and narrow screens on synthetic sessions; it needs the dev
dependencies and Google Chrome.

The format was checked against the public 18.12.6 sources:
[sessions](https://github.com/can1357/oh-my-pi/blob/v18.12.6/docs/session.md),
[paths](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/utils/src/dirs.ts),
[entry types](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/session-entries.ts),
[sub-sessions](https://github.com/can1357/oh-my-pi/blob/v18.12.6/packages/coding-agent/src/session/sub-sessions.ts).
