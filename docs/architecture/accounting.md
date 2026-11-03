# YA-12: accounting concurrency and recovery

Issue: YA-12, part of YA-8. Reviewed against YouTrack Agents baseline `15d2245`.

## Current guarantee and compatibility change

The YouTrack adapter reports `atomicAccounting: false`. `actual --tokens` now fails with `unsupported`,
including a zero increment. A mixed `--time ... --tokens ...` request fails before logging time or changing
any fields. The CLI must return failure, not silently omit tokens. Existing callers that used token
increments must handle this deliberate behavior change. Submit time alone and discuss token reconciliation
with the owner; do not replace the refusal with an automated read/modify/write command.

The previous implementation read `Actual Tokens`, added a contribution locally and set the field. Two
processes reading 10M could write 11M and 12M, losing one contribution. A local mutex does not coordinate
agents on other machines. A subsequent read cannot prove safety: another writer can update immediately
after it. Neither retrying nor adding a UUID in a comment turns these requests into a transaction.

`src/accounting/actuals.ts` validates the entire input before provider work. Token notation retains the
existing small-number-as-millions convention. Values must be nonnegative, finite, and represent a safe whole
number of raw tokens. It avoids the previous three-decimal rounding that discarded small contributions.
Duration parsing remains the provider's responsibility, including its configured working-day length.

## Time-only operations

Time remains a single append to the provider's work-item collection. Concurrent distinct appends do not
overwrite an aggregate field: YouTrack derives spent time from work items. This is not an exactly-once
promise. If a connection is lost after dispatch, the work item may exist even when the caller sees failure.
The transport must report an unknown mutation outcome and never automatically resend it.

Inspect the issue's work items before retrying an uncertain append. A known returned work-item ID establishes
which item was created. If the response was lost, matching time, author, description and date is evidence for
human reconciliation, not proof of uniqueness. An empty search is also insufficient proof of non-application
when the first request could still be running. Do not claim that cancellation undoes a submitted write.

`addActual` reads the issue before appending and returns that pre-write snapshot together with the
acknowledged work item. It performs no post-append refresh that could obscure a successful write. Callers
that need current computed Spent time can refresh separately; retry only that read if it fails.

## Provider evidence and its limits

Checked 2026-09-12 against JetBrains' public reference:

- The [issue update endpoint](https://www.jetbrains.com/help/youtrack/devportal/operations-api-issues.html)
  documents `updated` as read-only and does not define a compare-and-swap precondition for its POST operation.
- The [work-item collection](https://www.jetbrains.com/help/youtrack/devportal/resource-api-issues-issueID-timeTracking-workItems.html)
  supports append through POST, with a provider-generated read-only ID. Its documented parameters do not
  include an idempotency key.
- The [request-header reference](https://www.jetbrains.com/help/youtrack/devportal/yt-api-headers.html)
  does not document an idempotency header or conditional-write mechanism.

[VERIFIED] The documented endpoints used by this client provide no accounting guarantee the adapter can
claim. This is not a claim that no extension or future API could supply one. No live race or mutation probe
was run, and no server workflow was installed.

## Future support requires an explicit provider contract

An adapter must not set `atomicAccounting: true` merely because it can set a numeric field. A future design
needs provider-side serialization of increments, durable operation identities with payload binding, and
replay behavior that applies the same contribution once across concurrent processes. A mixed time/token
request additionally needs atomic application or explicit per-step reconciliation with durable identities.

Installing a server extension or introducing durable contribution records as a new source of truth requires
owner approval. This change does neither. There is no fallback ledger, hidden local lock or unsafe opt-in.
Do not implement generic retry over unknown writes while that decision remains open.

## Verification responsibilities

- Helper tests: token normalization, numeric rejection, empty input, and mixed-request capability rejection.
- Adapter integration tests: unsupported tokens produce no reads or writes; time-only dispatch occurs once;
  concurrent appends do not use aggregate read/modify/write; timeout/cancellation after dispatch remains
  uncertain; the receipt returns without a post-append read.
- A future atomic adapter must pass barrier-controlled concurrent contribution and duplicate-operation
  tests, lost-response retry tests, payload-mismatch rejection, and cancellation reconciliation. A fake
  provider passing those tests would validate orchestration only, not prove that YouTrack supports it.
