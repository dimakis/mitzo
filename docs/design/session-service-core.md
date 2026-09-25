# Durable child session allocation (O2 core)

`SessionService` in `server/session-service.ts` owns the child allocation ledger and
start outbox. The canonical conversation is still the EventStore `sessions` row:
the same immediate SQLite transaction inserts the conversation and its child
link before any runtime setup. The service does not start a model by itself.

The host must authenticate the actor, resolve an existing parent and effective
account/model/effort, task scope, grant revision, and budget ceilings, then call
`recordHostGrant`. A model tool argument is not an authority source. An exact
`(parentConversationId, idempotencyKey)` retry returns the original allocation;
different normalized input conflicts. The input hash covers the prompt,
binding, effort, task/plan pins, grant, mode, scope, and isolation policy.
Allocations default to independent workers; Symposium sharing needs an
explicit host grant.

`reconcile` inspects the runtime before an allocated start and passes a
generation-bound `admitExecution` callback. Runtime adapters must call this
callback immediately before provider dispatch. An uncertain prior start or
expired start lease becomes `recovery_required` with persisted cancellation
intent; elapsed time alone never authorizes another provider attempt. Late
runtime attachment after cancellation is stopped again. `cancelChild` and
`revokeHostGrant` persist revocation before stop/reconciliation. The typed
result mailbox accepts writes only from the matching running generation.

The current slice is a ledger and runtime interface. Host API wiring, scoped
tool enforcement, provider-specific adapters, and startup outbox recovery are
separate integration work. A persisted grant alone does not permit execution:
the host's current-authority resolver must check durable parent/task lifecycle
and account policy at each dispatch. Socket detach is not revocation; explicit
stop is. Existing taskboard parents with no recorded grant require an explicit
new host-authorized start decision and are never silently upgraded.

Budget ceilings are per parent/grant (children, concurrent children, depth,
and spawn rate). There is no global worker scheduler or extra conversation
truth. The service uses the existing EventStore database; all tests use fake
runtimes and make no model calls.
