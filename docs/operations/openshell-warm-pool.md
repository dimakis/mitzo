# Configurable provider-neutral warm sandboxes

More → Sandboxes exposes saved pool settings and observed inventory. Opening the
page makes no allocation and starts no model. The pool starts disabled, with a
one-spare target. Operators can choose one or two, automatic/manual replenishment,
30-minute/two-hour inactivity release or indefinite retention, and CPU/memory limits.
The installed CLI has no disk-limit flag: disk remains Runtime default with an
unavailable explanation, and the API rejects a fabricated disk setting.

## Enrollment and scope

This is source implementation and offline qualification. No service, staging,
production or real sandbox was activated as part of this change, and no end-to-end
latency gain has been measured. Staging and its pipeline remain stood down.

On a separately selected and authorized host, `MITZO_OPENSHELL_WARM_POOL_ENABLED=1`
permits operator preparation. It does not itself turn warming on. Save settings
with warming enabled, or explicitly Prepare now, to allocate resources. An existing
saved enabled policy resumes after a restart on an enrolled host. Disabling host
enrollment prevents new claims/preparations; existing claimed ownership remains
available to its conversation while its exact runtime identity still matches.

The initial adapter supports ordinary OpenShell API-account Codex execution with
the existing legacy CLI contract. Native OpenShell 0.1 seats, native subscription
routes, shared sandbox overrides and artifact-mounted Symposium routes retain their
existing on-demand paths. A pool recipe is scoped to the exact CLI/environment,
gateway, workspace, image, policy digest, workdir and stack contract. Configuration
metadata is not evidence that an unsupported route can claim a spare. Additional
runtime classes require separate qualified adapters, not placeholder accounts.

CPU and memory are requested per sandbox through the native create flags. The
saved limits also apply to compatible cold allocations on an enrolled host;
existing retained sandboxes keep their creation-time limits. The
calculated pool ceiling is requested capacity, not a hardware reservation or a
measurement of actual utilization. Claimed conversation resources are outside the
spare ceiling. Live qualification must verify the selected driver enforces limits
and provider-free creation before enabling this on a real target.

## Operator behavior

- Save is revision-fenced; Cancel discards the draft. Failed saves keep it visible.
- Automatic preparation fills the target at enable/save and after claims. Manual
  mode fills only on Prepare now or explicit replacement.
- Pausing retains spares and conversation sandboxes. A compatible retained spare
  can still be claimed. Removing one unused spare pauses warming for the pool.
- Reducing the target retires only excess unclaimed resources. Changing CPU or
  memory retires unused spares and prepares the new recipe when automatic warming
  is enabled. Existing conversations retain their original resources and data.
- Inactivity expiry releases unused Ready spares and rests the pool rather than
  immediately creating replacements. A compatible new chat or Prepare now wakes
  it. Uncertain resources are retained, count against the ceiling and require review.
- Spare details expose ownership, resources and provider-unassigned status.
  Unverified resources offer explicit recheck. Authoritative absence releases the
  reservation without deleting anything; a late resource is adopted only with the
  exact neutral origin, runtime scope and physical identity, then observed Ready.
  Transport failures and unexpected providers preserve uncertainty.
- Conversation details open the owning chat. Cleanup uses the existing lifecycle
  preview/confirmation service and its checkpoint, active-work, queue and retention
  checks. The page does not add immediate deletion or bypass that policy. A late
  preview cannot become an action for another selected conversation.

A busy pool never adds a preparation wait to admission: new chats use the ordinary
cold path if no claim can be admitted immediately. Replenishment is single-owner;
a ready second spare cannot be claimed while that controller holds an in-flight
pool operation. This bounds this first adapter's concurrency rather than promising
parallel provisioning. A future resource-level reservation can improve burst hits
without relaxing ownership or uncertainty accounting.

## Ownership and knowledge

The private `openshell-warm-pool.db` ledger records settings, revisions, physical
IDs, operation reservations and claims. The host holds an exclusive controller
lock. A dead owner's lock is retained as evidence before startup recovery;
another live or unverified owner blocks startup. Interrupted preparation, claim
and removal become uncertain, never Ready or automatically retried. A successful
native create receipt persists its physical ID before waiting for readiness.

Unclaimed resources carry immutable `mitzo.warm_pool` origin labels and no account
or conversation labels. The ledger atomically assigns a physical resource to one
conversation/provider before any account attachment. Only a confirmed exact
physical ID and complete attachment result makes it claimed. Effective runtime
ownership is projected from that durable claim plus current physical origin/scope;
ordinary unpooled ownership label checks remain unchanged. A claimed resource
never re-enters the spare pool, even on failed initialization or cancellation.
Do not edit the ledger or gateway labels to repair uncertainty.

Preparation freezes and verifies the configured shared knowledge seed into a
separate pool-knowledge area. Claim selects and uploads fresh initial workspace
content (or the independently admitted repository seed), attaches only the chosen
account and approved services, then hands off to existing native initialization.
Normal command-time knowledge reconciliation and provider ACK rules still apply.
A warmup never creates or inherits Slice 1's one-use initial-publication receipt.

`GET /api/sandboxes` observes resources without provisioning; it reports unverified
state if physical identity or provider-free readiness cannot be established.
`POST /api/sandboxes` requires interactive operator authentication, a revision and
an idempotency key. Agent/internal tokens are insufficient. Exact request retries
reuse the durable response; changed inputs cannot reuse its key. Unknown outcomes
retain capacity and ownership and must be inspected before another mutation.

## Validation

The focused offline suites cover settings persistence, capacity, stale saves,
idempotency, claim/account/physical identity, manual refill, expiry, uncertainty,
resource changes and exclusive host ownership. Existing knowledge/native lifecycle
regressions remain part of acceptance. Model and native subprocesses are mocked.

`tests/offline/sandboxes.spec.ts` mounts production components, shells and styles
with all traffic intercepted. It covers More navigation, Save/Cancel/refused writes,
provider-neutral details, blocked active cleanup, visible modal failures, pause on
removal, responsive 320px/1280px layouts, light Teal/Georgia and dark Mint/System,
larger text, native modal dismissal and 44px effective touch targets. It starts no
backend, provider or model. Full app builds and broad browser coverage remain CI
requirements.

Any real model test requires a supported Luna model, with the exact model and
charged account stated beforehand. Live testing requires a separately authorized
target; never use production or stood-down staging as an automatic fallback.
Production deployment and real pool activation require a separate user action.
