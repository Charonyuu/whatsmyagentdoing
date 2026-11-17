# Development checks

[Back to README](../README.md)

`npm run test:watcher` runs isolated filesystem regression checks for session discovery, resumed old chats, the hours window, unreadable paths and large logs. It requires Node.js 18+ and never reads your real agent history.

`npm run test:magpie` checks the optional adapter against a local fake Magpie,
including request/turn distinctions, cross-instance deduplication, independent
authentication, Docker port mapping, local interface URLs, privacy and failures.

`npm run test:clients` checks isolated Kimi Code, DSH and Grok histories,
including concurrent tools, approvals, explicit turn endings, metadata
changes, forks, subagents and DSH compressed-log recovery. Compressed checks
need either Node's zstd support or the `zstd` executable.

`npm run test:copilot` checks Copilot CLI parsing and discovery. `npm run test:antigravity` checks Antigravity CLI
parsing, subagents and discovery. `npm run test:hook` checks the optional
approval hook (marker files, settings install and removal, path validation) and the usage counts behind
the Today panel and context bars.

Browser development checks require Node.js 20+ (the dashboard itself still runs on Node.js 18+). Run `npm install`, then `npm run build` to rebuild the committed 3D bundle. With Google Chrome installed, `npm run test:ui` runs the browser regression checks against a temporary local server and made-up sessions. Use `WMAD_HEADED=1 npm run test:ui` to see the test windows, or set `WMAD_SCREENSHOTS` to an output folder to save screenshots. The checks cover logo rendering, compact views, settings synchronization, notifications, PiP recovery, video-stream cleanup and responsive settings in light and dark themes. They use Chrome; Firefox and Safari's native video controls still need manual testing.
