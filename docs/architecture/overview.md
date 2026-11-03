# Architecture and compatibility

Tracked by YA-8. The package remains one Node TypeScript application with no runtime dependencies. The root
`client.ts`, `identity.ts` and `yt.ts` entry points remain.

## Boundaries

| Module | Responsibility |
|---|---|
| `src/config.ts`, `src/identity.ts` | Resolve configuration and identity at invocation time without changing process environment |
| `src/cli/` | Parse arguments, read files/stdin, invoke operations and render output; `run()` returns an exit code |
| `src/workflow/` | Create, take, handoff and finish policy against a typed tracker port |
| `src/tracker.ts` | Normalized issues, supported capabilities, classified failures and partial workflow results |
| `src/youtrack/adapter.ts` | Translate the workflow port to YouTrack fields, users and sprint placement |
| `src/youtrack/` | Provider client, field mapping, administration, pagination and bounded HTTP transport |
| `src/accounting/` | Actual-input validation and capability checks before provider writes |

Workflow code accepts a `TrackerPort`, not an HTTP client. Provider-specific queries, commands and
administration stay explicit in the client and CLI; this is not a generic tracker query language. YA-7's
broader connector choice remains separate. The port is a test seam, not a sandbox or authorization boundary.

## Changes callers must account for

- `create` requires Subsystem, Recommended model and Role. Its default state is Submitted, with no sprint
  placement. Repeated `--set` values are retained. Canonical workflow fields cannot be overridden through
  the extra-field escape hatch.
- `handoff --file` reads the file contents. Boolean flags do not consume positional arguments; unknown,
  missing-value and repeated scalar options are rejected. `--` ends option parsing.
- `state ... Fixed` assigns the configured owner and the Owner verifies role, even without a checklist.
  Without `--check`, human-readable mode first prints a reminder on stderr; `--quiet` and `--json` do not.
  Fixed means handoff for verification; it does not imply merge, deployment or owner acceptance.
- `state` and `handoff --state` into any state other than Submitted now place the issue on the current sprint
  of every sprint-running board, as `take` and `create --state` do. The old `state` never placed issues. Closed
  states (Verified, Won't fix, Duplicate, Obsolete and the rest) are placed too; the owner chose that (YA-25 B5).
- Between sprints (a sprint-running board with no active current sprint), `take`, `state`, `handoff --state`
  and `create --state` still apply their changes and report `partial` with `place in <board>: no current sprint`
  pending. Nothing needs reconciling; do not re-run the command. Place the issue with `sprint add` once the owner
  opens a sprint. A board whose sprint lookup fails still rejects the command before any write.
- `create`, `take`, `handoff` and `state` with `--json` return a version 1 envelope. The normalized issue is
  under `issue`, with `key` and `workflow` fields. Consumers expecting a raw issue object must update.
  `issueSnapshot` says which issue that is: `after` when it came back from the confirmed create or update,
  `before` when it was read before any write (so it does not show this command's changes, as after an `unknown`
  update), and absent with no issue. Read and native commands keep their provider-shaped output.
- Workflow text output is now the issue line plus the workflow status and its steps. `create` also prints the
  issue URL, and `take` prints the assignee and the sprints it placed the issue on once its update is confirmed.
  Fields are no longer printed.
- `take` refuses an issue whose Role is not one of the canonical values, as it refuses an Owner role, since it
  may be waiting on a person. `--force` takes it and leaves that Role unchanged.
- Completed workflows exit 0. Rejected, partial and unknown workflows exit 1. A nonzero exit does not mean
  nothing happened. Inspect `applied`, `pending` and `uncertain` before deciding how to continue.
- Validation/startup exceptions with `--json` return `{version: 1, status, error}`; they do not necessarily
  have workflow step arrays. Human-readable errors go to stderr.
- A native or admin command that fails is classified by the writes it sent, not by the error's type. In order:
  a failed display refresh after a confirmed write is `partial`; a multi-step admin command (`field add`,
  `subsystems add`, `sprint backlog`) is `unknown` when its failing step sent a write the provider did not refuse,
  `partial` when earlier steps were applied, and `rejected` otherwise; any other failure is `unknown` when the
  error is an unknown outcome or some write got no answer, `partial` when some write was confirmed, and
  `rejected` when nothing was sent or every write was refused. Every admin write needs an id in its reply, so an empty 2xx is
  uncertain, and `sprint backlog` counts its attach as applied only when the read-back shows it. A write whose
  receipt fails its check is counted as unanswered, never as confirmed. The envelope then adds `message`, such as `1 write(s) confirmed, 1 write(s)
  without a confirmed outcome before failure; reconcile before retrying`, and multi-step admin commands add
  `applied`, `pending` and `uncertain` step arrays. In text mode these go to stderr after the error.
- Configuration: `YOUTRACK_URL` must be `https:`, or `http:` only to `localhost`, `127.0.0.1` or `::1`, and the
  transport repeats that check and the token check for configs that did not come from `loadConfig`. The URL goes
  with the token: an env file supplies the URL, project, owner and team group only when it holds the token in use.
  Beneath a different token from the environment or a `loadConfig` option, the first env file adds nothing, not
  even boards or identity, and a URL missing from the environment is an error that names the file, so an
  `.env.youtrack` planted in an ancestor directory cannot redirect an exported token, choose the board it writes to,
  or forge the model and session stamped on writes. A token that is not visible ASCII is refused.
- An unset `YOUTRACK_OWNER` leaves `owner` as the `admin` placeholder with `ownerIsDefault: true`. Commands that
  would assign the owner (`state Fixed`, `state 'To be discussed'`, Owner-role `handoff` and `create`) then reject
  before any write; `--assign`, `--no-assign` and `--assignee` still work. `whoami` prints `owner: admin
  (default)`, and its JSON adds `owner` and `ownerIsDefault`. A library caller that leaves `ownerIsDefault` out of
  its `WorkflowContext` gets the same refusal for an empty or `admin` owner; pass `ownerIsDefault: false` to
  assign an explicitly configured `admin`.
- `Config.token` is no longer enumerable, so `JSON.stringify`, `util.inspect` and object spread omit it. Pass the
  loaded config object on instead of a copy; a client built from a copy without the token is refused.
- Every id put into a request path is encoded as one segment, and `.`, `..` or an empty id is refused.
- `IssueFilter.text` matches summary words. Each word loses parentheses, colons, braces, `#`, backslashes and
  quote characters, and a word with no letter or digit is dropped; text with no words left adds no condition.
  `textMode: 'all'` (the default) needs every word, `'any'` at least one, for spoken queries. The words always
  sit in one parenthesised group beside the project and the other filters.
- `subsystems add` resolves `--board` (or `YOUTRACK_BOARD`, else the first board that includes the project)
  before writing, so a missing board changes nothing.
- `help` uses `--project`, `YOUTRACK_PROJECT` or the env file's project in its examples, and needs no token.
- `list` and `board` print `(showing N; more exist ...)` on stderr when more issues matched than they return;
  stdout keeps its shape. `board` now shows unresolved issues only, up to 500, so a Verified or closed column is
  empty.
- Token actuals are refused, including requests that also contain time, before any provider operation.
  Time-only actuals append once and return a work-item receipt with a pre-write issue snapshot. Refresh
  explicitly if current computed Spent time is needed. Existing token totals are untouched.
- `parseTokens` rejects any value that is not a whole number of tokens, such as more than six decimal places of
  millions (`1.2345678M`), which the old parser accepted.

## Failure and security contract

A workflow performs separate requests, so it cannot promise a transaction. Confirmed writes are recorded
as applied; a potentially committed write is uncertain. The CLI gives workflows its client's write counts, so a
step that sent nothing, or only writes the provider refused, is pending rather than uncertain whatever it threw.
A library caller that passes no `writes` counter gets the conservative reading: only a classified failure other
than `unknown` proves a step was not applied. The transport does not automatically retry writes.
A timeout, lost response or server failure after a mutation requires reconciliation before retrying.
The [accounting contract](accounting.md) explains why a local mutex cannot make token totals safe across agents.

HTTP requests stay beneath the configured API root, reject redirects and have a bounded deadline. The client,
adapter and admin commands encode every id they put in a path as one segment, and refuse an id of `.` or `..`,
which URL parsing would resolve. Error messages omit response bodies and underlying network errors that may contain
credentials or private issue content; `--debug` adds only the provider's `error` and `error_description`, truncated
and with the token removed. Configuration is resolved once before constructing identity, client and workflow
policy; it must not be printed wholesale because it contains credentials and an environment snapshot.

Tracker descriptions, comments and field values remain untrusted input to an LLM. This library does not
interpret them as instructions or execute their contents. An agent consuming them must apply its own
instruction hierarchy and tool authorization rules. Native commands can modify tracker state using the
caller's permissions; the portable workflow interface does not restrict that independent escape hatch.

## Verification

Run `npm ci`, `npm test`, `npm run typecheck` and `npm run format:check`. Tests use fake tracker ports,
injected HTTP transports and local subprocesses, with no production credentials or paid service calls.
Behavioral tests are the evidence for compatibility; passing them does not prove byte-for-byte equivalence
with the old implementation. The coordination packet and final review evidence are in [YA-8.md](YA-8.md).
