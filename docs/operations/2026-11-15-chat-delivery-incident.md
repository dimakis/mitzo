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
