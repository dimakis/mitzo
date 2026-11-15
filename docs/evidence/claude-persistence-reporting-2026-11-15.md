# Claude native persistence reporting

Verified 15 November 2026 against accepted source
`b7762c11818dc4066f99d267de3888ccf9d751f7` and pinned Claude SDK 0.3.322.
This is source qualification for the persistence-reporting portion of Claude
parity, not activation, incident recovery or full parity acceptance.

## Problem and repair

The SDK can emit `session_writes_lost` after its final result on clean exit.
The owned query adapter discarded every post-result event, concealing native
transcript/settings loss. A configured transcript mirror can likewise report
`mirror_error`. Received results remain valid; native persistence is uncertain.

The adapter now allows only same-session, parent-level persistence diagnostics
after the terminal result, rechecking current authority before delivery. The joined
owner drains these read-only diagnostics when successor preparation retires the
previous native query. Closed/aborted owners, foreign/child events and unconfigured
late mirror diagnostics remain excluded. Input, assistant and repeated-result events cannot
establish successor provenance after completion.

The query consumer translates these events into existing nonfatal error notices.
Live parsing and durable replay preserve the notice without stopping a queued
successor or replacing a completed result. Public text excludes raw native error
strings, private project paths and foreign transcript IDs. Correlation IDs must
be UUIDs; malformed identifiers receive a fresh UUID. Duplicate UUIDs are
suppressed in a bounded per-loop cache.

The original diagnostic remains in a bounded, process-local host buffer under
the same correlation ID and session identity (32 records globally). An optional
logger failure is retained there too and does not prevent the visible notice.
This buffer is internal, ephemeral evidence: no public inspection endpoint,
restart durability or automatic recovery is introduced.

## Evidence

The adapter and actual query-loop/live-parser/cold-replay regressions first
failed on the accepted source (lost notices), then passed with this repair.
The regression seed continues the prior reporting owner's public handoff and
unrun test draft from `ordinary-e25a873e-f4c1-4fcf-98fc-7b5ccff87ded`;
that checkout and its uncertain setup operations were preserved unchanged.

Final local combined-tree run, one worker and 1 GiB Node heap: 298 passed, one existing
conditional design skip, across fourteen files. Coverage includes both diagnostic
types, duplicate suppression, log failure, original-cause retention and bounded
eviction, redaction, foreign/child events, revocation, abort, retired-query fences,
the live client reducer, durable cold replay and the existing design contracts.
An independent full pass found that the original retired-query guard still lost
warnings during queued successor turnover, and found an incorrectly typed client
fixture. Both were corrected. A new coupled adapter, actual command owner and
query consumer regression reproduced two delivered results but no warning before
the correction; both diagnostic types now survive turnover into cold replay.
The same regression rejects stale input/output/results from the old query.
Scoped lint and strict standalone diagnostic-module typing also passed.
Whole-server/test typing exhausted the prescribed 1 GiB heap; it is left to
hosted preflight rather than increasing the local resource ceiling.
Hosted checks and exact-head source review remain required for acceptance.
Hosted typing subsequently caught a synthetic input ID incompatible with the
pinned SDK's UUID template type. The coupled fixture now uses real fixed UUIDs
for both inputs and still passes; current-head hosted typing must verify the fix.

Accepted naming/transcript changes from PR #1365 at
`5d81903c4d6a9511d517304be84b81769b4e23e1` were integrated to repair the actual
manifest conflict blocking CI. The accepted delta preserves the existing owned
SDK admission/echo/push sequence; naming history reads and sanitized transcript
failure annotations do not change query lifetime or diagnostic delivery. All
accepted source hashes are retained alongside the reporting hashes.

No provider/model call, live account operation, physical device test, production
activation or actual stuck-session reconciliation was performed.

## Remaining reporting work

Retry/rate-limit/refusal reporting, context-usage detail, background task progress
and optional personal-plan utilization require their own bounded source and
consumer qualification. This repair does not enable backgrounding, change
models/accounts, expose private settings, replay commands or claim native shared
auto-memory parity. Original iOS transcript projection and stuck-session recovery
remain separate owned investigations.
