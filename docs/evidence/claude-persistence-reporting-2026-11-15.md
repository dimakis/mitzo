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

On 16 November, the actual accepted lifecycle commit
`f7bab377d071e8cf15ac4eaf4e7e59fa687ec087` was merged to resolve GitHub's
confirmed conflicting manifest label. Accepted recovery/diagnostic source and
pins remain intact; the only manual integration resolution is the runtime label.
The composition's successor, canonical diagnostic and sharing checks pass
(17 checks across three files).

The prior hosted shard failed only the targeted-sharing UI test. Its retained
DOM showed an unexpected `/recipients/architect` read, which the fixture omitted;
the focused file's normal fast run had passed. Explicitly qualifying that real
read through the API client reproduced both cases before fixing the fixture.
The bounded fixture now returns matching observational readiness for the two
known recipients, including the running original agent's unavailable reason.
All ten UI cases pass and continue asserting GET-only behavior. No sharing or
reporting production behavior was changed for this fixture correction.

Accepted transcript repair #1370 at
`16e74da83fe6e18e3a027ea4e562cdf0afddddb6` caused another demonstrated manifest
conflict. Its handler retains the original cause through the unchanged canonical
bounded diagnostic owner before attempting the sanitized logger. Inspected the
entire accepted three-file delta and its four HTTP variants, eviction and sink
failure coverage. Accepted handler/tests and this PR's persistence production
files remain byte-identical to their respective parents; only the manifest
runtime label required manual resolution. The composed transcript, canonical
diagnostic and persistence suites pass 29 checks across three files; source pins,
format and whitespace checks pass. Existing full and correction review baselines
remain applicable; exact combined-head hosted CI and trusted follow-up remain
required. No runtime activation or live incident recovery is claimed.

Accepted task-run repair #1372 at
`f8a421b2be65341ea86de126339fb0b668aa7cbb` caused a demonstrated manifest
conflict. Inspected and retained the complete task/run parent and cancellation
mapping delta. Query-loop source merged without manual edits; only the runtime
label and composed query-loop source fingerprint required manual resolution.
The reporting adapter and persistence diagnostics remain unchanged. Combined
task-consumer, persistence, actual SDK adapter, query-loop and canonical retention
suites pass 164 checks across five files, one worker/1 GiB. Source fingerprints,
formatting and whitespace checks pass; current combined CI and trusted follow-up
remain required.

The preceding hosted macOS shard 2/3 (job 133019599060, run 43781007514)
failed before product tests when `actions/download-artifact` could not list the
workspace artifact because its request returned `ECONNRESET`. The later missing
test-results upload followed that setup failure. No product cause or code fix is
claimed for it. The necessary accepted-source composition receives normal CI.

## Accepted startup integration

Accepted #1368 at `18d1d4a3e0d8bfdc654cce84d7fa828483582735`
adds context preparation before replacement SDK creation. Its initial chat context,
Google schema and publication consumers are retained. The optional preparation
hook remains between original-process closure and replacement creation, bracketed
by current authority checks. Persistence warning drain and closed-owner fences
are unchanged. The shared SDK test conflict was two complete independent additions;
both are preserved. The registry retains the exact 2517-entry union, with the two
composed SDK source/test fingerprints and a new runtime revision.

The combined six-suite qualification covers 177 distinct checks. An initial run
restored host enrollment references after fixture cleanup; clearing those references
left three startup admission failures. A separate ignored diagnostic probe identified
the remaining cause as canonicalizing a protected host executable directory from
PATH. With an explicit offline executable path, all five real startup-consumer
checks pass, including the three failures. The other 172 checks passed in the
preceding six-suite run. These overlapping results are not summed. No privacy fence
was changed or extra access requested. Original failures and the diagnostic probe
are retained in local test-results and `/private/tmp/claude-1369-startup-integration*`.
Scoped lint, formatting, source fingerprints and whitespace checks pass. Earlier
full independent review and the exact-634b trusted LGTM remain baselines; the new
combined head still requires CI and trusted verification.

## Remaining reporting work

Retry/rate-limit/refusal reporting, context-usage detail, background task progress
and optional personal-plan utilization require their own bounded source and
consumer qualification. This repair does not enable backgrounding, change
models/accounts, expose private settings, replay commands or claim native shared
auto-memory parity. Original iOS transcript projection and stuck-session recovery
remain separate owned investigations.
