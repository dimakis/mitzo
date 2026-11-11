# Command latency and configured MCP startup

Implementation contract, 11 November 2026. These measurements are diagnostic;
they do not authorize dispatch, recovery, tool execution or deployment.

## Reading the spans

- `codex.command.queue_wait` runs from durable enqueue to claim, cancellation or
  close. `queue.reason_changed` events record observed transitions between
  `queued`, `active_turn`, `recovery`, `deployment`, `admission` and `eligible`.
  Reasons use the existing queue gates; they do not poll or re-run authorization.
  Recovered queues do not invent timestamps for time before this process observed them.
- Internal `session-prompt:` and `collaboration:` command IDs retain correlation
  alongside ordinary bounded IDs. Prompts and arbitrary text are excluded.
- `codex.turn.first_activity` ends on matching tool activity, reasoning or
  assistant text. `codex.turn.first_text` ends on matching assistant text.
- `codex.turn.first_output` retains its existing text-or-reasoning meaning for
  dashboard compatibility. `codex.turn` remains the completion measurement.
- First-activity/text spans ending without output have an explicit
  `terminal_before_output` or `failed_before_output` result. Do not treat these
  durations as successful response times. Reasoning effort, when selected, is
  recorded on the parent turn. No reasoning content is recorded.

Queue waits include legitimate pauses and time behind another turn. Attribute
the wait before diagnosing scheduler latency. These spans overlap: do not add
their durations as if they were sequential phases.

## Lazy configured sources

Receipt-selected MCP tools expose their pinned definitions without starting
external processes during chat admission. The first invocation, or a retained
output read, initializes only its source and verifies the live descriptors
against the selected receipts. A schema mismatch produces an error before any
tool invocation. Catalog/source revocation and existing tool permissions remain
checked at their original boundaries.

Concurrent calls share one initialization per source within a session. Cancelling
one caller does not cancel another waiting caller. Cancelling the last waiter
retires the pending initialization and closes a late peer. Failed initialization
is retained for that session, not automatically retried. Closing an unused source
launches nothing. Sources and credentials are not pooled across sessions.

First use still pays connection latency. This removes unused-source work from
startup; it does not claim faster provider inference. Legacy unselected MCP paths
and task-board peers retain their existing startup behavior.

Connection failures retain internal causes with sanitized stage/code diagnostics.
Cleanup failures remain observable and do not replace the primary failure.

## Follow-up

Recovery's one-item history pages remain unchanged. Byte-bounded native responses
are needed before safely increasing recovery page sizes. Compare deployed traces
after separately authorized activation; offline regressions prove behavior, not
a production latency improvement.
