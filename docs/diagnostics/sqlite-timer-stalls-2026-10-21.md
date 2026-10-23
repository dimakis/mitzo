# Session overview timer and attention-query stalls

The October 21 process sample captured 596 of 3,169 main-thread stacks inside a
synchronous SQLite `.all()` called from a timer, including overflow-payload reads
and temporary B-tree work. Its JavaScript frames are anonymous; the sample alone
cannot identify that statement or assign every observed stall to one caller.

A source audit found a concrete repeating path:

`SessionOverviewEmitter.scheduleIdleTransition()` → expired deadline →
`setTimeout(..., 0)` → `scheduleBroadcast()` → `compute()` →
`EventStore.getAttentionSessions()`.

Expired timestamps remain in the state map. The old callback rescheduled while
that map was nonempty, even when every deadline had passed. The 200 ms broadcast
coalescer limited attention reads to about five per second but did not stop the
zero-delay timer. Keeping those timestamps is necessary: state derivation uses
them to keep an idle session idle instead of treating it as newly active.

Read-only production `EXPLAIN QUERY PLAN` confirmed the exact attention query
scanned `sessions` and used a temporary B-tree for descending `last_speaker_at`.
The VM description built wide sort records containing session context fields.
The periodic delivery-retry query, by comparison, used the existing
`idx_events_session_seq` index without sorting. Neither production SELECT was
executed for this diagnosis; no payloads, credentials or configuration were read.

The correction arms only the earliest future deadline and stops when none remain.
Forgetting a session recalculates that deadline; a later touch can arm it again.
Expired timestamps remain available to derive activity. Normal explicit and
minute worktree-refresh broadcasts still read current data.

An additive partial index orders non-hidden assistant-speaker candidates by
`last_speaker_at DESC`. The attention query itself is unchanged: current
registration evidence and internal-SDK exclusions still apply before the ten-row
limit. No visibility decisions or permission state are cached. The index is built
once during normal database initialization, after legacy attention columns exist;
its production creation time has not been measured.

Synthetic regressions reproduce ten unnecessary attention reads during two quiet
seconds after the final transition, and five during one second between staggered
transitions. They require zero such reads after correction while retaining exact
five-minute state boundaries, later transitions, retouch, forget, real-event
broadcasts and shutdown cleanup. Wide fresh and upgraded database fixtures require
an indexed query with no temporary sort and preserve the same ordered results,
hidden/registration/internal-SDK filters and row contents through the index upgrade.

This removes proven unnecessary work. It does not establish a production latency
improvement or explain every sampled SQLite call. Production observation after a
separately authorized deployment is still required.
