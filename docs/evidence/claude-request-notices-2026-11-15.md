# Claude request retry and rate-limit failures

Verified 15 November 2026 against accepted source
`5d81903c4d6a9511d517304be84b81769b4e23e1` and pinned Claude SDK 0.3.322.
This qualifies source behavior, not a live provider call or production activation.

## Behavior

The query consumer previously ignored SDK `api_retry` and rejected
`rate_limit_event` messages. A user could see a running conversation without
knowing that the provider was retrying or had reported a rate limit.

Same-session, parent-level retry evidence now produces a sanitized nonfatal
notice through the existing error/notice transcript path. Only finite bounded
native retry counters and delay data become text; absent/invalid metadata stays
explicitly unavailable. No host retry, new command, account/model switch or
queue mutation is introduced.

Rejected subscription limits are reported only for the selected Personal Claude
account. An observed reset timestamp is described as reported evidence; a
missing/invalid reset remains unknown and availability is never promised.
Subscription utilization is not inferred from token/cost totals, and no plan
quota is assigned to Vertex/API accounts. Allowed/near-limit warning events are
outside this failure-only repair.

Notices use the existing nonfatal live parser/reducer and cold replay, keeping
the current reply/running state and saved input. Raw native error strings,
account details and arbitrary identifiers do not enter public notices or logs.
Duplicate UUIDs are suppressed in a bounded per-loop cache. Cancellation and
the existing query retirement/output fences remain in force.

Original events and optional logger failures use the identical bounded host
retention utility introduced by lifecycle PR #1367. Its source is byte-identical
to `087abff557c8eeac8b3b76022353732a55c9dc96`; no competing diagnostic owner or
public inspection endpoint is added. Land #1367 first, then remove this identical
utility delta by integrating its accepted source. Query-loop composition with
persistence PR #1369 requires both paths and fresh source fingerprints.

## Evidence and limits

The coupled actual SDK adapter/query-consumer tests first failed with no notices
on accepted source, then passed after the translator was connected. Native query
creation is mocked; there are no provider or charged-account calls.

Initial focused run: 162 checks across five suites passed. Final expanded notice
coverage: 30 checks passed, including Personal/Vertex/API retry routing, Personal
rate-limit provenance, unknown metadata, redaction, duplicate suppression,
original event identity, logger failure, live reducer state and cold replay.
Existing design checks: 109 passed and one existing conditional skip. Runs used
one worker and a 1 GiB Node heap. Scoped lint and standalone strict translator
typing passed; hosted full typing/CI and exact-head Centaur review remain gates.

Model refusal/retraction, richer context usage, background task progress and
optional native plan-utilization displays remain separate reporting work.
This does not fix the original iOS transcript projection failure, reconcile a
stuck command, enable background tasks or establish full Claude parity.
