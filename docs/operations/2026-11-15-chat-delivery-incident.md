# Chat delivery incident, 15 November 2026

Investigated against production release `30308c49d319`, with read-only release
logs, Jaeger traces and the command ledger. Times below are UTC. No production
restart, database mutation, model call or staging operation was performed.

## Phone message never reached admission

The screenshot's Host Mac Codex conversation was
`1d1e731e-3481-8ec0-a29c-3ef0874cbeab`. Its preceding command completed at
16:31:14. The failed outgoing command was
`f9cd3c73-ea0b-46bf-b892-accb8a1982a2`; it has no server send-command record.

Frontend `command.delivery.failure` spans show submission failing at `storage`
with `storage_timeout`, after 15,074 ms and 15,128 ms. Their trace IDs are
`7e816e60d08a9758637aa893d629575f` and
`b1b81765269a87dd737a26a113889e0d`. A subsequent receipt observation was pending.
The server trace window contains no send/continue request for that submission.

The storage barrier has a matching reproducible defect: the outbox deadline
rejects its wait without settling a stalled IndexedDB write. That write retains
the disk's draining queue, preventing later saves/retries from progressing. The
traces establish the storage timeout; they do not identify WebKit's native
reason for stalling the transaction.

Writes now have a 10-second transaction deadline inside the existing 15-second
delivery barrier. Timeout fences late callbacks, attempts abort and retires only
that database handle. The retained queue can retry through a fresh handle.
Retry observes an already-committed record only when key, revision, value and
legacy baseline all match. A different record or legacy edit still conflicts.
An uncertain snapshot keeps its original revision until reconciled. No draft is
deleted to recover capacity, and sending still requires durable persistence.

## Claude completion lost its original input identity

At 15:42:00, personal Claude conversation
`f2c4cd7b-0fbb-855d-b26b-55f3cdb172e7` logged
`ordinary_sdk_result_unavailable` / `provider_terminal`, with cause
`Original SDK result identity unavailable`. Trace
`4ea18bfbd3dbfd3bf18488d956342ee8` contains provider turns and tool execution.
The session record remained `RUNNING` for execution even after its viewer ended.

PR #1363 preserves input correlation across synthetic user messages and repeated
acknowledgements, and awaits durable result settlement before announcing success.
Its follow-up separates settlement from successor preparation: completed usage
and the completion event publish before queued work starts. A successor failure
retains its own sanitized runtime diagnostic instead of suppressing the preceding
confirmed result. Concurrent enqueues remain held until publication completes.

Historical unconfirmed turns are not rewritten or replayed by this repair.
Reconcile them from their original provider/callback evidence after activation;
do not infer completion from assistant text or a generic session-end event.

## Other retained failures

At 15:20:36, conversation `8326ca3e-1d22-8073-81f7-08583ecd9fd3` refused input
before provider dispatch at `workspace.reserve`. Diagnostic
`5752e93e-0d91-42ee-9cdf-39a5e0d47e36`, trace
`c167d1a978a10d1addc1c0c8f2762cae`, identifies the failing check but does not
retain its detailed native cause. Do not claim an account outage or weaken the
workspace fence. A follow-up should add a fixed, sanitized reason at the owning
workspace check and reproduce that specific rejection before changing recovery.

An OpenShell lifecycle record also reports changed runtime configuration. Its
ownership record is retained; this investigation does not authorize migration,
credential substitution or a production test fallback.

## Validation and limits

Existing query-loop/owner/EventStore coverage now includes successor preparation
failure and concurrent enqueue ordering. Five focused server files passed 229
tests in 12.87 s. Three additional SDK adapter/evidence/skill-boundary files passed
29 tests in 4.30 s. Storage regressions reuse the existing storage/outbox fixtures
and real adapter composition with deterministic IndexedDB events: stalled write,
missing commit acknowledgement, late callbacks, exact retry and foreign-record
conflict. Five storage/client files passed 151 tests in 6.73 s. These are local
execution durations, not CI queue or end-to-end pipeline measurements.

Checks used one worker and a command-local 2 GiB Node heap. Focused storage
TypeScript checking and ESLint passed. Design guards passed 109 tests with one
existing skip in 2.90 s. New tests introduce no browser, native,
subprocess, persistent database or model journey. Browser behavior on the affected
phone and full combined CI remain unverified locally; the repairs require the
normal current-head review/CI gates and separately authorized production/iOS
activation. Preserve the phone's drafts and storage while that work is pending.

## Continuation rejected after the production redeploy

The accepted `bb9b6218c051` release was activated at approximately 17:30 UTC.
A subsequent personal Claude send at 18:32:30–18:32:47 reached the server five
times and received HTTP 409 / `runtime_unavailable` before admission. No send
ledger row or provider input exists for that message. Its frontend traces show
`http_rejected` followed by receipt observation, rather than a storage timeout.
The currently selected account, model and thinking level remain available.

A model-discovery refresh completed at 18:32:28. Offline reproduction confirms
that the Claude and Gemini capability digests included discovery timestamps and
cache-source metadata: refreshing identical support invalidated frozen commands.
The rejected request body was not retained, and existing logs omitted the inner
check, so this is a proven admission defect consistent with the timing, not a
proven reconstruction of that phone request. Admission now records fixed safe
check names in correlated logs/traces. Unavailable receipt lookup is reported as
unavailable evidence, never as proof of non-admission.

The support projection excludes display/freshness metadata and canonicalizes
model/effort ordering and absent/empty effort lists. Account/profile/target,
stale discovery, actual model support, context, permissions, custody and current
operator authority still qualify each command at their existing boundaries.

### Recovering a frozen unadmitted message

A stable future digest cannot rewrite an old frozen outbox body. Claude
continuations therefore have an explicit **Review delivery** action. Withdrawal
atomically races admission through a durable global command claim; if admission
won, withdrawal cannot erase or replace it. A withdrawn command ID cannot enter
ordinary admission, legacy send storage or direct execution. Repeating the exact
withdrawal is idempotent. It creates no provider input or consumed receipt.

The client preserves its exact envelope in a separate archive and flushes that
archive before retiring/flushing its active entry. Failures keep recovery visible;
old acknowledgements cannot alter another chat or a newer review. The composer
and later edits remain mounted. Reviewing current settings and sending a new
command are separate explicit actions. Old uncertain provider turns remain
unreconciled; this change neither replays nor marks them complete.

### Focused cleanup and validation

Both chat layouts use one shared recovery implementation. Withdrawal persistence
is a focused store rather than more lifecycle logic in EventStore. Existing
claim lookup also checks withdrawal without a second database round trip;
mutation/dispatch boundaries retain their necessary fences. The browser fixture
shares asset routing and command construction; retained history is never copied
into each future active-queue write.

Tests extend existing catalog, HTTP, EventStore, outbox, storage and dialog fixtures.
The held-flush, lost-response, archive/removal failure and authentication-change
cases use in-memory storage. The existing persistent-database lifetime also proves
withdrawal across stores/reopen, without a new database journey. A 101-record
in-memory archive case checks the existing 100-entry pending limit explicitly.
The added offline browser cases are justified by the real store/composer/modal
boundary and edited-draft survival across a full document reload; API traffic is
intercepted and no backend or model is contacted.

The affected unit/design run passed 411 tests (one existing skip) in 18.30 seconds
locally before the final receipt-observation test was added. Initial recovery UI
cases passed on mobile WebKit and desktop Chromium in light/dark themes and
representative alternate accent/font settings. Final source checks, affected CI
and exact-head review remain required. These are execution times; CI queue/cost
and physical-phone verification are not measured here. Production and iOS
activation remain separate from publishing this repair.
