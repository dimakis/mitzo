# Canonical native artifact workdir

The shared named artifact volume must be mounted at `/sandbox/workspaces/mgmt`,
the reviewed native controller's fixed cwd and Landlock workspace. Writer seats
receive the existing RW lease and reviewers the existing RO lease at that same
path. Credentials and per-attempt HOME stay outside it in isolated private seat
homes. No gateway, native helper or image patch is required for this alignment.

`SYMPOSIUM_ARTIFACT_TARGET` is the single server-side source for leases, gateway
and runtime validation, physical mount/access probes, snapshots and publication.
Runtime admission rejects a different workdir before management requests. The old
`/sandbox/symposium-artifacts` mount is rejected; it is not aliased or adopted.
Existing quarantined resources are not modified or recovered by this change.

Artifact-backed creation must skip seed upload: uploading the private seed into
the mounted workdir would overwrite shared state or fail on reviewer RO mounts.
Ordinary non-artifact runtimes retain their seed behavior. This is a dependency
of live use, not a reason to bypass the reviewed creation flow.

## Evidence and limits

The pinned controller/seat-Landlock source is unchanged from measured image build
commit `9b67c2a6`. Both accept only mgmt as workspace. A credential-free disposable
controller test found an actual marker read from mgmt succeeds while an actual
read from the former artifact path is denied. Permission queries alone were
insufficient: controller process status is also insufficient because its own exit
can be 0 while its exact terminal receipt records child failure. Tests must check
actual marker output and the exact claim's terminal exit_code/signal.

This path correction does not initialize Git, prove model execution, seal an
artifact or establish trusted review accounting. The freshly created shared
volume still needs an explicit owned Git workspace initialization path before a
committed physical seal can succeed. Historical SSH/Podman access evidence for
the old mount does not establish native controller access.

A subsequent credential-free disposable test of the aligned mount passed on that
same pinned image/controller (`sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161`): native actual read and writer write both completed
with child exit 0; Landlock read-mode write was denied with child exit 1 / errno 13;
RO mount native read passed and writer-mode write was denied with child exit 1.
Each checked its exact controller terminal proof. No model, credentials or network
were used, and the test volume was removed. Proof helper SHA256:
`610c349474ae4a5139439ea7afb469248a5cbcf32f56f8105632119928c19bb1`.
This supports the path alignment; full application admission is still unproven.
