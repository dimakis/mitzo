# Staging pipeline and host budgets

The canonical app remains `http://mitzo-staging.localhost:3190` with the single
`com.mitzo.staging` service. Pipeline state lives separately in the private
`~/.local/share/mitzo-staging-pipeline/queue.db`, so resetting staging does not
silently erase queued requests or custody uncertainty. No new background service,
VM, sidecar, scheduler or provider connection is installed by the CLI.

## Session and pipeline contract

Run offline feature tests and existing PR review/CI concurrently, with local
workers bounded for the host. After acceptance, run:

```sh
node scripts/staging-pipeline.mjs enqueue --pr NUMBER --task SESSION_ID
node scripts/staging-pipeline.mjs status
node scripts/staging-pipeline.mjs receipt --id REQUEST_ID
```

Enqueue reads the actual merged PR commit through GitHub CLI; it accepts no
candidate SHA, shell command, model or account override. Repeated identical
requests are idempotent. This initial cut exposes the post-merge pipeline step;
MGMT's paired merge-gate handoff can submit it automatically after a successful
head-fenced merge when the host enrolls a clean accepted controller checkout,
its exact source commit and an explicit Node executable. An absent/refused
handoff leaves staging pending; retry performs enqueue only, never another merge
or deployment. Until that paired wiring is accepted and enrolled, the session
that merges submits this command explicitly. Future
feature test suites require their own reviewed contract and fresh staging
account enrollment. The current receipt is **HTTP readiness**, not feature proof.

Once the queue database is enrolled, canonical prepare/deploy commands require
the active reservation, bound target and admitted dispatch before apply. Direct
session commands cannot replace that baseline without the matching queue grant.
Read-only checks remain available without a grant.

One designated foreground controller, from clean exact current accepted source,
processes one request per invocation:

```sh
node scripts/staging-pipeline.mjs host-resources
node scripts/staging-pipeline.mjs run-next
```

The controller verifies accepted ancestry, binds the actual selected main tip,
checks canonical stage integrity, and uses existing prepare/plan/apply commands
when deployment is needed. It keeps the queue reservation until the selected
source is verified before and after the test. Requests cannot change the test
suite to run arbitrary code, enroll a provider or issue inference. Native or
owned topologies unsupported by the existing controller remain fenced.

The resource observations include macOS pressure level, memory-pressure reported
free percentage, swap, free disk and aggregate staging/quarantine disk use.
Missing/unknown observations refuse admission. Conservative defaults are normal
pressure, 25% reported headroom, swap <=2 GiB, free disk >=20 GiB after proposed
growth and aggregate stage/archive <=48 GiB. New preparation reserves the full
observed active release size rounded up to GiB plus a 2 GiB build margin, then
rechecks actual use afterwards; this is admission accounting, not an
OS-enforced filesystem quota. If the build exceeds its projection, additional
work stops pending investigation/retention planning. Historical archives are not
deleted to make admission pass. The VM maximum is 4096 MiB/two CPUs. Source
builders propagate a 2048 MiB V8 heap bound; the ordinary app gets 1024 MiB.
Deployment also reserves the complete logical workspace/state backup size, filesystem metadata and a 64 MiB controller/receipt allowance. Sparse files, hard links and COW copies receive no savings credit. The canonical apply command remeasures admission before shutdown and after the confirmed drain, before copying; a reused release still needs this backup allowance.
These limits preserve headroom but do not guarantee a whole-host memory cap or
control unrelated applications, provider processes or other agent sessions.
The initial test is one bounded GET and creates no provider/task/native resources.

## Waiting, cancellation and uncertain outcomes

Capacity shortage before dispatch returns the request to queued `host-resources`.
An expired original token cannot dispatch, test, finish, defer or release capacity. Expiry permits only retaining its exact original reservation for explicit reconciliation; no replacement is inferred.
If a deployment completed and the subsequent canonical check confirms its exact
source and integrity, the controller can wait before testing without fabricating
native retirement. A normal failed GET has no cleanup obligation and records a
failed readiness result. Test baseline drift or uncertain deployment keeps a
quarantined reservation. Deadlines signal reconciliation; they never grant a
replacement lease or permit deletion of `deployment.lock`.

```sh
node scripts/staging-pipeline.mjs cancel --id REQUEST_ID
```

Only unclaimed queued requests can be cancelled. No CLI command fabricates a
passing result, resets an active reservation or reclaims native ownership.
Investigate the saved operation and actual owner; perform separately qualified
reconciliation before replacing uncertain work. Requests and terminal summaries
are bounded by a 16 MiB database ceiling; a full database refuses more work and
requires an explicit archival/retention decision. Status prioritizes active and
queued requests over old summaries. Keep any selected receipt needed for release
qualification with that pipeline task's artifacts.

`receipt --id` reads the exact retained request independently of the bounded
status summary. It opens an enrolled database read-only and never creates a
queue, claims work, or changes custody. Its version-1 JSON contains `requestId`,
`pr`, `taskId`, `acceptedCommit`, `suite`, `state`, `reason`, and `result`.
Queued and active requests have no result; quarantined and cancelled requests
also provide no passing evidence. A missing request or absent database returns
only `version`, `requestId`, and `state: "missing"`. Refused or uncertain reads
fail instead of manufacturing a missing or passing result.

A settled result retains its `outcome`, original `acceptedCommit`, actual
tested `sourceCommit`, `suite`, reservation `epoch`, `cleanupConfirmed`, and
`completedAt` timestamp. Consumers must match the exact request, PR, task, and
accepted merge, require passed HTTP readiness and confirmed cleanup, and verify
that the tested source is the intended deployment candidate. A newer tested
main tip does not rewrite the original accepted merge or qualify an arbitrary
release. Feature and production acceptance remain separately required.

## Rollout and remaining integration

1. Accept the source and restore canonical staging through its qualified reset.
2. Qualify readiness under the real host budget and confirm one runner for concurrent
   submitters. The offline tests use eleven separate SQLite connections.
3. Accept and enroll the paired MGMT post-merge handoff, then add readiness-result
   consumption to its PR shepherd and production-admission workflow. Production
   deployment remains explicitly requested.
4. Enroll only required staging capabilities and implement bounded feature suites.
   Announce the supported exact Luna model and charged account before real tests.
5. Plan release retention separately: aim for active plus two reusable baselines,
   preserving releases referenced by uncertain operations. No automatic broad cleanup
   is part of this cut. Idle native shutdown also requires verified owned-resource
   closure; it cannot be inferred from an empty queue.

Existing sessions must reread accepted instructions before this policy can be
claimed as adopted. No cross-session messages or production operations occur here.

## Complete profile replica

The required replica includes personal ChatGPT, work OpenAI API, Vertex, and every profile added later. Resource limits bound simultaneous work; they do not omit a provider. Each reference profile must have a separate staging profile with the same provider, runtime, and feature capabilities, independently reviewed staging configuration, fresh staging authorization, and isolated fixtures. Production credentials and configuration are never copied.

`node scripts/staging-pipeline.mjs replica-check --reference PUBLIC_REFERENCE_JSON --stage PUBLIC_STAGE_JSON` compares bounded credential-free snapshots without changing staging or making model calls. Reference records contain exactly `id`, `provider`, `runtime`, and `capabilities`; staging records contain exactly `referenceId`, `profileId`, `provider`, `runtime`, `capabilities`, and `authorization` (`ready` or `pending`). New reference profiles automatically require corresponding staging records. Mismatch exits 2. A configuration match still reports `liveFeatureValidation: required`: HTTP readiness and declared capabilities do not prove live feature behavior.

Live model tests require an explicitly supported Luna model and announcement of the charged account. A provider/runtime without Luna requires explicit approval for its alternative model before testing. Provider enrollment and native capacity disposition remain separate reviewed prerequisites.

Prepared candidates are reused only after the canonical controller verifies the exact receipt, accepted source, artifacts, and dependencies. A terminal read-only plan refusal leaves undispatched work waiting; uncertain execution preserves the reservation. Mutations run through the verified current accepted checkout, with apply retaining its candidate byte-identity check.

The read-only `prepare --commit SHA --check-only` probe validates an existing
candidate before granting zero-growth reuse. An absent candidate reports the
observed copy/build growth estimate without creating a release or audit record.
Unknown observations or invalid retained candidates refuse the attempt. Reuse
still requires current host admission and exact canonical deployment planning.

The aggregate disk ceiling is 48 GiB so retained incident evidence is counted alongside the single replacement VM, rather than deleted or hidden. The measured 28.151802 GiB retained tree plus a conservative 16 GiB VM upper bound, two 1 GiB controllers and 1 GiB dependency/scratch allowance totals 47.151802 GiB. With 53.24353 GiB free before those allocations, projected free space remains above 34 GiB. These are admission projections; unknown additional scratch/provider artifacts must be measured and may refuse admission. The 20 GiB free-space floor and all memory/CPU/concurrency limits remain enforced.

## Atomic source merge admission

The paired mandatory MGMT merge gate uses this same private SQLite database to
serialize Mitzo source acceptance with foreground staging work. `merge-admit`
holds one exact PR/head admission in a `BEGIN IMMEDIATE` transaction. It refuses
an active staging reservation, including one whose deadline expired. An exactly
quarantined reservation can admit reviewed source repairs: the same transaction
captures the complete reservation and original quarantined request. Dispatch and
every terminal reconciliation must match that immutable tuple. This grants no
staging capacity, cleanup, restart or retirement; queued readiness remains
pending behind the original quarantine. Staging claim refuses a held source
merge. This includes preparation, so an admitted merge cannot strand a concurrent
candidate build or deployment. A benign staging preflight refusal can release its
existing undispatched reservation and wait.

MGMT then rechecks every current CI, Centaur, review-thread and exact-head gate
inside the admission. A blocked pre-dispatch review may release its original
token. Before its existing head-fenced GitHub merge, it consumes `merge-dispatch`.
This is permanent until actual GitHub reconciliation; time, owner loss, a lost
receipt or an OPEN PR cannot reclaim it or authorize retry.

`merge-reconcile --pr NUMBER` reads the actual PR head/state/merge commit and
verifies accepted ancestry. For the admitted exact merged head, it retains the
stable `http-readiness` request and clears the source fence in one transaction.
A full queue, changed identity, network error or unconfirmed outcome leaves the
fence held. An actually closed, unmerged exact PR is a terminal nonmerge outcome.
The accepted MGMT shepherd retries this reconciliation before readiness can be
reported complete; its separate retry CLI can also reconcile without merging.

Merge bookkeeping uses a clean pinned accepted ancestor controller, so a source
merge does not invalidate the original reconciliation implementation. Foreground
staging deployment continues to require the exact current accepted controller.
These are fixed operations with finite PR/head/epoch/nonce arguments; requests
cannot supply commands. There is no new worker, backend, service, expiry or stale
lock deletion. Status reports the held source admission without its nonce.

This atomic fence covers merges through the mandatory MGMT gate and this queue.
GitHub UI, unrelated clients and other hosts cannot be atomically excluded by a
local database without separately authorized GitHub-wide enforcement. This
implementation changes no repository protection or admin authority and must not
be presented as such enforcement. Accept the queue protocol, then the paired
MGMT change and enroll its clean accepted controller before using the new gate.
Missing/older/unqualified enrollment blocks a Mitzo merge rather than bypassing
the shared admission. Offline tests grant no host enrollment or live dispatch.
