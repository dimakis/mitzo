# Sandbox cleanup and conversation removal

Conversation visibility, physical sandbox resources, and recovery archives have
different lifetimes. The UI must explain each operation before confirmation.

| Action                  | Chat                                | Physical sandbox                                                 | Recovery checkpoint |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------- | ------------------- |
| Archive chat            | Hidden from Chats                   | Retained; existing automatic cleanup settings still apply        | Unchanged           |
| Checkpoint and stop     | Retained                            | Stopped after a verified checkpoint                              | Retained            |
| Delete sandbox          | Retained                            | Deleted after checkpoint, stop and ownership verification        | Retained            |
| Delete chat and sandbox | Hidden only after verified deletion | Deleted through the same reviewed lifecycle                      | Retained            |
| Automatic retention     | Unchanged                           | Deleted after stopped retention, with separate persisted consent | Retained            |

These operations do not permanently erase saved conversation history or archives.
Archive never grants deletion consent. Explicit deletion does not grant future
automatic deletion consent and does not wait for the retention interval.

## Review and execution

`GET /api/openshell/lifecycle/:conversationId/preview?intent=delete` requests an
immediate deletion review. A ready retained sandbox produces `stop_and_delete`;
a stopped sandbox produces `delete`. The default preview remains the retention
policy review. Physical identity, generation, expiry, intent, and single-use
confirmation stay server-owned. A conversation-removal confirmation additionally
requires that the token belongs to that exact conversation and deletion intent.

Capture, checkpoint verification, stop, and deletion share the conversation
mutation fence. Protection and physical ownership are rechecked between steps.
Active sessions, queued/recovering work, Task Board owners, Symposium custody,
unknown state, and incompatible ownership continue to block changes. An explicit
delete does not override these protections. A partial stop or failed deletion
retains the chat and exposes a fresh review instead of claiming success.

`GET /api/sessions/:id/deletion-preview` describes removal without changing state.
`DELETE /api/sessions/:id` requires its `cleanupToken` for a managed sandbox and
hides the chat only after the service verifies deletion. `?archive=1` explicitly
selects the previous hide-only behavior. Unmanaged sandbox-backed sessions refuse
deletion and retain Archive. Removal authorization applies only to these exact
routes, preserving existing session-reader authorization. Bulk hide is labelled
Archive all chats and does not authorize sandbox deletion.

## Idle observation and retention

Close callbacks may be lost on process exit. Reconciliation therefore starts a
fresh idle interval for a retained record only after authoritative physical and
work protection checks pass. It does not backdate idleness from old activity.
Protected work clears that observation; a later unprotected observation starts a
new full grace period. Generation checks prevent an observation from overwriting
newer activity. Existing verified stopped timestamps survive restart.

The default automatic retention is seven days from verified stop, with a
five-day configurable minimum. It requires persisted per-conversation consent.
Details show consent, duration, and the stopped retention threshold. Enabling
consent explicitly explains that an already eligible sandbox may be deleted on
the next reconciliation. Checkpoint archives have no new expiry in this change.

## Complete inventory and older resources

Gateway counts come from the complete paginated physical workspace inventory,
including historical providers and unassigned sandboxes. They do not come from
the lifecycle ledger or provider-filtered telemetry. Exact physical IDs and names
identify ledger-backed conversations and spares. Unknown resources appear in
Needs ownership review; a matching name alone never authorizes management.

A failed gateway read means the physical count is unknown. Recorded pool and
conversation state can still be displayed, with an explicit unavailable message.
Listing older resources does not adopt them, manufacture recovery records, grant
consent, or authorize a bulk purge. Their ownership and recovery evidence must be
reconciled separately before destructive cleanup. No historical or hidden chat
is silently opted into deletion by this rollout.

## Validation

Offline service, route, and component regressions cover missing idle timestamps,
protected work, immediate deletion, token/conversation binding, checkpoint and
deletion failures, archive semantics, pagination beyond 100 records, unknown
inventory, and preservation of chat visibility until release succeeds.

The intercepted actual-component browser fixtures cover 320px mobile WebKit and
Chromium plus 1280px desktop Chromium, dark Mint/System and light Teal/Georgia,
keyboard focus, dialog dismissal/restoration, failure/Archive, layout bounds and
existing pool controls. They make no backend or model calls. Full frontend
type/build and complete application acceptance run in CI when the local 1 GiB
heap is insufficient. Production and stood-down staging remain unchanged.
