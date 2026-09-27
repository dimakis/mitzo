# Artifact volume ownership readiness

Owned Symposium pins artifact ownership to a reviewed immutable workload image,
not an account, model, request body or caller-selected numeric user. The currently
supported image is `sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161`;
its OCI `sandbox` user resolves to UID998/GID998. Other images fail closed before
gateway launch until their identity contract has been reviewed.

This is not OpenShell's universal default. At upstream
`854b2370b8740b67f6481d3015272fc37aaf9427`, Podman `container.rs:623–656` preserves
an explicit OCI USER resolution path; only an empty OCI USER uses1000:1000.

New host-reserved volumes use supported `podman volume create --uid 998 --gid 998`
with the existing exact ownership labels and no driver options. There is no
post-creation chown, chmod, helper container, foreign-volume adoption or modification
of existing volumes. The volume ledger records an image/UID/GID initialization
receipt only after create returns successfully. Missing/legacy receipts, a changed
image contract and uncertain interrupted creation remain closed even when labels
match. Same-custody completed receipts survive a ledger reopen; changed custody
still cannot adopt them.

Podman volume inspect in the tested version does not expose UID/GID. Labels are
not ownership proof. Preparation readiness records terminal initialization plus
fresh volume identity; admission separately checks fresh physical mount identity,
exact image, resolved sandbox UID/GID, directory UID/GID, non-group/world-writable
mode, and effective writeability. Writer mounts must be writable and reviewer
mounts must not be writable. A failed or malformed read-only probe fails admission.
The probe uses absolute tools and never writes into the shared volume or runs a
model. Existing root-owned volumes are not silently repaired.

## Verification scope

A disposable credential-free test using that exact image, network disabled,
read-only container root and the image's `sandbox` user verified998:998 ownership,
RW marker write/readback and RO mount write denial. Both temporary containers and
the explicitly labelled test volume were removed. No model calls were made.
The new physical verifier also rejected the existing root-owned staging volume
using read-only inspection. These checks do not establish full Symposium admission,
streaming, restart recovery or complete feature acceptance.
