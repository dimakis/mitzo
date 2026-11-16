# Claude resumed task reporting

Source observation and offline qualification: 15 November 2026. Pinned Claude
Agent SDK: 0.3.322. Accepted comparison source: Mitzo
`5d81903c4d6a9511d517304be84b81769b4e23e1`.

The SDK retains `task_id` when a task resumes, assigns a new `run_id`, and orders
run IDs by plain string comparison. The query consumer previously remembered
completion only by task ID. A completed predecessor hid the resumed execution;
a delayed predecessor notification could instead complete the resumed tool.

Two coupled offline regressions first failed against the accepted source, using
the actual ordinary SDK adapter, query consumer and durable transcript replay.
They now preserve separate verified parent tools and run-specific child IDs.
Only an observed matching run and parent can settle the current execution.
Duplicate/older starts and missing/older/future/conflicting receipts cannot finish
it or erase its existing cancellation mapping. Legacy distinct tasks without run
IDs retain their existing behavior. No replay, tool execution or new control
request is introduced.

An independent full pass found that retaining only the latest run still lost a
verified late predecessor completion. On 16 November, the coupled case was
strengthened to assert both predecessor and successor live/cold outcomes and
failed before the correction. Each observed run now retains its own verified
parent and outcome. A matching older receipt settles that older row exactly once
while the newest execution keeps its cancellation mapping. Unknown or conflicting
receipts cannot settle either row. The native task ID remains the existing
control identity; these records are ephemeral query-consumer correlation only.

The final coupled cases additionally feed events through the actual live parser
and reducer, prove both completed and failed resumed results survive cold replay,
reject late/wrong-parent/unknown-run/ambiguous receipts, and keep duplicate
terminal events idempotent. Native SDK query creation is mocked. This is offline
consumer evidence, not a live provider/account or physical device qualification.

Final focused verification: 140 checks pass across six SDK adapter, query-loop,
task/subagent consumer, child-diagnostic and retirement suites with one worker
and 1 GiB. Scoped ESLint, formatting and current source fingerprints pass.

Required current-head CI and trusted Centaur final LGTM, `merge` recommendation
and zero blocking findings remain landing gates. No activation or live account
test is claimed. Full local TypeScript builds remain subject to the existing
1 GiB test/build memory limit; hosted compilation must qualify the exact head.

Integration: `server/query-loop.ts` also has independent reporting changes in
PR1369 and PR1371. Preserve all three changes when actual accepted-main conflicts
are reconciled; do not absorb pending branches speculatively. Shared source
registry revisions and hashes require normal composition and current-head gates.
GitHub confirmed an actual conflict after accepted lifecycle commit
`f7bab377d071e8cf15ac4eaf4e7e59fa687ec087`. That exact accepted source was
integrated with only the manifest revision manually resolved; accepted recovery
and diagnostic source and pins remain intact.

Accepted transcript repair #1370 at
`16e74da83fe6e18e3a027ea4e562cdf0afddddb6` was integrated after reproducing
another manifest conflict. Inspected its entire original-cause retention, safe
HTTP response and test delta. It consumes the unchanged canonical diagnostic
owner, and changes no task receipt, query, input or cancellation contract. The
accepted handler/tests and this PR's task-run production source remain
byte-identical to their respective parents; only the manifest label required
manual resolution. Existing full and correction review baselines remain intact;
the composed transcript, retention and task consumer suites pass 18 checks
across three files, with source pins, formatting and whitespace checks passing.
The exact composed head still requires hosted CI and trusted follow-up.

This bounded repair does not complete native task progress/update/snapshot
reporting, resume without a verified parent, model refusal/retraction, richer
context usage, shared auto-memory, affected-chat recovery, or live acceptance.
Those remain explicit full-parity gaps under the originating orchestrator.
