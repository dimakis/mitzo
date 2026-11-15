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

This bounded repair does not complete native task progress/update/snapshot
reporting, resume without a verified parent, model refusal/retraction, richer
context usage, shared auto-memory, affected-chat recovery, or live acceptance.
Those remain explicit full-parity gaps under the originating orchestrator.
