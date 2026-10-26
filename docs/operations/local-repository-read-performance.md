# Local Mac repository reads and preparation

Repository discovery and inspection use one bounded, read-only metadata observation
and a fresh verification of that observation. They resolve HEAD without walking the
object store or unrelated reference namespaces. Missing or unsafe optional worktree
orientation remains unavailable instead of making HEAD inspection fail. Dirty status
remains unknown when its full comparison context cannot be qualified.

Every physical read and outward result retains the original signed owner, account,
request, native turn, policy, deadline and abort checks. Observation parsing consumes
immutable data from the exact factory reader; it cannot fall back to ambient reads.
Adopted task topology also uses a fresh bounded observation, preserving stable
root, pointer and branch checks while allowing ordinary index/ref updates.
Base revalidation can reuse an immutable data witness only under the same original
scope, and still performs a fresh physical verification every time. A witness is
neither a retained grant nor a cached authorization result.

Preparation copies bounded opaque Git containers into owned private scratch, validates
the required HEAD closure with a single Git object stream, and publishes the complete
checkout through the existing one-use approved helper. Normal repository pack files
can exceed the generic 16 MiB byte-read limit, while required checkout objects retain
their 16 MiB per-object and 128 MiB aggregate expansion limits. Historical objects do
not count toward the required checkout closure. Container copying remains bounded to
128 MiB aggregate and 4,096 files. Source configuration, alternates, hooks and external
object stores never become inputs to private Git execution.

Tracked `.claude`, `.cursor` and `.codex` content is permitted only by the repository
preparation tree projector after Git content verification. The generic tree projector
still rejects these paths. Credential directories remain excluded, and native owned
runtime project hooks stay disabled. Large preparation manifests travel through
pinned private program/request files instead of exceeding shell argument limits.

The workflow tests use signed synthetic account fixtures, intercepted provider RPC,
real SRT/Seatbelt and disposable repository copies. No provider executable or model
turn runs. Both subscription and API routes are required in macOS CI, including cold
login, viewer detachment, denied access, revocation, cleanup and completed-turn
checkout handoff. These tests qualify this Local Mac path; they do not qualify other
providers, remote runtimes or deployment.

Measured during development on this Mac, discovery took 1.9–2.0 seconds, inspection
2.2–2.3 seconds and preparation 42–43 seconds for a disposable copy of the actual
Mitzo repository. Preparation previously took 133 seconds in the same workflow.
These are observations, not performance guarantees or a five-second target claim.
