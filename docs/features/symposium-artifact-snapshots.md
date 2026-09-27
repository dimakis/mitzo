# Host artifact snapshot observations

This dormant host prerequisite captures regular-file manifests from an existing
Symposium artifact volume. It has no HTTP route and is not installed in dispatch,
completion, or admission. It does not create a `WorkResult`, a `ReviewReceipt`, a
Git commit, or evidence of token-budget enforcement. The current hard-cap gate is
unchanged.

`createOwnedArtifactSnapshotObserver` binds an observer to the retained owned
OpenShell gateway and the existing SQLite artifact lease host. The lease host owns
one retained Podman command context shared by admission volume inspection and
verifier execution; the observer cannot supply another executable/environment or
select another Podman store. Legacy inspection-only lease hosts remain supported
for their existing operations but refuse snapshot construction. Callers cannot select an image, executable inside
the verifier, mount target, scanner, or budgets per observation. Construction alone
does not run commands. The low-level constructor permits dependency injection for
mocked tests; it is not an untrusted request boundary.

Before and after scanning, the observer verifies retained gateway custody, the
exact bound sandbox and lease revision, admitted physical named-volume metadata,
driver configuration, and the sandbox's actual mount. It uses the reviewed image
ID from `TESTED_SYMPOSIUM_NATIVE_BUILD`, without pulling. The verifier has no
network, a read-only root and artifact mount, no capabilities, no-new-privileges,
and fixed CPU/memory/process limits. It executes only a literal Python scanner
with isolated interpreter mode; no Git configuration, hooks, filters, imports from
the artifact tree, or shell scripts are executed.

The scanner limits traversal to 10,000 entries, 64 MiB of file contents, 64 levels,
4 KiB paths, and 20 seconds. The owned-host command context uses its existing 15-second command timeout and
2 MiB buffer ceiling; the observer also rejects outputs over 8 MiB. A scanner
exceeding the tighter host limit fails closed. Descriptor-relative no-follow opens reject symlinks, hard links,
special files, malformed paths, and detected changes while reading. The top-level
`.git` directory is excluded metadata (a linked or regular-file `.git` is rejected).
Empty trees and uncommitted files are supported. Executable bits are recorded;
empty directories and other permission bits are outside the manifest contract.

The host validates the output, independently checks successful stopped-container
exit, and hashes a sorted JSON manifest containing path, executable flag, length,
and SHA-256. Each immutable SQLite observation stores a fresh revision, content
digest, manifest, scanner hash, pinned image, lease token hash/revision, session,
seat, workspace, volume generation, sandbox identity, and retained gateway launch
provenance. It remains readable after restart. It is a historical observation,
never an automatically current artifact pointer.

A durable singleton reservation is written before creating the verifier. Every
create attempt, including an ambiguous timeout, requires exact-name forced cleanup.
Cleanup failure or host crash leaves the reservation in place and blocks retries
across instances/restarts until explicit operator reconciliation. There is no
automatic TTL or recovery deletion. Successful receipt persistence happens only
after cleanup and a final host verification. No existing sandbox is deleted.

## Consistency and remaining integration

Receipts are explicitly `unfenced_observation`. File checks detect many mutations,
but cannot prove a coherent whole-tree point in time while another writer is
active. Neither a lease nor two matching hashes alone establishes that proof.
The next executor integration must hold the durable execution claim's other-writer
fence throughout input/output capture, prove native process-tree shutdown before
output capture, and atomically commit the result, recipient completion, and cleanup
confirmation with cancellation/generation checks. This PR deliberately does not
install that integration or enable model dispatch.

Snapshot revisions are not source OIDs. Publication still needs an explicit
committed-tree equivalence proof under the artifact lease plus the existing
approval/preflight/idempotency boundary. Repository import/initialization and
committing are separate explicit actions; this observer never performs them.

Unit validation uses temporary local directories, a real SQLite lease store, and
mocked Podman/custody operations. A separately authorized zero-model physical
Podman probe used this exact pinned image and uniquely named disposable resources:
the default image user (UID/GID 998) could write a marker in the new named volume
and read it with mode 0600. With the volume mounted read-only, the same user could
read the marker while a write failed with EROFS (30). UID 0 with all capabilities
dropped could not read the same file (EACCES 13). The observer therefore preserves
the pinned image's default user and never overrides it with root or broadens file
permissions. The verifier factory cannot select an alternative image; the image ID
is code-owned. Network isolation, read-only mounts/root, and dropped capabilities
remain unchanged.

All test containers and the test volume were removed and exact-name absence
verified. No gateway, account credentials, OAuth, model call, or production
activation was involved. This is direct Podman mount/ownership evidence, not an
OpenShell lease, revocation, scanner end-to-end, or execution-fencing proof.
Application integration still requires those separate checks. Files unreadable to
the builder's image user fail closed; no automatic chmod/chown is performed.

The shared context is installed in owned-host lease construction only; no snapshot
observer or route is automatically created. Cleanup uses the same retained command
context as inspection and scanning. If custody is lost and cleanup cannot run, the
durable verifier reservation remains for explicit reconciliation.
