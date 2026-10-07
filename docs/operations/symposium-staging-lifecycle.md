# Staging lifecycle

Use a single private staging registry for this operator's fresh owned trials. The
registry records lifecycle evidence; it cannot confer gateway, agent, artifact,
credential, or cleanup authority. Keep Symposium gateway custody separate from
ordinary account/runtime configuration. Production is outside this staging fleet.

## Prepare and launch

1. Select an isolated source checkout and exact reviewed build. Follow
   [owned release preparation](symposium-owned-release-preparation.md), including
   fresh gateway identity, private state and an empty task repository. Preserve
   active owners and their compiled files. Do not bootstrap against primary state.
2. Create one canonical, private directory (mode `0700`) for `staging.db`. Keep it
   outside the release, plan, repository, app home, gateway state, Podman home and
   runtime seed trees and every configured input path, including policy/profile
   files, TLS/JWT files, credential-file references, CA bundles and executables.
   Canonical symlink targets and future attestation paths are protected too;
   neither ancestors nor descendants may overlap. Choose
   the operator fleet capacity once (recommended: three fresh owned stages). Every
   supported staging launch must use that same directory and capacity. Changing
   capacity at launch is refused. Alternate directories and custom launchers are
   outside this enforcement boundary and must be reported as legacy exceptions.
3. Write a private `0600` registration JSON with exactly `registryDirectory`,
   `capacity`, `ownerChat`, `purpose`, `retentionReason`, and `reviewAfter` (Unix
   milliseconds). The review deadline must be in the next seven days. Use concise
   nonsecret labels. Never include credentials, auth payloads, environment dumps,
   provider logs, transcripts, or capabilities.
4. Supply fresh app authentication using the existing secure operator launch
   mechanism, with a loopback bind and isolated port. Run:

   ```sh
   node scripts/start-staging-custodian.mjs /absolute/plan/owned-release.json /absolute/staging-registration.json
   ```

The supported staging entry uses the existing release verification, exclusive
`launch.intent`, environment allowlist and fresh custodian constructor. A registry
slot is reserved **before** intent claim and bootstrap. The same process retains
the recording closure and native owners. There is no exec/restart handoff of that
closure. The registry captures owner/purpose/retention, plan path, source/build/
configuration identities, random launch ID, creation time, original instance and
controller generation. App replacement updates the generation of the same instance. Retirement also
reconciles its original custodian snapshot when attachment preceded shutdown but
the replacement child had not sent hello; a receipt alone cannot do this.

`launch_uncertain`, `active`, `retiring`, and `retirement_uncertain` all consume
capacity. A stale review deadline blocks new launches, including when capacity is
available. Process exit, an empty inventory, a timer, or a terminal model response
cannot release a slot. Read `launches` and `policy` in `staging.db` using a private
read-only SQLite connection; show expired `reviewAfter` values as stale. Do not
edit rows to work around a blocked launch. The registry intentionally has no
adopt, automatic successor, or force-retire API.

## Retention review and retirement

Before stopping any existing stage, establish its original launcher/control
authority and current owner identity; check active chat/browser dependencies and
outstanding controller/native creation, execution, artifact lease and publication
operations. Preserve consistent private evidence and task/workspace data with an
audit manifest. A database copy preserves history, not cancellation handles or
custody. Retention for historical evidence alone should end after qualified drain;
specific unresolved live diagnosis should have a named owner and review deadline.

Obtain explicit operator approval naming the environment, owned ephemeral resource
scope and expected consequences. Use only its supported original-owner shutdown
mechanism. For a newly launched stage, retain the original launcher's process
control handle. A discovered PID or listening port is never signal authority.
Shutdown fences work, drains the exact controller and retires original runtimes,
then drains/closes the gateway through the existing custody architecture.

The original owner writes `custodian-retirement.json` only after successful cleanup
and gateway closure. Only its process-local recording closure can mark the slot
`retired`, after reading and matching that receipt's instance and generation.
Uncertain cleanup or receipt persistence keeps the slot held. Preserve the
registry, intent, receipt, diagnostics, transcripts, task data and cleanup audit.
Verify exact owned-resource absence and refresh the allowlisted before/after
inventory. Never use broad kill, container prune, or deletion of retained workspaces.

## Limits and acceptance

Reopening the registry lists retained records; it does not restore the recording
closure or native custody. Custodian death, machine restart, missing original
gateway authority and interrupted launch without the original owner remain
unsupported for ownership recovery. Keep these environments quarantined. Do not
delete `launch.intent` or impersonate the old instance. A copied retirement receipt
or database is not an owner-controlled cleanup operation.

Legacy stages are observation-only until their original launch authority and
supported drain are qualified; this launcher does not retrofit running processes.
Existing custom launchers and frontend previews require separate inventory and
approval. Offline tests exercise reservation concurrency, stale retention,
interrupted creation, same-owner replacement and failed/complete retirement using
injected physical effects. They do not prove real provider or workload cleanup.
Real model tests must select an account-supported Luna model and announce the exact
model and charged account before calling it; obtain approval for any alternative.

Changes require exact-current-head CI and Centaur final LGTM/merge recommendation,
including parent PRs. Publishing a PR does not authorize merge, deployment, owner
restart, credential changes or legacy retirement.

## Retaining a trial across a human handoff on macOS

A foreground agent-tool command is not a service lifetime guarantee. For a fresh
trial that must survive sign-in or a new chat turn, prepare a unique launchd job
for the existing registered staging entry after owned-release preparation:

```sh
node scripts/prepare-staging-service.mjs /absolute/plan/owned-release.json /absolute/staging-registration.json 19994
```

This writes `staging-operator.json` and `staging-custodian.plist` exclusively in
the private plan directory. App authentication is freshly generated and stored in
the mode `0600` operator file; provider credentials are not copied. Authentication
values never enter the plist or command arguments. The same existing staging
launcher reads that file, applies the existing environment allowlist, reserves a
registry slot, claims the exclusive intent and becomes the original custodian.

Preparation prints a unique service label and paths only. It neither loads nor
starts a service. After checking the exact plan, registration and prepared plist,
use `launchctl bootstrap gui/UID /absolute/plan/staging-custodian.plist` and
`launchctl kickstart gui/UID/LABEL`, substituting the current operator UID and
returned label. Retain that exact freshly created service identity as the original
launch control handle. Do not use `kickstart -k`, enable automatic restart, or
start a second job with the same plan. `RunAtLoad` and `KeepAlive` are false; the
exclusive intent refuses a later launch even after service exit.

Use the private file for local app login; never paste its values into a transcript.
Check live `/api/symposium/custody` against this original service and verify it
again after returning from sign-in. Launchd registration and a stored receipt
alone cannot establish custody. Logs stay in the private plan directory as
`owner.stdout.log` and `owner.stderr.log`. Preparation refuses existing log
destinations and registration files that collide with them. Review them using bounded metadata,
not broad credential or environment dumps. The service has a 180-second exit
allowance for the existing 120-second original-owner drain.

An explicitly approved shutdown of this exact original service uses its retained
service control handle. Wait for the existing retirement receipt and original
registry recording, and verify resource settlement before unloading the job.
If drain is uncertain, retain the original owner for diagnosis. Do not treat
launchd exit or unload as a cleanup receipt. This path does not retrofit control
or recover custody for any historical staging process.

## Operator controller and target qualification

The static operator controller validates private source, build, configuration and
original process evidence. It uses the ordinary controller's shared visibility
and dependency-closure verifiers and an independently selected accepted-main
baseline. Generic owned preparation emits no canonical plist, and its generic
launcher refuses canonical plans. Only the registered canonical target lifecycle
may reserve the fixed capacity-one registry and retain the original native owner.

This feature source includes that target lifecycle. Its presence does not grant
source acceptance or physical qualification: the executing operator controller
must match fresh accepted main, and the selected target must independently pass
complete source review, configuration review and native readiness checks before
activation. Compilation, synthetic tests and operator receipts cannot replace
native custody or provider evidence. Keep the ordinary stage selected until those
prerequisites are met. Unknown drain or retirement retains the deployment lock,
registry slot, launch intent and evidence; no forced escalation or automatic
replacement is permitted.
