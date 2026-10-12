# Fresh VM kernel peer and guest binding

The original controller must inspect the accepted guard connection with the
source-built `scripts/native/staging-vm-peer.c` helper. Its Darwin
`LOCAL_PEERPID` and `getpeereid` observations identify the actual peer. `libproc`
pins the executable, original parent, UID, and process birth to microseconds.
A PID received in a JSON message is compared with that observation and grants
no authority. The helper is read-only and cannot start or signal a VM.

The helper is compiled and exercised in macOS CI before source acceptance.
Resource-admitted canonical preparation then compiles that exact accepted source;
its actual binary path and digest are included in the independently reviewed VM
plan. This source does not build a helper during provisioning or accept a
binary selected by a request. The compilation and kernel fixture commands are:

```sh
clang -Wall -Wextra -Werror -O2 scripts/native/staging-vm-peer.c -o "$RUNNER_TEMP/staging-vm-peer" -lproc
node scripts/native/staging-vm-peer-fixture.mjs "$RUNNER_TEMP/staging-vm-peer"
```

The fixture opens only a temporary local Unix connection. It neither launches
VM helpers nor uses staging credentials.

The controller calls `captureSupervisor(socket)` before start authorization,
then polls `captureStart()` while the original Podman start child remains
alive. Both helpers must be positively captured as its children. Missing that
window retains uncertainty; an orphan helper cannot be adopted from a later
report. `finish(reported)` compares the report with the original captured
objects. `assertCurrent()` rejects process replacement and parentage drift.
After the original Podman process exits, already captured helpers may be
reparented to PID 1. This never qualifies a newly observed process.

`inspectOriginalFreshVmGuestApi` verifies the private API socket identity and
kernel peer against the captured gvproxy process. Its bounded read-only
`GET /v<version>/libpod/info` uses that same connected socket, with the strict
stock 5.6.x API version observed through the original SSH path before dispatch.
Podman registers libpod info only on its versioned route. The result must agree with
stable rootless guest facts observed through the plan's exact stock machine
SSH path and fresh key. Guest boot identity is checked before and after. The
rootless remote socket must match the approved stock `HostUser.UID`,
`/run/user/<uid>/podman/podman.sock`. Unknown
guest schemas refuse. Every effect retains the original live owner fence.

These modules are source components. They do not qualify a VM by themselves.
The approved plan, original start owner, exact helper arguments, open backing
identities, and canonical registration checks remain required. Until the
controller integrates and measures the helper, start admission remains refused.

The accepted preparation step compiles the C helper into
`dist/staging-vm-peer/helper` and writes its private `build.json` before compiled
artifacts are sealed. The VM and provisioning plans require the binary SHA,
accepted C source SHA and build receipt SHA in the same source inventory. Runtime
verification checks the accepted commit, compiler, platform, architecture and
exact source/binary paths. Missing or foreign artifacts refuse before native use.

The original controller authenticates the connected supervisor's kernel peer
before sending the one start authorization. It independently observes the stock
Podman parent and both helper births while that parent is alive; later supervisor
JSON must match those captured process IDs. Normal Podman parent exit preserves
only the helper lineage already captured in that live closure. A late orphan is
never adopted. Running verification uses the same measured API connection, its
original gvproxy kernel peer and fresh SSH-observed boot and rootless Podman facts.

`assertOriginalRunningCurrent()` remains available only after positive running
verification in the original owner. It repeats the original source, guard, boot,
process, backing, socket and registration checks while skipping new-work resource
admission. `assertRunningCurrent()` retains resource admission for new work. Both
refuse lost custody; neither method reconstructs ownership from a saved plan.
Provisioning requires the original live archive/topology witness again immediately
before initialization, and refuses any surviving vfkit/gvproxy process or VM job.
