# Symposium implementation

Telos parent: `6403fb22f9bb743c`. Phase 1: `f25ad2749b4a1504`.

## Product contract

The 7 September discussion in **Design Mitzo symposium UX** is the current product
source. Symposium adds a second seat to an existing chat. Both desktop and mobile
use one conversation stream. Each prompt can target Seat 1, Seat 2, or both; the
director explicitly chooses which prior context is delivered. Pre-PR code and
artifact review is the initial workflow. Profile, connection, model, and context
or tool grants remain separate choices. Profiles can be drafted conversationally
and saved to a reusable catalog without credentials or session-specific grants.

See also `../design/workspace-redesign/mitzo-redesign-launch-plan.md`.

## Foundation delivered by this change

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
- recipient attempts retain stable execution idempotency keys, results, cost,
  errors, and provider-thread IDs;
- provider conversations are reused only for the same account/profile/grant and
  isolation binding. A grant or binding revision starts a new thread;
- cancellation is persisted before in-process abort/cancel signals are issued;
- a restart changes in-flight work to `recovery_required`. An explicit retry uses
  the original execution key so an idempotent executor can reconcile an ambiguous
  provider outcome without silently starting a second turn; and
- turn admission is reserved transactionally, so concurrent dispatch cannot exceed
  the configured cap.

The orchestrator fails closed for draft/stale configurations, unadmitted providers,
unsupported scheduling modes, changed grants, and missing executors. Both seats
remain inside the single Symposium trust domain established by Phase 1; this change
does not introduce per-seat sandboxes or brokered federation.

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
