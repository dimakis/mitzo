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
manifest and all four ordinary archives must succeed before the guard can be removed.
These observations do not claim that latent writable mappings are absent.

The controller records one start attempt, issues one bounded launch permit, and
uses normal bootstrap and kickstart for the existing canonical label. Completion
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
