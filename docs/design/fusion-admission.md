# Native fusion durable admission

`/fuse` composes the EventStore execution and provider-attempt records used by
`/deliberate`. It does not create a second lifecycle owner. The native command
requires a durable context; bare harness usage remains compatible.

## Identity and admission

An EventStore `client_command_claims` row reserves a canonical hash of the original
wire intent before any transport normalization, including ordinary WebSocket
commands that have no HTTP receipt. It records identity only, not execution state;
receipt and execution gates retain their replay/route behavior. Claims survive
restart, contain no raw prompt, and reject changed payloads with HTTP 409.
The global `send_commands` receipt also rejects changed payloads across REST/SSE,
WebSocket, ordinary messages, `/deliberate`, and `/fuse`. Exact fusion retries
re-enter the execution fingerprint gate. `fusion-v1` hashes normalized task,
complete panel/judge/synthesizer configuration and budget, caller selections,
opaque actual-provider route revision, and orchestration/trust-domain revisions.
Self-fusion selects a different configuration and therefore a different fingerprint.
Confirmation is permission for a new command ID, not permission to redispatch an
old ID. The leading `--self` and `--confirm-ambiguous` flags accept either order.

Admission happens before provider construction, session assignment, or reasoning
events. Synthetic `fusion-<hash>` sessions are closed execution streams, never SDK
conversations. Later ordinary messages start a fresh chat. Replays restore watches.

## Parallel child attempts

Child identities are `fusion:<executionId>:panel-1`, `panel-2`, etc., followed by
`judge` and `synthesize`. Panel index, not model name or completion order, identifies
a slot; self-fusion therefore still has two distinct attempts. EventStore offers
an explicit `allowParallel` opt-in only used by panel dispatch. Existing callers
retain single-active-attempt admission. Generation checks, duplicate detection,
and the prohibition on terminalizing roots with active children remain unchanged.

The route revision is checked before each child admission. Providers receive the
abort signal and `maxRetries: 0`. All panel promises settle before moving forward.
Any failed panel stops a durable run before judge/synthesis, rather than silently
spending more on incomplete evidence. The legacy standalone harness retains its
partial-panel fallback when it has no durable runtime.

## Failure, stop, and restart

Provider-call errors conservatively mark that child ambiguous. Other dispatched
siblings settle individually. The root cannot become terminal while a child
receipt is still running, including when terminal writes fail. A user stop aborts
in-flight work, marks unfinished calls ambiguous, terminalizes the root as stopped,
and fences later children and late response events. Provider cancellation cannot
guarantee that already-dispatched work was not billed.

EventStore restart recovery performs no provider calls. Exact retries return the
persisted outcome. Recovery with no attempts is safe failure; recovery with
attempt evidence remains uncertain. Starting a new attempt in that uncertain
session requires explicit confirmation. Generic send-command recovery recognizes
the execution admission and does not poison its receipt for lacking a user message.
Errors returned by native fusion are sanitized. Raw credential/endpoint/path values
are not written into admission fingerprints or error messages.

## Validation and scope

Tests use fake providers and disk-backed stores for admission ordering, concurrent
self-fusion, per-child receipts, exact retries, conflicts, route changes, restart,
storage failures, stop, both transports, cross-command collisions, and fresh chat
follow-ups. No live provider call is required. Reconnect snapshot redesign, provider
migration, deployment, and automatic closeout admission are separate phases.
