# Local repository source materialization

Director controls → **Import local repository** imports one explicitly configured
local repository into a fresh owned artifact volume before seat admission. Preview
selects a repository ID, matching GitHub owner/repository, local origin default
base branch and new feature branch. The server resolves the configured path; the
browser cannot submit a host path, physical volume or Git object directory.

The preview discloses the exact local base commit/tree and count of every reachable
commit. It does not fetch or claim that this commit equals GitHub's current head.
Import requires a recent app passphrase check, CSRF and the typed approval
`IMPORT COMMITTED REPOSITORY HISTORY`. Its source-scoped app-auth route works when
legacy Connections integration is disabled. Failed-seat cleanup uses a separate
scoped passphrase route followed by its existing exact-operation, revision, CSRF
and typed handoff checks; neither action automatically dispatches cleanup or work.

The full reachable history is exported as a self-contained bundle through a clean
code-owned Git configuration. Host worktree/untracked content, `.git` metadata,
config, hooks, credentials and alternates are not copied. Only regular committed
files are supported; symlinks, submodules, unsafe paths, known credential filenames
and known secret patterns anywhere in reachable history are rejected. This is a
conservative supported-input check, not a universal secret detector. The selected
repository must have a plain `.git` directory and local default-ref evidence;
linked worktrees, shallow/partial repositories and object alternates are unsupported.

Limits are 8 MiB bundle, 64 MiB expanded reachable objects, 10,000 commits,
100,000 objects and 10,000 files in the selected tree. Oversized or unsupported
history fails visibly; the importer never silently truncates, synthesizes a base,
shallow-copies or increases the bound. A large real repository may require a
separately reviewed bounded transport design. A tiny fixture passing is not proof
that arbitrary application repositories or live publication are supported.

The existing SessionArtifacts row serializes import against every host admission
descriptor issuance. `claimAdmission` permanently records that permission was
issued, including candidate resolution. Import cannot begin afterward, even if a
previous descriptor has not yet been used. Existing migrated rows default to issued;
new host custody cannot adopt an old row by interpreting a zero marker.

A source intent is durable before mutation. Fresh physical census verifies the
exact labels/generation, UID/GID and absence of other mounts before helper create
and start. The pinned networkless helper receives the bundle over bounded stdin,
verifies pristine initialized Git without deleting metadata, imports the selected
ancestry, materializes regular blobs without hooks/filters, and installs sanitized
origin/base/default/feature refs. Python has a 40-second wall clock, the helper a
50-second deadline and host attach a 60-second deadline. Readiness requires exact
helper identity/isolation, terminal exit zero, content proof and helper removal.

A terminal helper failure is shown separately from an unknown outcome. Both retain
the volume, helper identity and source intent; no reset or retry endpoint exists.
Late observations are saved before post-operation custody checks. Shutdown drains
the whole operation through its receipt. Restart recovery and adoption of historical
resources remain unavailable. Native hard-budget admission, model authorization,
review, publication credentials and remote publication remain separate gates.

The opt-in `MITZO_SOURCE_PHYSICAL_CONTRACT=1` test exercises the mounted source API,
real SQLite owner, production initializer and importer stdin transport using a
credential-free two-commit repository and disposable app-auth/custody fixtures.
It verifies contents, history and refs, unchanged source/implementation trees,
exact helper termination/removal and exact volume cleanup. It makes no model call,
remote fetch, native admission or publication claim.
