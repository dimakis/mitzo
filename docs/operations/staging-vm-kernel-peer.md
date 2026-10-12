# Fresh VM kernel peer and guest binding

The original controller must inspect the accepted guard connection with the
source-built `scripts/native/staging-vm-peer.c` helper. Its Darwin
`LOCAL_PEERPID` and `getpeereid` observations identify the actual peer. `libproc`
pins the executable, original parent, UID, and process birth to microseconds.
A PID received in a JSON message is compared with that observation and grants
no authority. The helper is read-only and cannot start or signal a VM.

The helper must first be compiled remotely from accepted source, independently
reviewed, and its actual binary path and digest included in the approved VM
plan. This source does not build a helper during provisioning or accept a
binary selected by a request. The compilation and kernel fixture commands are:

```sh
clang -Wall -Wextra -Werror -O2 scripts/native/staging-vm-peer.c -o "$RUNNER_TEMP/staging-vm-peer"
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
`GET /libpod/info` uses that same connected socket. The result must agree with
stable rootless guest facts observed through the plan's exact stock machine
SSH path and fresh key. Guest boot identity is checked before and after. The
rootless remote socket must be `/run/user/1000/podman/podman.sock`. Unknown
guest schemas refuse. Every effect retains the original live owner fence.

These modules are source components. They do not qualify a VM by themselves.
The approved plan, original start owner, exact helper arguments, open backing
identities, and canonical registration checks remain required. Until the
controller integrates and measures the helper, start admission remains refused.
