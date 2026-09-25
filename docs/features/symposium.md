# Symposium implementation

Telos parent: `6403fb22f9bb743c`. Phase 2.5: `c10fc341b0533a54`.

## Product contract

The 22 September Phase 2.5 decision supersedes the earlier two-seat limit.
Symposium starts as one chat and can admit a bounded set of stable seats. Both desktop and mobile
use one conversation stream. Each prompt can target explicit seat IDs; the
director explicitly chooses which prior context is delivered. Pre-PR code and
artifact review is the initial workflow. Profile, connection, model, and context
or tool grants remain separate choices. Profiles can be drafted conversationally
and saved to a reusable catalog without credentials or session-specific grants.

See also `../design/workspace-redesign/mitzo-redesign-launch-plan.md`.

## Foundation delivered by this change

The following records the historical Phase 1 and 2 contract. Version 1 remains
readable and executable until an explicit revisioned upgrade.

- Exported a canonical validated account-binding schema using Mitzo's supported
  provider identities, rather than accepting arbitrary provider strings.
- Versioned two-seat configuration with stable primary/reviewer roles, separate
  account and profile bindings, explicit context/authority grants, requested
  isolation placement, turn limits, and manual/automatic interception mode.
- Draft configuration permits lazy reviewer setup without authority. Active
  configuration requires complete bindings and grants for both seats.
- Typed activation retains the existing session binding as Seat 1 and requires
  monotonically increasing configuration revisions. Deactivation returns the same
  session to ordinary chat without losing history.
- Exported immutable delivery provenance fields for later orchestration and replay:
  configuration, account/profile, context/authority, and isolation-domain revisions.
- Additive SQLite migration for session type/configuration and event seat identity.
- Configuration may be attached to or removed from an existing session without
  changing its ID, transcript, account binding, or other metadata.
- Optional `StoredEvent.seatId` is derived from the append payload, persisted, and
  returned by full and cursor-based replay. Ordinary events retain their shape.

The type/configuration contract does not execute models or enforce grants. A draft
seat without an account reference is unbound; later runtime integration must resolve
a connection explicitly before execution. Schema validation checks configuration
shape and activation completeness, not account ownership, current model availability,
tool-policy enforcement, or data visibility. Callers should use the typed
`setSymposiumConfig` activation path rather than writing serialized configuration.

OpenShell permits multiple providers to be attached to one sandbox, including with
repeated `--provider` flags at creation or attach commands at runtime. Those
attachments and their composed policy are sandbox-wide for newly launched processes;
they are not per-seat isolation. Ordinary Mitzo conversations attach one
account/inference provider by default. An explicitly shared Symposium is different:
the Symposium sandbox is the declared trust boundary and may attach multiple seat
providers after explicit admission. Every admitted seat shares the sandbox's
artifacts and effective provider/tool policy. If the user or organisational policy
does not accept that sharing, the additional seat cannot join that Symposium;
brokered multi-sandbox federation is outside v1.

## Phase 2 control plane

Phase 2 (`b0d963167545a7a7`) adds a deterministic directed/manual state machine with
an injected `SymposiumSeatExecutor` boundary. No production provider or OpenShell
implementation is selected here. Tests use fake executors whose stable execution
keys model the idempotency contract required of a later adapter.

Mitzo's SQLite event database now owns the durable control-plane record:

- every admit/refuse decision identifies the seat, provider, account, model,
  configuration revision, and the one shared isolation-domain revision;
- a staged delivery retains its original content, selected recipients, immutable
  source/target grant provenance, and the approved, edited, or replaced content;
- approve, edit, replace, drop, and retry interventions remain as append-only
  history even though the delivery row exposes the latest state;
- an append-only recipient-attempt ledger retains stable execution idempotency
  keys, results, cost, errors, and provider-thread IDs across retries;
- provider conversations are reused only for the same account/profile/grant and
  isolation binding. A grant or binding revision starts a new thread;
- cancellation is persisted before in-process abort/cancel signals are issued;
- server startup changes in-flight work to `recovery_required`. An explicit retry
  uses the original execution key so an idempotent executor can reconcile an
  ambiguous provider outcome without silently starting a second turn; and
- turn admission is reserved transactionally against the append-only attempt count,
  so failed attempts and concurrent dispatch cannot exceed the configured cap.

The orchestrator fails closed for draft/stale configurations, unadmitted providers,
unsupported scheduling modes, changed grants, and missing executors. Both seats
remain inside the single Symposium trust domain established by Phase 1; this change
does not introduce per-seat sandboxes or brokered federation.

## Phase 2.5 membership foundation

Version 2 configuration has a validated active-seat cap (1–8), a stable anchor seat
ID, and role labels independent of array position, account, model, effort, profile,
and grants. A session may begin with only its anchor and add seats later. Configured
historical seats remain in the document after suspension or removal; only active
membership consumes the cap. An upgrade preserves the original Seat 1 identity and
account binding. A v2 configuration with membership history cannot be deactivated
into ordinary chat, which would erase the identity context required to interpret
its ledger. Existing v1 event and delivery rows are never rewritten.

Membership transitions are append-only SQLite rows. An immediate transaction
compares the expected per-seat generation, reserves capacity, and on revocation
cancels queued, staged, approved, and executing recipients before returning. The
anchor cannot be revoked without a separate transfer contract. Suspension can be
restored only with a fresh generation and current provider admission. Removal is
terminal for that seat identity; replacement creates a distinct seat linked to its
removed predecessor. A changed account/profile/model/effort/grant/isolation binding
uses a different thread key and cannot silently reuse the prior thread.

An activation remains `pending` until a current-generation provider decision is
recorded and the runtime reconciliation callback confirms the required provider
set. Refusal or missing approval cannot attach a provider. On revocation, the
orchestrator persists the fence first, then asks the injected stop and provider-set
interfaces to reconcile. The provider set is the union of admitted active seats and
other authoritative retained grants supplied by the caller. A failed or missing
cleanup interface leaves `recovery_required`; admission and dispatch stay blocked
until `reconcileMembership` confirms that same generation. Restart does not turn a
pending or uncertain row into operational success. A refused pending seat can be
removed and reconciled without erasing its refusal; only the latest generation
blocks new admissions. Provider reconciliation is serialized per session for
orchestrators sharing the same event store, so a late activation is followed by
revocation cleanup rather than silently reopening the provider.

Recipient snapshots and seat event provenance carry membership generation in v2.
The execution claim transaction checks current configuration, binding, provider
admission, and generation. Revoked recipients cannot use stale approvals or retries.
Late provider output is retained in a separate audit ledger with its cost and
original recipient, while the cancelled delivery remains cancelled. The shared
turn cap and historical attempt ledger are retained; usage includes late-result
cost across suspension, replacement, and restoration. These tests use fake executors;
actual process shutdown and provider attachment are Phase 3 responsibilities. The
shared OpenShell boundary does not provide per-seat credential, artifact, or egress
isolation, and revocation cannot retract data already seen.

## Phase 4 attribution foundation

New v2 seat events pin an immutable execution snapshot: stable seat ID and
membership generation, display label and role, exact account binding/model/effort,
profile binding, context and authority grant IDs/revisions, trust-domain revision,
configuration revision, and capture time. Event append validates that snapshot
against the admitted seat before accepting a new stream event. Existing unversioned
v1 provenance remains readable as the fields originally stored; replay never fills
unknown labels or account choices from today's configuration. The same stored
snapshot survives reconnect-cursor and full-session event reads after a seat is
renamed or its role changes.

Recipient claims retain their stamped snapshot in the existing attempt ledger.
When revocation fences a claim, a late provider result stays in the existing
late-result audit ledger with that original snapshot and cost; it cannot revive
the cancelled delivery. An active seat cannot change its label, role, or binding
without first revoking membership; revocation cancels the claim. The event append
boundary rejects any subsequent stream chunk under that stale generation, and the
caller must retain the provider's late outcome in the audit ledger rather than
silently presenting it as a live message. During upgrade, a still-live historical
claim supplies its durable token to the matching executing attempt, so later
revocation cannot erase the evidence needed to audit its result and cost. Its
provenance stays unknown. A claim already revoked before upgrade has no provable
token and is not reconstructed from current configuration. This is protocol and
persistence groundwork only. Client
demultiplexing of simultaneous seat streams and attributed ChatView rendering are
still required before Phase 4 is complete.

Next, integrate provider execution and websocket controls (Phase 3), followed by
seat-attributed rich rendering and controls in the existing ChatView (Phases 4–6).
The old Phase 6 separate-session creation wording is superseded by add/remove seat
within a chat. Review findings, delta review, profile catalog, context selection,
and account/model selection need explicit coverage in those slices. Account/model
availability must reuse the existing connection infrastructure.

## Existing PR reconciliation

PR #446 contains an older Phase 1 implementation plus unrelated transport changes.
This clean implementation on current main replaces its foundation scope without
bringing those changes forward. #446 is not a required stacked dependency. It has
not been closed or modified by this change.

No runtime, UI, model calls, or production deployment are included in this first
slice. The Telos parent and later phases remain unfinished.

## Concurrent directed dispatch

V2 directed deliveries may execute independent admitted seats concurrently, bounded
by the configured roster and existing durable turn reservations. Each seat still
uses its exclusive execution claim and provider thread. V1 retains its sequential
dispatch behavior. Results from already-running seats remain recorded if another
recipient fails; failed turns still require explicit intervention before retry.

Within one shared Symposium boundary, filesystem or tool write authority conflicts
with other writers. The existing SQLite claim transaction refuses a second writer
across orchestrator instances. Pending work returns to `ready` once no recipient
is executing, so the host can drain approved work after the resource is released.
Unconfirmed revocation cleanup also blocks new writers, including after a restart.
This scheduling rule does not enforce a provider's tools: runtime admission must
still enforce the declared authority. It adds no per-seat sandbox isolation.

Resource reservations persist on the existing recipient attempt until its executor
returns a completed result or confirms cancellation. Cancelling a delivery or
marking it recovery-required does not release this reservation. A second host
therefore cannot infer that a recovered writer has stopped. Failed multi-seat
deliveries cannot be retried while any attempt still has unconfirmed cleanup.
Executor cancellation must resolve only when further native operations are
impossible; missing or failed cancellation retains the reservation for recovery.
