# Tool Builder development authority

The development adapter creates one private child directory under the current
session's authorized worktree. Directory and file operations use pinned parent
descriptors, `openat` and `O_NOFOLLOW`, following the existing native file owner
pattern. Source snapshots reject symlinks, hardlinks, nonregular files, changed
workspace identities and excessive source sizes. Failed preparation removes only
the allocated workspace; replacement identities are preserved and reported.

The installed Node unit profile accepts `src/index.mjs` and explicit
`test/*.test.mjs` files. Fixed commands run with one test worker, a 128 MiB child
heap, a cleared environment, an empty OpenSSL configuration, bounded output and
a shared 60-second deadline. No command, environment, network policy or host
path can be supplied through tool input. Runtime binaries/libraries and the
allocated source are readable; unrelated task roots and private stores are not.
The existing OS sandbox continues to deny network access and credentials and
fails closed when complete sandbox support is unavailable.

Zero tests, failures, cancellation, skipped tests and incomplete output cannot
produce a successful report. Expected example answers remain in the trusted
parent, which compares reported actual values. Candidate process reports are
explicitly untrusted review material: they do not authenticate completion of a
harness that imports candidate code. Publication uses the independent accepted
installed-source qualifier described in [the main contract](tool-builder.md).
No candidate source is loaded by product tool dispatch.

Deterministic fixtures use temporary source and synthetic private files. A real
OS fixture reproduced an unauthorized neighboring read before the scoped read
policy, then verified both a permitted workspace read and the denied neighboring
read. The developer runner also executes a real temporary Node test and rejects
the reproduced early-exit expected-answer envelope. These are offline checks;
they make no model or service calls and establish no live Mitzo qualification.
