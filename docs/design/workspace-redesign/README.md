# Mitzo workspace redesign

Approved design and implementation handoff, 8 September 2026.

Start with the [launch plan](mitzo-redesign-launch-plan.md). It defines delivery scope, acceptance criteria and corrections to the earlier sketches. The [desktop and implementation audit](mitzo-desktop-and-implementation.md) explains reuse and effort. Then read the [chat integration supplement](mitzo-existing-chat-designs.md), [design specification](mitzo-design-spec.md) and [screen inventory](mitzo-screen-designs.md).

## Decisions that govern implementation

- Deliver desktop and mobile together. Begin with the shared shell and Today; keep existing destinations usable throughout rollout.
- Tokens to goal is the stack's efficiency metric. Preserve token counters from day one; distinguish context occupancy, session spend, active goal spend and verified final tokens to goal. Navigation and presentation must introduce no model calls.
- Reuse the rich conversation renderer, provider controls, permissions, queues, task hierarchy and workflow actions. Do not substitute simplified mock messages for the existing implementation.
- SessionTray PR #462 supersedes closed #457. Recheck its current status before editing chat. Preserve the consolidated Outputs/Sources and attachment/context controls.
- The existing Symposium design task governs Add reviewer, profile/connection/model binding, selected review context, read-only review, structured findings and delta re-review. Generic two-seat sketches here show placement only; the launch plan records the detailed reconciliation.
- Define done must enrich/link the existing goal while retaining conversation and attributable prior spend. Complete cross-provider accounting is a separately tracked capability.
- Existing Inbox records are proposals, with archive behavior rather than unread or automatic execution semantics. Separate Mitzo sign-in, AI provider accounts and source connections; early SSO/connector sketches are conditional capability proposals.

## Visual references

[Mobile preview source](mitzo-design-preview.html) and [desktop preview source](mitzo-desktop-design.html) preserve the reviewed interactive design demonstrations. They are HTML fragments intended for the design preview host (optional Tweak/icon support), not production components or a claim that all depicted backend capabilities exist. The launch plan and decisions above take precedence over placeholder states in these previews.

## Delivery tracking

- **Parent** Mitzo — ship a coherent desktop and mobile workspace — TELOS `6466711fe5c6e276`.
- **Delivery 1** Mitzo — shared shell and Today — TELOS `d71e7c529322d7bf`.
- **Delivery 2** Mitzo — adapt chat around the existing renderer and SessionTray — TELOS `d9d8a265c4aef20f`.
- **Delivery 3** Mitzo — TELOS and agent taskboard presentation — TELOS `a4d34a98b4d20bbc`.
- **Delivery 4** Mitzo — proposals, Calendar and account/settings presentation — TELOS `121ff7c4f1cbc2c8`.
- **Linked follow-up** Mitzo — define goals in chat and make tokens to goal trustworthy — TELOS `9fc7bdfb6a9d81fd`.

Delivery 1 taskboard root: `962c3f0a-ad84-436f-841c-ba37bd621403` (created pending). Its `telos:` annotation links the delivery item; this is an execution-root ID, not a ContexGin registry goal ID. Reuse this root and do not promote the same item again. The remaining deliveries are backlog items; no loop has been started.

## First implementation slice

Use a clean worktree from main on `feat/workspace-shell-today`. Follow the repository's test-first branch/PR workflow. Reconcile existing shell/navigation and Today entry points, then write behavior tests before implementation. Land one focused shell/Today PR with desktop/mobile visual validation, existing destination navigation, light/dark presentation and preserved token access. No deployment is part of this setup.

Estimated first slice: 4–7 engineer-days, included in the 3–5 engineer-week UI envelope. Re-estimate after the first source inventory; capability additions are separate and must not double-count existing work.
