# Canonical staging: offline preservation after lost ownership

This procedure preserves one specifically identified, stopped native staging
installation and restores the ordinary application at the existing
`http://mitzo-staging.localhost:3190`, using `com.mitzo.staging`. It is an operator
containment disposition. It does not recover the original custodian, retire native
resources, reuse provider credentials, or establish Symposium acceptance.

The supported incident is the source/build/configuration tuple recorded by
`OFFLINE_CONTAINMENT_TARGET` in the accepted controller, including launch
`37e02cdb-068a-43fe-98e4-e51ed232ce3f`, instance
`c06d3fea-870a-45c5-9352-85359dd1a214`, and its retained
`retirement_uncertain` reservation. A different boot, native executable,
configuration, owner, storage reference or control binding requires separate
investigation and review. Historical diagnostic inventory is not authorization.

The original VM was resumed once for an approved read-only inspection on 11 October,
then normally stopped on 12 October to release its host allocation. The unchanged
supervisor is now inactive with exactly one run and no PID. Its measured machine
SHA256 is `64e86ea129a14a1ac27e41c19fe16ada36afa61e95b4378e2170f2f321a56a84`;
Podman changed `LastUp` to `2026-10-12T09:20:47.495329+01:00` during normal stop.
The controller pins that actual tuple; it refuses zero or additional runs, a live
PID, or different machine bytes. No registration history was reset. Fresh
physical closure, source qualification, native device-owner authentication and
complete archive verification remain required. Normal VM stop did not retire the
uncertain launch or grant replacement native capacity.

## Independent preparation and review

Run the existing canonical check first. Its refusal is evidence to preserve,
not a reason to bypass the installed custodian router. Use clean, freshly accepted
main source and explicitly audited, isolated dependencies at that exact commit.
Prepare an independent controller without controlling a service. Preparation builds
both the application and the native operator authentication helper before freezing
the complete compiled artifact inventory. It never enrolls a provider or starts a
backend, custodian, VM, gateway or model.

The helper uses macOS LocalAuthentication with fresh device-owner authentication.
Its source, compiler result, file identity and binary hash must match the prepared
controller's verified inventory. A self-written build record or copied JSON token
cannot authorize recovery. The authenticated original process retains a bounded,
single-use in-memory lease for the complete preservation and restoration proposal.
The prompt binds both component plans, their exact hash and canonical identity.
Authentication cancellation or unavailable evidence leaves staging fenced.

From a clean accepted checkout, prepare the independent controller:

```sh
node scripts/recover-staging-offline.mjs prepare-release \
  --commit ACCEPTED_SHA --dependency-source AUDITED_CHECKOUT \
  --expected-dependency-fingerprint AUDITED_CLOSURE_SHA256
```

Run the remaining commands from that exact prepared release. Audit reports only
native observations. Plan binds both preservation and ordinary restoration:

```sh
node scripts/recover-staging-offline.mjs audit --operation OPERATION_UUID
umask 077
node scripts/recover-staging-offline.mjs plan --operation OPERATION_UUID > PRIVATE_PLAN_PATH
```

After inspecting the saved complete proposal, select its exact combined `sha256`:

```sh
node scripts/recover-staging-offline.mjs apply \
  --plan PRIVATE_PLAN_PATH --expected-plan COMBINED_PLAN_SHA256
```

Apply regenerates both component proposals and refuses drift before presenting
the native authentication prompt. The saved proposal never contains authentication
or filesystem capabilities. These commands have no force or rollback option.

Immediately before authentication, the original controller admits only the exact
fresh accepted main and freezes its verified source, visible index, prepared artifact
and dependency receipt, helper bytes and helper filesystem identity. During that
same bounded operation, each physical phase rechecks those frozen inputs. A later
main advance is allowed only after proving that it still contains the admitted
commit. Removed ancestry, drift, unknown history or expiration refuses continuation
and preserves the guard and evidence. A serialized proposal cannot recreate this
12-minute process-local witness or extend the separate authentication lease.

Ancestry checks use a private public-Git scratch store, never the release's refs or
objects. They fetch commits only, with depth 256, at most three immutable fetches,
30 seconds per fetch, no automatic maintenance and a kernel limit of at most 4 MiB
per file. Packed storage, full byte/file accounting and in-flight checks enforce a
conservative 64 MiB scratch allowance; at least 20 GiB plus that allowance must be
free before creation. Oversized or unsupported history refuses. External read-only
alternates are not copied or traversed as scratch. Only the original private scratch
directory can be removed when this operation closes; native evidence is preserved.

Inspect the generated proposal before applying it. It must describe the complete
old Symposium directory, original service and VM registrations, four old ordinary
data directories, each overwritten control file, and the exact accepted replacement.
A proposal always reports `executable: false`, `nativeCleanupConfirmed: false` and
`capacityGrant: false`; these flags are not capabilities.

## Physical boundary

The native closure is limited to the reviewed stock Podman 5.6.2 AppleHV route.
The controller verifies the complete machine definition and installed helper bytes,
raw disk attachment, EFI and SSH identity references, whole canonical-root mount,
complete gateway TOML template, and absence of alternate configured runtime paths.
The frozen vfkit JSON uses `efiBootloader` as its bootloader kind; `efi` is the
command-line option and is not accepted as the stored JSON discriminator. The
exact machine hash, EFI storage path and device constraints remain required.
It requires stopped private compute, absent application registration/listeners,
an inactive non-autostarting VM supervisor, original process births before the
selected boot, no scoped open handles, and no mounted, hard-linked or symbolic
aliases. A stopped machine or empty database alone does not establish closure.

Audit never runs `podman machine inspect`: stock initialization can create runtime
directories and change their modes. Instead, both literal loopback families must
refuse bounded connections to the exact frozen vfkit control endpoint. This is
the [reviewed stock route's connection-refused stopped condition](https://github.com/containers/podman/blob/v5.6.2/pkg/machine/apple/vfkit/helper.go), combined with
the other physical checks above; it is not a native cleanup claim. A reachable
endpoint, timeout or unknown result refuses recovery.

The exact retained Podman ignition socket is preserved only when scoped handle
inspection confirms it is closed and its measured filesystem identity stays
unchanged. Its origin remains unknown; this exception establishes neither preboot
age nor native cleanup. Other sockets and unsupported filesystem types are refused.

The opaque archive is outside the canonical root and every future mounted/input
root: `~/.local/share/mitzo-staging-quarantine/OPERATION_UUID`. This preserves the
entire original home, VM disk, configuration, credentials, workspaces, gateway state,
logs and intents. Secret-bearing contents are not reported. This boundary covers
supported configuration and measured filesystem identity; it does not assert the
absence of arbitrary external copies.

## Preservation and one ordinary start

The controller acquires the existing canonical deployment guard exclusively. Any
preexisting lock blocks this operation. It durably records the original row and
intent, makes a private verified SQLite backup, unloads only the exact already
inactive VM registration through normal launchd control, and atomically preserves
the original registrations and complete Symposium directory on the same volume.
It independently rechecks archive identity, exclusion and control invalidation.

A distinct `contained_offline_native_cleanup_unconfirmed` receipt records actual
containment. The original uncertain reservation remains byte-for-byte in `launches`, continuing
to consume native capacity. Separate containment history and the registry backup
also preserve that row. It is never rewritten as `retired`; no native
retirement receipt is fabricated. Only the authenticated original transaction,
after complete physical verification, can acknowledge this disposition without
releasing its native reservation. Native
custody and cleanup remain unavailable.

Ordinary restoration retains the same deployment guard continuously. It preserves
old `home`, `workspace`, `state` and `settings` directories outside future inputs,
and snapshots every replaced control file. Fresh authentication and an empty account
catalog are installed with private modes. The accepted ordinary launcher disables
OpenShell, Codex and Connections and uses isolated proxy ports. Existing credentials
are not migrated.

Each old ordinary directory receives scoped open-handle and mount-alias checks
before and after relocation. All four archived directory manifests and their
exclusion from future inputs are rechecked before startup and completion. After
the final asynchronous native check, synchronous full verification of the native
manifest, all four ordinary archives and every saved control body and metadata
record must succeed before the guard can be removed. Originally absent controls
must still have no saved body.
These observations do not claim that latent writable mappings are absent.

The controller records one start attempt and registers the application without
starting it. After all prelaunch archive checks finish, it writes a fresh
fifteen-second permit immediately before the sole normal kickstart for the existing
canonical label. No await or full fingerprint intervenes. The launcher consumes
the single-use permit at entry, then completes every integrity check before exec
and revalidates the exact receipt and custody. Failed qualification burns the
permit and retains the guard; read-only checks never consume it. Completion
requires the original started PID and birth identity, exact accepted source and
compiled/dependency inventory, registration bytes, release working directory,
exclusive port 3190 listener and HTTP readiness. Only verified completion releases
this operation's guard. Source freshness and runtime integrity remain separate.

Repeated capsule checks establish ownership of the original deployment guard and
continuity of its intent, receipts, backup and control evidence. They make no
claim about current native bytes. Independent full byte verification remains
mandatory before ordinary admission, each old-directory move, startup, completion
and final guard release. Controller installation cannot start the application
until that full physical check succeeds. This separates ownership from physical
containment without a metadata cache, timestamp-equivalence assumption or change
to the ten-minute authorization lease.

There is no restart, rollback, VM resume, stale-lock deletion or uncertain-start
replay. Failures preserve the guard, archive, original evidence and partial new state
for diagnosis. The transaction has a verification-only capability for completed preservation;
the CLI exposes no interrupted-operation replay or replacement-start recovery.
An interrupted operation requires further reviewed verification, with fresh
authentication and the same retained evidence. Login autoload remains outside
this recovery: the new private ordinary registration has `RunAtLoad=false` and
`KeepAlive=false`. A later boot requires a separately reviewed, byte-bound ordinary
registration repair; it cannot resurrect the archived native installation.

## Acceptance boundary

Source tests inject filesystem, process, authentication and readiness effects.
macOS CI compiles the authentication helper without executing it. These checks
establish neither physical deployment nor provider acceptance. After actual recovery,
run the prescribed canonical check and verify its source, safe/stale result and
runtime identity. Provider enrollment and supported Luna live tests are separate.
State the exact supported Luna model and charged account before any model test.
Production ports, services, state, credentials and deployment remain excluded.

The physical route is grounded in the [Podman 5.6.2 AppleHV implementation](https://github.com/containers/podman/tree/v5.6.2/pkg/machine/apple),
[vfkit device contract](https://github.com/crc-org/vfkit/blob/main/doc/usage.md), and
[Apple LocalAuthentication API](https://developer.apple.com/documentation/localauthentication).
