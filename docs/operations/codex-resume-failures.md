# Bounded Codex resume and startup failure ownership

## Incident and evidence

On 18 October 2026, a retained ordinary OpenShell chat failed before its next
provider command was admitted. Both attempts closed in the app-server parser
and produced the public `conversation_initialization` / `protocol` diagnostic.
Each attempt also persisted two identical error events.

Read-only inspection found the prior completed command, application events,
native thread binding, and retained checkpoint. The failed follow-ups had not
created native commands. The checkpoint's native session metadata and the
production source both identified Codex 0.160.0.

A credential-free offline reproduction used that exact native version and a
disposable copy of the retained native transcript. It sent initialization and
resume requests, with an isolated home and an inert localhost provider; it sent
no model turn. The complete native resume response was **6,776,609 bytes**;
`excludeTurns: true` returned **2,458 bytes** for the same native thread.
Mitzo's unchanged frame bound is **4,194,304 bytes**. Private transcripts,
checkpoint paths, account identities and response bodies are not committed here.

The triggering history included large completed dynamic-tool results. Native
rollout events retain the full display result even when the model-facing tool
output is smaller. Neither the transcript's disk size nor model token count is
the response frame size. Model context exhaustion, account limits and a broken
runtime version were not established by this incident.

## Effects through five orders

| Order | Mechanism and consequence                                                                                                                                                                                                                                      | Required invariant                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Resume hydrated every historical item into one response. A valid large response exceeded the frame bound and closed before a new provider turn.                                                                                                                | Execution attachment requests metadata only; history stays in the native thread.                                                                                                                   |
| 2     | Retrying the same thread repeated the oversized response. Cold resume, reconnect, web-search reconfiguration, ownership repair and migration validation shared this risk.                                                                                      | Every resume uses the same metadata contract; recovery reads bounded metadata pages and validates the existing thread, model and account.                                                          |
| 3     | Stream delivery and admission rejection both reported one startup failure. REST persisted both, so reconnect replay repeated the duplicate bubbles.                                                                                                            | One failed startup attempt owns one error delivery, whichever reporting path runs first. A failed receipt never redispatches its command.                                                          |
| 4     | Resume entered `CREATED`, but cleanup ended only newly assigned SDK sessions. Registry removal left stale state; a late cleanup could also abort a replacement owner.                                                                                          | End the failed driver's state and abort it only while its original registry identity is current. Preserve history and replacement ownership.                                                       |
| 5     | Repeated prefix copies amplified large fragmented responses. A broad parser catch classified handler exceptions and oversize failures as malformed protocol, obscuring diagnosis. Raising the cap or replacing threads would defer failure or lose continuity. | Bound accumulation before copying, grow geometrically, classify fixed failure reasons, preserve explicit recovery and never switch accounts, reset history or replay uncertain work automatically. |

Nearby ContexGin validation fallbacks, host attempts to inspect sandbox paths,
and server event-loop warnings were observed. They are not proven causes of the
oversized native response. This repair does not alter their contracts or claim
to have resolved those separate warnings.

Replacement-owner races and failures while delivering an error were reproduced
in offline regressions; they are not claims that either happened in the incident.
Cleanup now runs even if reporting fails, and late completion notifications do
not forget a replacement owner. Startup admission itself is a one-shot outcome.
It settles before skill notification delivery, so an observer failure cannot
strand the HTTP admission waiter.

## Runtime contract

`CodexConversation.contextRequest` enforces `excludeTurns: true` for resume and
fork. This covers initial attachment, reconnect, accepted-thread ownership repair
and web-search policy changes. Migration validation uses the same explicit flag.
The native runtime still loads its execution history internally; the flag only
excludes historical turns from the response. Mitzo displays its durable event
stream. Recovery uses paginated `thread/turns/list` with `itemsView: notLoaded`.
Do not introduce full-history hydration into those execution paths.

The frame bound remains in force for individual messages. An oversized live
event is still rejected and must not be mistaken for a safely retryable turn.
Accepted or ambiguous provider work retains its existing recovery fences.
Metadata-only resume does not authorize another account, change provider thread
identity, grant tools, bypass ownership, or clear startup uncertainty records.

Framing diagnostics contain fixed reasons only: `frame_too_large`,
`invalid_json`, `invalid_envelope`, or `notification_handler_failed`.
`transportFrameBytes` is the observed complete frame size or the accumulated
prefix that crossed the bound, not necessarily the total upstream response size.
`pendingRequestMethod` identifies the sole outstanding RPC when unambiguous; an
oversized notification may arrive during that RPC, so it is not proof of the
rejected frame's method. Raw frames, callback exception text, credentials, tool
arguments and upstream errors must not enter public messages or telemetry.

## Verification and recovery

Focused offline regressions cover retained completed commands, same-thread
follow-up admission, cold and idle resume, policy changes, migration validation,
fragmented UTF-8, coalesced frames, precise failure diagnostics, either startup
error delivery order, one persisted error, failed-receipt retries, and cleanup
that preserves a replacement owner and saved application history.

`scripts/test-codex-metadata-resume.py --codex /path/to/pinned/codex` exercises the
native contract with synthetic history in disposable homes. It requires the
repository's runtime version, has no credentials and cannot send `turn/start`.
It verifies that a full resume exceeds the bound while metadata-only resume
keeps the original thread and its inspectable native history.

Before activation, require CI and the repository's exact-head review gate.
Production deployment remains a separately authorized operation; staging on the
configured Mac remains stood down. No production configuration is a test fixture.

After authorized deployment, normal explicit sends should resume the retained
thread. Keep historical error events, checkpoints, native history and uncertainty
records. Exact retries of failed HTTP receipts remain failed; a new explicit send
has a new command identity. Do not delete the old conversation, reset its binding,
fork it merely to reduce response size, or replay failed/uncertain work as a
recovery shortcut. No live continuation or production activation is claimed by
offline verification.
