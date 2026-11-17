# Magpie (optional)

[Back to README](../README.md)

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
