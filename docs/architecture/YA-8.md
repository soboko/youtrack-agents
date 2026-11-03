# YA-8: test suite and architecture cleanup

Issue: YA-8. Director: GPT-6. Baseline: `15d2245` on YouTrack Agents `main`.

## Scope and acceptance

Implement the owner's requested architecture cleanup in one package with the `yt` executable and
root TypeScript imports preserved. No Jira implementation or project rename. No live tracker migrations,
secret operations, or production deployment. Tests use fake ports/transports and local CLI subprocesses.

1. Typed workflow operations own create/take/handoff/finish policy outside the CLI and provider adapter.
2. Configuration resolves once before policy/identity; HTTP is injectable, bounded and classified.
3. Repeated `--set`, file handoff, owner configuration and false-success regressions have behavioral tests.
4. Partial or uncertain writes are reported honestly, with no blind mutation retry or claim of atomicity.
5. Accounting has an explicit concurrency/retry contract; unavailable provider guarantees are surfaced.
   Changing persistent source of truth or installing a live server workflow requires owner approval.
6. Native queries/commands and administration remain visibly YouTrack-specific. Imports remain compatible.
7. Documentation agrees that Fixed means agent handoff, not merge/deploy. Tests, types, formatting pass.

## Ownership and sequencing

| Issue | Scope | Branch/worktree | Estimate |
|---|---|---|---|
| YA-8 | Shared contract, packet, docs, integration and review | `codex/director-ya8`, `/tmp/youtrack-ya8-director` | 8 senior days / 500k tokens total |
| YA-9 | `client.ts`, `identity.ts`, `src/config.ts`, `src/identity.ts`, `src/youtrack/**`, adapter/config tests | `codex/impl-ya9`, `/tmp/youtrack-ya9` | 3 days / 150k tokens |
| YA-11 | `yt.ts`, `src/cli/**`, `src/workflow/**`, CLI/workflow tests, package/config build files | `codex/impl-ya11`, `/tmp/youtrack-ya11` | 3 days / 150k tokens |
| YA-12 | `src/accounting/**`, accounting tests, `docs/architecture/accounting.md` | `codex/impl-ya12`, `/tmp/youtrack-ya12` | 2 days / 100k tokens |

The Director owns `src/tracker.ts`; changes require a coordination message before implementation. Adapter
exports `createTrackerAdapter(client: YouTrackClient): TrackerPort` from `src/youtrack/adapter.ts`.
The provider client retains the existing public class/factory exports through root `client.ts`.
Config exports `loadConfig` with complete `owner`, `board`, `sprintBoard`, and optional `teamGroup` values,
in addition to existing URL/project/token/source; it must not mutate process.env. CLI resolves config
before identity, then passes config to the client. All cross-stream imports use explicit `.ts` extensions.

Accounting first proposes a safe provider strategy. Its portable code stays independent of `client.ts`;
YA-9 owns any adapter glue after agreement. Builders never edit each other's files. Work starts from the
shared contract commit. No new runtime dependency or provider bootstrap requirement without coordination.

## Formatting and readability

Apply `docs/typescript-style-guide.md` and these lessons from an earlier Prettier reformat of a larger
TypeScript tree:

- Preserve Prettier's 120-column, single-quote, semicolon and 2-space settings. Extend checks to new files.
- Audit copyright/license markers before formatting; do not reformat vendored/generated source.
- Read comments after formatting. Move explanations immediately above the statements they explain;
  manually wrap long prose, preserve reasoning and avoid comments stranded on closing braces.
- Keep mechanical-only changes separate from behavior/comment repairs. Never call a refactor mechanical.
- This CLI has no Vite bundle: use behavioral/CLI compatibility tests and type checks for functional changes.
  Do not claim test success proves byte equivalence. If a pure formatting commit is made, compare stripped
  executable output appropriately and use only its full 40-character SHA in blame-ignore metadata.

## Review and verification

Highest classification: distributed accounting/state plus transport security. Three independent reviewers:
Correctness, Testing, and Security/Operations coverage, followed by a Judge. Separate clean review
worktrees, same integrated commit, findings independent before cross-review. Builders do not review themselves.
Prescribed Claude model IDs are unavailable here; GPT-6 agents perform the roles at inherited effort.

Tests: `npm test`, `npm run typecheck`, `npm run format:check`, deterministic fake-provider failure and
concurrency cases, subprocess CLI input/output/exit-code compatibility, documentation agreement checks.
No live YouTrack mutation is used as a test. Tracker writes are project coordination only.

## Progress

- Intake: source and issue lane checked; YA-8 taken as Director. Subtasks YA-9, YA-11, YA-12 linked and taken.
  Baseline reproductions: env owner ordering, repeated set, handoff file, partial take, lost token increment.
  Total estimate: 8 senior days / 500k tokens. Actuals recorded in tracker at milestones; token actuals are
  estimates when the runtime does not expose exact usage.

### Integration and first review, 2026-09-13

- [VERIFIED] Candidate `72f68fa` integrates YA-9 (`d6478ad`, `e1b4402`), YA-11 (`8963891`) and
  YA-12 (`454d2b0`, integrated as `700348b`). All 38 offline tests, TypeScript and formatting checks pass.
- [VERIFIED] Independent correctness review found two P2 reporting defects: a confirmed native mutation
  followed by a failed refresh lost the confirmed step; pre-write field validation was classified as unknown.
  The latter is repaired in `202a12a` with an adapter-through-workflow regression test; the former in
  `b8b81ba` (YA-11), integrated as `7945509`.
- Builder actuals are approximate active time, excluding usage-limit interruptions: YA-9 50m / 24k tokens
  against 3d / 150k; YA-11 25m / 18k against 3d / 150k; YA-12 20m / 8k against 2d / 100k.
  Time is logged on each issue. Token estimates are in milestone notes because atomic accumulation is
  unsupported. Correctness review took approximately 12m / 15k tokens. These are not exact runtime metrics.
- Further hardening, uncommitted when GPT-6 hit a usage limit and committed by the successor Director:
  current-iteration discovery reads only `currentSprint` metadata (no dependency on historical membership),
  and malformed `customFields` in a post-write response is an unknown write. 42 offline tests pass.

### Hand-over, 2026-09-13

- GPT-6 (Codex) reached a usage limit with the Security/Operations review in flight; its findings were not
  written to the repository and are lost. Claude Opus 5 (also the YA-10 Director) takes over as Director at the
  owner's request. Remaining gates, re-run from the new head: Testing, Security/Operations, a correctness check of
  the two P2 repairs, then the Judge.
- The integrated branch is pushed as `codex/director-ya8`; it is not merged to main or deployed. No host
  submodule pointer is changed until the required review and integration gates are complete.

## Risks and decisions

- No generic API can make separate provider requests atomic. Unknown writes must remain visible.
- Shared-token agents require a cross-process concurrency solution; a local mutex is insufficient.
- Existing raw client methods remain explicit provider APIs, not a back door into an alleged security boundary.
- YA-7 remains the owner's broader connector decision. YA-8 introduces a tested seam without claiming Jira fit.
