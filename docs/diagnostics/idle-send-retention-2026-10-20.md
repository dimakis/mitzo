# Legacy Codex follow-up retention

Two post-deployment send traces on October 20 spent 2.005 and 2.012 seconds in
the idle `config/read` check before acknowledging the saved prompt. Transport
recovery then took 6.789 and 7.167 seconds before dispatch. Those traces prove
the idle request did not respond before the health deadline; they do not identify
whether the remote app-server, SSH relay or host scheduling caused the silence.

Legacy ordinary Codex follow-ups should acknowledge the exact durable user
message before waiting for transport admission. This is a retention receipt:
the existing native queue, account/model checks, idle generation retirement and
recovery must still finish before provider dispatch. Failure after retention
must leave a durable error rather than claiming successful execution or replaying
the saved request. A request cancelled during its idle probe must not become a
new native queue entry.

The change is confined to the legacy `sendToChat` path. Runtime-bound guarded
commands, native Responses commands and paid reasoning commands keep their
own admission and receipt semantics. Interrupted provider turns remain
interrupted; a retention receipt does not authorize retrying them.

An already attached conversation keeps its existing stream transport. Its HTTP
waiter therefore receives an explicit command-scoped retention callback after
the prompt is durable. Late admission and asynchronous recovery failures are
stored against the captured session and command before delivery, with durable
sequence numbers. A newer HTTP transport cannot mistake an older command's
delayed failure for its own receipt failure.

The client keeps an older command's sequenced failure in that command's transcript
group. It remains visible without clearing a newer command's preparation or
active reply. A delayed receipt for the newer command cannot treat that older
failure as the newer command's response. The latest command's failure retains
the existing terminal error behavior.

No idle deadline is reduced and no background provider probe or model call is
added. Recovery and time to first output still need separate measurement after
a separately authorized deployment. Moving the receipt does not eliminate that
response preparation work.

Offline regressions hold transport admission open while verifying prompt
persistence, retained receipt completion and exact concurrent retry identity.
They then fail or cancel admission and verify the durable failure without a
provider resume or automatic command replay. Existing idle transport, guarded
runtime, native admission and terminal-before-delayed-receipt client regressions
remain part of the focused validation.

The HTTP integration fixture uses the real REST router and `handleSendV2` with
an already attached owner, while the native provider adapter is an offline mock.
It exercises successful admission, failed admission, failed asynchronous recovery,
retained retries and sequenced late errors without requiring stream reattachment.

Before the callback was wired through the REST route, the attached-owner test
timed out waiting for its HTTP receipt. With the callback, 632 focused tests in
eight files pass, including the existing terminal-before-delayed-acknowledgment
client regressions. Server production type checking, targeted lint and formatting
also pass. These are offline synthetic results, not deployed latency measurements.
The client follow-up passes 249 client/design checks with one skipped case,
including preparation, active output, delayed receipts and prior output grouping;
its package type checking, lint and formatting pass. These suites overlap with
the earlier continuity checks and are not additive unique-test counts.

## Restored failures and programmatic dispatch

The safe retained-command error writer marks its own saved feedback explicitly.
History and reconnect recognize that marker only after the exact command's valid
same-session user echo in the same immutable provenance partition, with the
versioned public error envelope and saved-message prefix. Unmarked startup
diagnostics, unknown commands, foreign sessions, later echoes and different native
provenance remain excluded. Recognized feedback stays with its original command
after restoration, preserving a newer active reply and its current blocks.
Telos source selection uses that same classification and refuses a complete prefix
that would omit public error feedback.

The HTTP and WebSocket routes explicitly opt into retention acknowledgment.
Programmatic callers still receive `false` when native queue admission fails,
allowing the task orchestrator to block an undelivered pinned task and release its
active task context. The UI routes keep their single exact saved-error event.

Regressions reproduced missing retained errors in history/reconnect and a pinned
task remaining active without a native enqueue. The focused follow-up passes 430
tests across six files, including the real HTTP/WebSocket handlers, real task
orchestrator, history/reconnect grouping, native provenance and source privacy
checks. Server production type checking and targeted lint pass. No runtime,
deployment or live model target was used.
An additional 157 checks pass across five distinct continuity files for durable
send identity, guarded runtime exclusion, the REST wrapper and delayed terminal
acknowledgments: 587 focused follow-up checks in total.
