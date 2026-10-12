# Fresh canonical AppleHV allocation

This source implements one replacement VM for canonical staging. It does not
authorize host changes. The original VM must first be archived and its canonical
registration unloaded through the separately reviewed disposition procedure.
Production and retained quarantine remain outside the replacement's mount.

The fresh allocation is
`CANONICAL_ROOT/symposium/allocations/UUID/{home,workspace,settings,service}`.
Its empty HOME, private directories and fixed `settings/containers.conf` select
stock Podman 5.6.2, vfkit and gvproxy bytes without inherited credentials or
configuration. The machine name is derived from the complete UUID. The canonical
registry remains at `CANONICAL_ROOT/registry`.

## Provisioning under the original controller

The actual new registered canonical app process calls
`createFreshAppleHvProvisionPlan(input)` and reviews its complete digest. It then
calls `provisionFreshAppleHvAllocation(...)` with process-local assertions for
the original allocation guard, accepted source, current purpose-specific native
authentication and independently approved stock image. Booleans or receipts
cannot substitute for these callbacks.

The image must already be independently qualified in
`CANONICAL_ROOT/symposium/image-sources/SHA256-arm64.raw.zst` (or `.raw.xz`), with
its private file identity, exact SHA256, compressed size at most 1 GiB and verified
expanded upper bound at most 16 GiB. The image assertion must verify that upper
bound and stock/version compatibility independently; the submitted number is
not image authority. This helper does not download, enroll or approve images.
An official public registry manifest alone is insufficient.

The only provisioning command, using the pinned Podman executable and fresh
environment, is:

```text
podman machine init --image LOCAL_PINNED_IMAGE --cpus 2 --memory 4096 --disk-size 16 --rootful=false --volume CANONICAL_ROOT:CANONICAL_ROOT UUID_DERIVED_NAME
```

There is no start flag. The implementation rechecks live authority before each
write and native dispatch. An exclusive `service/fresh-vm-init-attempt.json`
permanently consumes this allocation's initialization attempt. A timeout, lost
authority or uncertain result retains files and processes for investigation;
there is no kill, retry, deletion or automatic rollback.

Admission reserves the full 16 GiB disk upper bound, known release/controller
growth, compressed-image scratch and all additional growth. It measures the
canonical root plus adjacent quarantine and accounts for in-flight reservations.
The resource policy's source bytes and numbers must match accepted source. The
initial 32 GiB policy cannot admit the measured retained footprint plus a fresh
disk; the separately reviewed 48 GiB policy may be used only after acceptance.
Unknown extras, aggregate overflow or less than 20 GiB remaining host free space
refuse with an awaiting-retention/operator-plan result. No cleanup is implicit,
and accounting is not an OS disk quota.

Successful initialization returns a measured `createFreshAppleHvPlan` result and
writes its private plan plus exact canonical VM supervisor plist. It measures
the fresh raw disk, SSH key, machine definition and configuration identities.
The EFI store is expected absent beneath a pinned private parent; only the
original first vfkit start may create it. Provisioning neither registers nor
starts the VM and grants no native capacity lease.

## One start and original running proof

The same app process independently reviews the measured VM plan, consumes its
single native capacity lease through the disposition owner and installs the
canonical `com.mitzo.staging.vm` registration. It requires initial runs zero,
no PID, `RunAtLoad=false`, `KeepAlive=false` and the exact accepted supervisor
source argv. It keeps `createFreshAppleHvOwner(...)` in that original process.

`verifyStopped()` checks physical inputs, no fresh handles/listeners and the
stopped registration. `startOnce()` consumes its latch before awaiting anything,
performs one normal launchd kickstart and authorizes only the actual registered
supervisor PID and birth over a fresh private IPC socket. The supervisor then
performs one stock `podman machine start` and captures original child lineage.
The plan file alone cannot reopen this channel or running capability.

`verifyRunning()` binds the original supervisor/vfkit/gvproxy PID births, current
macOS boot, actual guest boot, rootless socket, TCP control endpoint ownership,
and open raw-disk/EFI device and inode records. Only LastUp within the original
start interval may change; all other machine fields remain pinned. The actual
new EFI identity is captured once. Mutable disk bytes are not compared to a
pre-start hash as running proof.

After successful full verification, `assertRunningCurrent()` is a synchronous
original-owner capability for the canonical custodian. It rechecks the original
live guard, process/backing/configuration/source identities and physical resource
facts. Before releasing the startup guard, the caller may synchronously hand its
existing guard callback to the original live custodian fence. No callback or
ownership is serialized, reconstructed or transferred to a different process.
The supervisor's heartbeat follows that same original controller channel.

`retain()` records sanitized uncertainty and permanently refuses further owner
proof/start. Loss of the controller or channel also refuses proof; it never
stops, force-restarts or replays the VM. A generic queue resource observer must
refuse a fresh allocation unless it has a separately implemented authentic
original-owner resource path. Missing legacy machine files cannot imply VM zero.

## Original-owner retirement

For normal final retirement, the original owner also exposes `stopOnce()` and
`confirmStopped()`. Its constructor captures `assertNativeDrainCurrent`, a live
synchronous assertion from the actual original host's completed drain. The
retirement hook must keep that assertion and the independent original
parent/custodian registration, PID birth and source fence live through shutdown,
including after the app/gateway IPC closes. Expired initial admission does not
invalidate this original lifetime; it cannot authorize another start.

`stopOnce()` verifies the original guest/helper/backing identities, consumes one
attempt and sends only stock vfkit's graceful `POST /vm/state` with `Stop`.
It does not invoke `podman machine stop`: Podman 5.6.2's
[AppleHV stop helper](https://github.com/containers/podman/blob/v5.6.2/pkg/machine/applehv/machine.go)
calls the [wait-enabled vfkit helper](https://github.com/containers/podman/blob/v5.6.2/pkg/machine/apple/vfkit/helper.go),
which escalates to a hard stop after 90 seconds. The direct
[vfkit 0.6.1 graceful state handler](https://github.com/crc-org/vfkit/blob/v0.6.1/pkg/rest/vf/state_change.go)
uses `RequestStop`, with no delayed escalation. After positive guest closure,
only the captured networking helper may receive normal SIGTERM; no SIGKILL,
retry, adoption or forced VM stop exists. The original foreground supervisor
exits through its authenticated live controller's retirement response.

`confirmStopped()` positively checks original process absence, unchanged machine
and backing identities, no open disk/EFI handles and no live control/API socket.
Unknown or changed state refuses and records uncertainty; only the same live
owner can reconcile an uncertain stop. Shutdown needs no new resource admission,
so pressure cannot prevent a known owner's drain. New disk/EFI backing remains
retained and counted. Old archived reservations and backing are untouched.

## Offline evidence and remaining host qualification

Focused tests cover normalized plans, growth refusal, authority refusal, one-shot
and concurrent start fences, original-owner handoff, mutable LastUp, exact native
argv/open handles and refusal of a saved plan without its live guard. They run
with one worker and a 1024 MiB V8 heap, without VM initialization, startup,
provider enrollment or model calls. They do not prove actual host admission,
image qualification, launchd lineage or live VM readiness.

The fixed route follows the [Podman 5.6.2 init contract](https://docs.podman.io/en/v5.6.2/markdown/podman-machine-init.1.html)
and its [stock AppleHV implementation](https://github.com/containers/podman/blob/v5.6.2/pkg/machine/applehv/stubber.go).

Stock Podman5.6.2 uses a 36-character hexadecimal virtiofs mount tag. Its `LastUp` remains zero after first startup and after our direct vfkit graceful retirement; running ownership requires original independently captured process and guest boot evidence. The generated machine `.ign` file is included in the measured plan and its identity, permissions and bytes are rechecked before authorization, dispatch and current/stopped proof. Private umask-generated mode0600 and stock mode0644 are allowed at capture and the exact observed mode remains pinned.

The one-shot initialization record must fsync both its file and private parent before Podman may run. Any persistence failure retains the exclusive attempt. Start timeout, channel failure or retention permanently revokes authorization and closes every held connection; late completion of an awaited inspection cannot acknowledge or dispatch another start. These source changes require independent review and a qualified native tuple before host use.
