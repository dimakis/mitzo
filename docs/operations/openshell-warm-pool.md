# Configurable provider-neutral warm sandboxes

More → Sandboxes exposes saved pool settings and observed inventory. Opening the
page makes no allocation and starts no model. The pool starts disabled, with a
one-spare target. Operators can choose one or two, automatic/manual replenishment,
30-minute/two-hour inactivity release or indefinite retention, and CPU/memory limits.
The installed CLI has no disk-limit flag: disk remains Runtime default with an
unavailable explanation, and the API rejects a fabricated disk setting.

## Enrollment and scope

The initial implementation was qualified offline. A separately authorized
production benchmark on 16 October measured a regression: median first visible
output was 10.45 seconds cold and 21.18 seconds warm across five pairs. See
[the timing diagnosis](../diagnostics/warm-pool-latency-2026-10-16.md).
The source fixes below have offline qualification; post-fix live timings remain
outstanding. Staging and its pipeline remain stood down.

The application fixes support the existing pinned supervisor and need no OpenShell
upgrade or credential migration. Qualify a Mitzo application release against that
existing stack first. The separate supervisor wake-up patch is optional and
deferred pending those measurements; actual provider refresh can still take a
normal supervisor polling cycle with the existing image.

On a separately selected and authorized host, `MITZO_OPENSHELL_WARM_POOL_ENABLED=1`
permits operator preparation. It does not itself turn warming on. Save settings
with warming enabled, or explicitly Prepare now, to allocate resources. An existing
saved enabled policy resumes after a restart on an enrolled host. Disabling host
enrollment prevents new claims/preparations; existing claimed ownership remains
available to its conversation while its recorded runtime authority still matches.
If adapter configuration cannot be read on an unenrolled host, the pool remains
unavailable without preventing server startup. Its ledger and settings remain
retained; no recipe or physical access authority is inferred. An enrolled host
rejects invalid adapter configuration and releases its own startup lock.

The initial adapter supports ordinary OpenShell API-account Codex execution with
the existing legacy CLI contract. Native OpenShell 0.1 seats, native subscription
routes, shared sandbox overrides and artifact-mounted Symposium routes retain their
existing on-demand paths. A pool recipe is scoped to the exact CLI/environment,
gateway, workspace, image, policy digest, workdir and stack contract. Configuration
metadata is not evidence that an unsupported route can claim a spare. Additional
runtime classes require separate qualified adapters, not placeholder accounts.

The ledger also pins a separate CLI/environment, gateway/endpoint, workspace and
workdir authority. Updating the image, policy or seed/stack recipe does not revoke
verified access to an existing physical resource. Its original recipe remains
recorded; matching authority plus exact origin, physical ID and account permits
inspection for the existing migration/cleanup owners. This is not attestation that
the old resource satisfies the new recipe: normal physical image, policy,
knowledge, custody and migration checks still apply before adoption. Obsolete
spares cannot be claimed. Operators can recheck, remove or replace verified old
spares; automatic refill retires settled obsolete Ready spares before filling the
new recipe. Uncertain operations continue to reserve capacity. Different runtime
authority stays blocked. Historical rows without separate authority require their
exact original recipe; never infer or backfill missing authority from current
configuration.

Pool and conversation CLI subprocesses share one environment builder: an explicit
private environment is validated and used alone; otherwise only PATH, HOME,
TMPDIR, LANG and LC_ALL are inherited. Ambient XDG or credential variables do not
select another pool namespace. Recipe/access hashes bind the effective environment.

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
  A fresh verified retirement capability exposes Replace/Remove for obsolete
  Ready spares even in paused/manual pools; these actions still recheck exact
  ownership in the backend, and removal requires confirmation. Unsettled or
  physically unverified resources keep retirement hidden.
  Unverified resources offer explicit recheck. Authoritative absence releases a
  pre-create reservation (or a previously settled physical resource) without deleting
  anything. A dispatched create with no terminal physical receipt stays uncertain; a late resource is adopted only with the
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
lock. An OS-backed SQLite transaction serializes the complete stale-owner
takeover, including publishing the replacement owner. A dead owner's lock is
retained as evidence before startup recovery;
another live or unverified owner blocks startup. Interrupted preparation, claim
and removal become uncertain, never Ready or automatically retried. A successful
native create receipt persists its physical ID before waiting for readiness.
Create dispatch is persisted before the CLI call, separately from seed preparation;
missing historical dispatch evidence is treated as unknown, never as not started.

Generated spare names fit the legacy CLI’s 19-character limit; the ledger and
origin label retain the full UUID independently of that compact physical name.
Unclaimed resources carry immutable `mitzo.warm_pool` origin labels and no account
or conversation labels. The ledger atomically assigns a physical resource to one
conversation/provider and connection account ID before any account attachment. Only a confirmed exact
physical ID and complete attachment result makes it claimed. Effective runtime
ownership is projected from that durable claim plus exact physical origin and recorded runtime authority;
ordinary unpooled ownership label checks remain unchanged. A claimed resource
never re-enters the spare pool, even on failed initialization or cancellation.
Account-scoped connection cleanup resolves this durable account through the same
gateway/workspace and a fresh exact physical-origin check. Missing authority
blocks partial cleanup rather than stopping another account's conversation.
A failed initial workspace upload, provider attachment or final claim inspection
keeps the resource assigned to its original conversation/account. A normal
retry of that conversation may finish this pre-initialization binding in place:
it rechecks the original recipe, runtime authority, physical ID and exact allowed
provider subset under the exclusive controller. Only missing allowed providers
are attached, and the complete final set must be observed before native startup.
No model/client has started in this uncertain claim phase; initialized/claimed
resources never enter this seed retry. Changed account, recipe, physical identity,
extra providers, cancellation or unavailable authority remains blocked and owned.
Inventory reads never trigger recovery. No failed claim is recycled or replaced.

Usage telemetry separately joins physical list observations to exact durable
conversation ownership across account IDs. It includes owned uncertain claims as
physical usage, excludes neutral/foreign spares, and reports identity failures
rather than silently dropping a substituted resource. This read-only projection
confers no account-bound execution or cleanup authority.

Do not edit the ledger or gateway labels to repair uncertainty.

Preparation freezes and verifies the configured shared knowledge seed into a
separate pool-knowledge area. Claim selects and uploads fresh initial workspace
content (or the independently admitted repository seed), attaches only the chosen
account and approved services, then hands off to existing native initialization.
Normal command-time knowledge reconciliation and provider ACK rules still apply.
A warmup never creates or inherits Slice 1's one-use initial-publication receipt.
For a new explicit command, the manager can select and freeze the fresh claim seed
under durable claim ownership, then share that exact selection with its first
turn after physical/account verification. Empty/busy pools do not select a claim
seed. Retained claims, recovery and external seeds do not acquire this receipt;
it is consumed before any adoption await, including failure and cancellation.
The frozen upload is released after the owning ensure settles.

Native launch checks the required provider environment in the actual exec shell.
If it is not yet available, only pre-initialization launch is retried, at most
every 500 ms within a 20-second window and the existing RPC timeout. Closing the
client cancels pending retries. This removes unconditional ten-second sleeps;
it does not bypass the supervisor's actual provider propagation or replay turns.

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
