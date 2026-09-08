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

- Exported two-seat configuration schemas/types with stable seat identities,
  separate account references, turn limits, and manual/automatic interception mode.
- Additive SQLite migration for session type/configuration and event seat identity.
- Configuration may be attached to or removed from an existing session without
  changing its ID, transcript, account binding, or other metadata.
- Optional `StoredEvent.seatId` is derived from the append payload, persisted, and
  returned by full and cursor-based replay. Ordinary events retain their shape.

The type/configuration contract does not execute models or enforce grants. A seat
without an account reference is unbound; later runtime integration must resolve a
connection explicitly before execution. Schema validation checks configuration
shape, not account ownership, model availability, tool policy, or data visibility.
EventStore remains a low-level store for serialized configuration; callers must
validate configurations before accepting user input.

## Next implementation slice (test-first)

Phase 2 (`b0d963167545a7a7`): build the orchestrator with injected seat execution,
explicit delivery history, directed/round-robin turns, turn/cost limits, and manual
approve/edit/replace/drop. Preserve original and delivered content plus director
interventions. Test cancellation and retry behavior before connecting providers.

Then integrate provider execution and websocket controls (Phase 3), followed by
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
