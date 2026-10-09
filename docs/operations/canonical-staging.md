# Canonical Mitzo staging

The configured macOS workstation has one regular staging app at
`http://mitzo-staging.localhost:3190`, managed by `com.mitzo.staging`.
Its private installation is `~/.local/share/mitzo-staging`. The separate hostname
keeps its host-only login cookie separate from production's localhost login.

Start a Mitzo session by reading this procedure and running:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging check
```

The command verifies source/tree cleanliness, compiled output, the dependency
fingerprint and the registered job's directory/listener. It reads current main
without updating the active release's remote refs. `safe` describes integrity and
runtime identity; `stale` means main has advanced. A stale stage can remain the
explicitly selected test baseline. Startup checks its pinned commit, tree, clean source and accepted-main ancestry; refreshing the cached main ref does not invalidate that baseline. `check --offline` does not verify main freshness.
A retained deployment lock marks the check unsafe even if the app is running.
There is no unattended upgrade or scheduled drift monitor.

## Prepare and plan an update

This first controller supports accepted main releases for the regular app.
Experimental branches, Symposium custodian enrollment and provider setup require
separate reviewed configuration; this command cannot adopt their ownership.
Use a full 40-character commit ID, not a moving branch name:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging prepare --commit TARGET_SHA
~/.local/share/mitzo-staging/bin/mitzo-staging deploy --commit TARGET_SHA --expected-current CURRENT_SHA
```

Preparation clones independent source from the public repository and builds it
while the current stage continues running. It reuses an independent copy of the
installed dependencies only when the package lock is byte-identical. A changed
lock requires separately provisioning audited dependencies; it never silently
substitutes packages or accepts toolchain licenses. Main must still match the
selected commit after the build. Preparation creates no app, provider or model turn.

Deployment defaults to a plan. The explicit apply form is:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging deploy --commit TARGET_SHA --expected-current CURRENT_SHA --apply
```

Before controlling the job, the CLI and its support modules must be identical to
those in the accepted candidate. This keeps a locally edited, unaccepted controller
from applying deployment. The controller reserves an exclusive private lock,
revalidates the exact requested candidate receipt, current release and original pinned PID/job/listener, then requests
SIGTERM through the staging service's existing launchd control handle. It does not
signal discovered PIDs or call production deployment scripts.

After the original app has stopped and port 3190 is free, it preserves an offline
workspace/state snapshot. It promotes the validated receipt and launcher, grants
one bounded start permit and starts the same stage service. Success requires the
new process directory/listener and HTTP readiness. The audit records the planned
and verified commits; secrets and provider transcripts are excluded.

A failed/uncertain shutdown, snapshot, promotion, start or verification keeps the
lock and evidence. Do not force-kill, remove locks, start a second service or
reuse a start permit. There is no automatic rollback: new code may have migrated
state, and a filesystem snapshot does not restore live native custody. Inspect the
exact operation and choose a separately reviewed recovery action.

## Current configuration and protection

App authentication, HOME, workspace, state, catalogs and dependencies are isolated.
Provider connections are not configured. Production credentials and `.env` files
must not be borrowed. The service starts on login and has no automatic crash restart.
Each successful controlled update changes only this service and its private root.

The two retained October continuity checkpoints and old gateways, containers,
volumes and directories are not disposable controller resources. They remain outside
this regular staging app. Staging cleanup or deployment never authorizes changes to
production, its service, data or provider configuration.

Global Codex guidance routes future local Mitzo sessions here. Repository AGENTS.md
and the always-applied Cursor rule provide the same routing after this change lands.
Existing sessions must reread the guidance; it is not a cross-chat broadcast or
provider-context adoption receipt. Real model tests require explicitly supported
Luna, with the exact model and charged account announced before execution.

Dependency receipts now use a version-two closure fingerprint: contained symlink
target paths, modes and payloads are included, with cycle and outside-release
refusal. Valid workspace and .bin links remain supported. The literal transfer
checksum used while copying node_modules is separate and never qualifies a
release. New candidate receipts are recorded only after the selected source builds;
the original dependency closure is rechecked before and after copying/building.

Historical link-text-only fingerprints are deliberately refused. Do not regenerate
or overwrite a live receipt to make it pass: migration or requalification requires
a separately reviewed source/dependency audit. Default verification performs no
migration, restart or fallback. The explicit qualification procedure below is
separate; missing dependency proof still refuses candidate validation before
any original service control.

## Explicit legacy qualification

The original configured stage has a link-text-only dependency receipt and was
registered through the user's `Library/LaunchAgents/com.mitzo.staging.plist`.
Accepted controllers refuse either historical form until the source/dependency
audit is separately reviewed. Run the following from an independent accepted
source checkout; the audit performs no service control or inference:

```sh
node scripts/requalify-staging.mjs audit
```

The audit verifies the original source/tree and visible Git index, complete
recorded compiled inventory, historical dependency fingerprint, original
controller file hashes and exclusive staging process/listener. It accounts for
every omitted workspace payload against the original published Git blobs or
compiled receipt. Unknown payloads, aliases, drift, existing operations and
unconfigured-provider violations refuse qualification. The legacy and private
plists must be private regular files with identical bytes, the original label,
launcher, working directory and no crash restart. The report binds their exact
hash to the original PID and birth identity.

After separate review, select the printed original source and `auditSha256`:

```sh
node scripts/requalify-staging.mjs apply \
  --expected-current ORIGINAL_SOURCE_SHA --expected-audit AUDIT_SHA256
```

Apply requires the executing checkout to be clean, visible, tracked source at
fresh exact accepted main. Under the shared deployment lock it rechecks all
original inputs, creates a private exclusive archive of the receipt, controller,
startup files and login plist, and requalifies only the dependency fingerprint.
It installs unchanged accepted controller/startup guards and records the exact
qualification. It does not stop, start or replace the existing service, configure
providers, or launch a model. It verifies both the migrated guards and unchanged
original process before releasing the lock. A partial metadata write or uncertain
check retains its archive and lock; investigate instead of deleting or retrying.

### Verifying a completed retained metadata operation

The startup guard determines the canonical root from the actual user's HOME.
Qualification invokes its read-only `--check` in that operator context; the guard
then constructs the separate staging HOME for application launch. A historical
qualification command mistakenly supplied application HOME to this outer guard.
Its completed metadata writes are intact, but the failed acknowledgement retains
the operation's lock. Do not rerun migration, restore old files or delete the lock.

After investigating the named operation, the verification-only command is:

```sh
node scripts/verify-staging-qualification.mjs \
  --operation ORIGINAL_OPERATION_UUID --expected-audit ORIGINAL_AUDIT_SHA256
```

It requires fresh exact accepted main and the same retained lock, qualification,
original private archive and audit pin. The current receipt must be byte-for-byte
the original receipt with only its proven v2 fingerprint changed; installed
controller/startup bytes must match that original accepted controller commit.
Source, dependency closure, every archived file, original registration and live
process are checked again, with no other retained operation or native ownership.
The startup check uses operator HOME and performs no launch. The command repeats
verification, records completion of the original operation and releases only its
matching lock. It does not rewrite metadata, retry migration, create a successor,
start/stop an app or supply provider/model authority. Partial migration, drift or
unavailable evidence continues to retain the lock and archive.

The qualified legacy registration permits read-only checks, release preparation
and the existing ordinary-to-owned transition. Ordinary deploy refuses it. That
transition pins the qualification and original login-plist bytes, preserves the
plist, confirms original process/listener exit through the original service
handle, then removes only that recorded login plist before installing the same
canonical label. This prevents a later login from resurrecting the old ordinary
launcher. Changing either plist, the original PID/birth or qualification refuses
control. The ordinary launcher executable may use the original Homebrew symlink only when its resolved path is the executing Node binary; the exact two arguments, startup script, plist bytes and process pins remain checked. A redirected executable or extra argument refuses before control. The owned service continues to require the private canonical path.

For a changed package lock, provision and audit dependencies separately in an
isolated checkout of the exact target, with no provider configuration. Keep its
source clean and pin its actual closure with the accepted `fingerprintDirectory`
helper. The paired preparation arguments are:

```sh
~/.local/share/mitzo-staging/bin/mitzo-staging prepare --commit TARGET_SHA \
  --dependency-source ABSOLUTE_CHECKOUT_PATH \
  --expected-dependency-fingerprint AUDITED_CLOSURE_SHA256
```

Preparation verifies that checkout's exact source, public origin, visible index,
matching target lock and explicit closure before copying. It independently builds
the selected target, verifies the copy checksum and unchanged dependency source,
and creates a fresh v2 release receipt. It never runs npm install, chooses versions,
changes the live receipt or controls a service. Missing provisioning still refuses
a changed lock. Native runtime/configuration qualification and provider enrollment
remain separate from this migration.

The original VM supervisor remains `com.mitzo.staging.vm`, with no automatic
restart. Resume that same registered supervisor after confirming a stopped VM,
its recorded rootless resource/mount boundary and no retained native operation.
A foreground `podman machine start` in an agent command does not establish
persistent supervision. Its stable API socket uses the supervisor's finite
`TMPDIR=/private/tmp`; review the [socket-only proposal](evidence/canonical-staging-socket-proposal.json)
before changing the historical gateway socket location. Preserve the original
private configuration, verify the approved old/new hashes and schema, and
reprepare superseded unlaunched bundles. This changes no account/model policy or
credentials and grants no native runtime or inference admission.

The canonical custodian keeps its restricted `PATH=/usr/bin:/bin`. Gateway
listener observation selects `/usr/sbin/lsof` explicitly on macOS for both sync
startup and async custody checks. This fixes executable discovery without
inheriting a broader shell environment. A historical launch failure still keeps
its registry reservation, launch intent and transition lock; applying this source
fix does not grant retry, original-owner recovery or retirement authority.

See the [bounded failed-launch record](evidence/canonical-staging-activation-refusal.json)
for the named original operation. An empty observed native inventory is not an
original-owner retirement receipt or permission to reclaim the reserved slot.

## Qualified refusal before native startup

The cold-refusal recovery is deliberately narrower than lost-custodian retirement.
Its recognized historical source/compiled contract sets the parent's PATH to
`/usr/bin:/bin` and synchronously invokes `lsof` before allocating a gateway
launch directory, issuer, or process. On the same macOS boot, both lookup
directories must reside on the sealed read-only root, contain no `lsof`, and the
exact restricted probe must fail with `ENOENT`. That mandatory gate cannot pass.
Empty inventory alone never qualifies recovery.

The audit additionally requires the original failed transition, immutable source,
complete prepared build/dependency receipt, exact non-running same-label job with
one run and exit1, and a single zero-generation reservation without an instance.
There must be no original owner, attestation, gateway launch directory, session
artifact ledger, membership, sandbox, creation fence, native container or volume.
The empty initial artifact file must have no schema. The private VM connection
and sole canonical-root mount are verified. Any different source, later bootstrap
footprint, reboot, extra job run, drift or ambiguous lookup remains fenced.

From clean current accepted source, prepare an independent recovery controller:

```sh
node scripts/recover-staging-cold-refusal.mjs prepare-release \
  --commit ACCEPTED_SHA --dependency-source AUDITED_CHECKOUT \
  --expected-dependency-fingerprint AUDITED_CLOSURE_SHA256
```

This delegates only the accepted pure release builder while the original operation
remains locked; it creates no backend. Run subsequent commands from that prepared
canonical release, whose full source, compiled output and dependency receipt are
verified before mutation:

```sh
node scripts/recover-staging-cold-refusal.mjs audit
node scripts/recover-staging-cold-refusal.mjs prepare --expected-audit AUDIT_SHA256
```

Preparation exclusively preserves the complete service/workspace/gateway/registry
evidence. Under the retained original lock it atomically moves the entire original
reservation into `qualified_cold_refusals`, classified `pre_native_refused`, with
its audit and archive binding. It does not fabricate an instance or native
retirement. The original record remains available through the registry's read-only
`qualifiedRefusals()` history. Partial preservation or transaction failure retains
evidence and the lock; an existing archive is never overwritten.

The old launch files and initial workspace/gateway state are retained in that
private archive, leaving fresh canonical paths. VM supervision, Podman HOME,
keys, configuration, original ordinary backup and production remain retained.
Prepare fresh owned/service bundles through the existing canonical commands at
that accepted source and independently selected baseline, then run:

```sh
node scripts/recover-staging-cold-refusal.mjs plan
node scripts/recover-staging-cold-refusal.mjs activate
```

Plan checks exact new plist/environment, immutable inputs, empty fresh state,
capacity-one disposition and the original stopped registration. Activate rechecks
fresh accepted main and the plan, unloads only that stopped registration, installs
the new same-label plist and starts once. It never kills a discovered PID, force
restarts, restores an old launch, or repeats an uncertain start. Only the fresh
original callback's parent/app identity, registry instance/epoch and loopback HTTP
readiness permit release of the matching original lock. A failed new start stays
fenced. Provider enrollment and Luna workflow acceptance remain separate.

This recognized pre-native contradiction grants no generic recovery, adoption,
cleanup or capacity reclamation for a launch that could have reached native
creation. Historical sources outside the explicit contract and all repaired
sources with a reachable listener probe remain subject to the lost-custody fence.

## Exact RSA refusal before native resource construction

The second qualification is limited to the first cold-recovery attempt at source
`1233fe67f92bf6f7126b4d79db4ce8cf7cb3a1b1` and the original reviewed upstream
gateway SHA256 `281a4873ec62ddb384db2b495a324d5a899e27944500c309191195463cd2422e`.
The official native source at `854b2370b` parses an Ed25519 signing key in
[`ExtensionJwtIssuer::from_pem`](https://github.com/NVIDIA/OpenShell/blob/854b2370b/crates/openshell-server/src/auth/sandbox_jwt.rs#L323),
called by [`run_server`](https://github.com/NVIDIA/OpenShell/blob/854b2370b/crates/openshell-server/src/lib.rs#L565)
before the store, extension transports, compute driver or listener are constructed.
The exact frozen configuration enables this mandatory gate. A matching RSA pair
cannot pass it. Configuration preflight alone does not parse signing keys.

`audit-keys` binds the historical source/compiled modules and complete prepared
receipt, original recovery plan/attempt, first preserved refusal, exact stopped
job, same-boot reservation, and sole private VM scope. It verifies the entire
frozen native configuration and file set; alternate keys, unknown sections,
extra files/directories, gateway database, token cache, owner, attestation, session
ledger, application membership or native workload state refuse qualification.
Native inventory absence remains supplemental, never the authority. The native
process may have been created; the classification is **pre_resource_refused**,
not pre-native, retired or adopted.

From the independently prepared current accepted controller:

```sh
node scripts/recover-staging-cold-refusal.mjs audit-keys
node scripts/recover-staging-cold-refusal.mjs prepare-keys --expected-audit AUDIT_SHA256
```

Preparation exclusively archives the complete second service/workspace/gateway/
registry evidence and original configuration under the first preserved operation.
It atomically preserves the second row beside the first history before vacating
the operational reservation. Original private keys are retained. A fresh matching
Ed25519 pair and key ID are generated at distinct private paths named for the
second launch, and only the gateway JWT references change. Every byte of the new
configuration and keys is bound into the new private recovery receipt. Partial
failure remains locked and retains evidence; there is no generic replay.

Prepare fresh owned/service bundles at the current accepted source/baseline, then
use the existing `plan`, single `activate` and original-owner verification. The
second history, complete archived registries, original lock, minimal configuration
change and fresh key bytes remain checked before control and unlock. This does
not authorize another recovery for an unrelated failure or create another backend.
Runtime signing validation now rejects invalid or nonmatching keys before gateway
material, issuer or child allocation; preparation retains its metadata-only private
reference contract. Provider enrollment and explicit supported-Luna live acceptance
remain required after canonical HTTP ownership is established.

Pure recovery release preparation is allowed to complete without the read-only
probe's 30-second timeout. Other read-only probes keep their bounded timeout;
release construction performs no service control.
