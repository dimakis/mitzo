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

## Preparing another repository after adoption

Full workspace validation is more expensive after adoption because the original
native owner also verifies the adopted repository topology. Preparation avoids
repeating that complete proof in composing wrappers and private scratch setup.
This applies to the shared preparation path, including new chats and subsequent
preparations; it is not a repair of one retained operation.

Allocation captures the source once. Explicit HEAD reuses that verified selection;
an explicit object ID needs no reference lookup. Other refs and remote/default
bases retain their necessary selection/acquisition phase. Selecting a different
base projects immutable allocation data, preserving the original source HEAD,
root/absence anchors and packed-reference witness instead of rereading allocation.
The projected snapshot retains the same serialization bound and digest contract.
Selection refreshes the source immediately before allocation CAS or retained-row
delivery. Approval and actual effects still obtain fresh authority.

Only the exact frozen source/context pair recorded by the original factory can
omit an independent composing-context proof. Copied, borrowed and generic source
owners retain both proofs. No authority result is cached. Synchronous checks
continue to verify the consumed decision, original scope, policy, cancellation,
read ceiling and absolute expiry at I/O and delivery boundaries.

The materialization success path has seven full owner proofs, divided by the
resource each phase exercises:

| Boundary                                           | Full owner proof             |
| -------------------------------------------------- | ---------------------------- |
| Bound private artifact use                         | Original native owner        |
| Private checkout before worker and after join      | Original native owner, twice |
| Publication before worker and after join           | Consumed source owner, twice |
| Private artifact cleanup                           | Original native owner        |
| Published task reader cleanup and outward delivery | Consumed source owner        |

A consumed source proof already includes its native context. Private captured
bytes instead require that original native owner and their own physical custody;
they do not exercise source or destination paths. Both publication layouts share
one transport. Executors check original synchronous authority before either full
proof, including after a worker has joined. A revoked scope therefore cannot
start more owner I/O. Worker timeout does not reset the operation deadline or
suppress an otherwise authorized joined-result proof. All operation, approval,
read and helper bounds remain unchanged, including the 30-second worker window.

Phase diagnostics cover source qualification, object capture, approval (including
human wait) and materialization. Bounded per-helper diagnostics retain actual
gate timings and failure hashes without product I/O. Finalization cannot replace
a result or original error, including an object artifact whose disposer must be
retained. CI always retains the second-attempt artifact, including failed assertions.

### Coverage and measured cost

The existing signed native journey reuses one account/runtime setup for two
preparations, two adoptions and subsequent controlled provider turns. Its second
source has 13 planning files and an explicit HEAD selection. Assertions cover the
selected commit, every imported file, source HEAD/index preservation, continuation
metadata and joined cleanup. The mandatory macOS gate enables actual integration,
disables profile-only execution and refuses missing or skipped evidence. Provider
RPC is intercepted; these tests make no model or network calls.

The consumed-source negative control now captures genuine object data and performs
private checkout before revoking the independent source. A current native owner
cannot authorize publication: both pre-worker and post-join source proofs refuse,
no task/admin/ref/log paths appear, the artifact is disposed once, and the consumed
materializing record remains retained. This replaces the old header-only refusal,
which could fail before reaching the source gate. The new native work is necessary
to reach this distinct boundary; the existing journey/setup is reused. It measured
16.67 seconds execution/19.37 elapsed locally before the final guard tightening.

Cheap controlled-clock cases charge ten seconds per full proof: two worker
boundaries fit the original window, while duplicate setup proofs would exhaust it.
The same fixtures cover pre-spawn expiry, post-join expiry, async revocation and
synchronous scope revocation. Selection and pure projection cases reuse existing
fixtures; the real-Git equivalence/projection case uses a controlled read port over
actual file bytes and measured 0.991 seconds execution/1.60 elapsed. Existing
physical transport/custody tests remain separate. No new complete-app success
journey or timeout increase is required.

The earlier failed second preparation reported 88 underlying native admissions
before checkout refusal. That count includes nested owner work and stops before
publication; it is not the number of full materialization proofs. The successful
pre-refactor CI baseline (`bed86d885`, run 41622453461) completed both preparations,
adoptions and continuation, with the second preparation taking 246.339 seconds
and 97 native admissions. Both helper windows passed and cleanup completed. Its
whole workflow failed an obsolete setup-contract unit assertion, corrected here.
The minimum-phase native run (`11c5e1e1d`, run 41633858194) completed the second
preparation in 69.449 seconds with 55 native admissions, then adopted and continued.
All 106 returned readers were cleaned up and both object disposers ran. The second
checkout took 3.011 seconds and publication 8.458 seconds, leaving 26.989 and 21.542
seconds in their original worker windows. The materializer test executed in 132.128
seconds versus 376.747 in the prior successful baseline; the signed 43-case step
executed in 194 seconds. These are separate CI observations, not controlled host
benchmarks or production guarantees.

Review also identified stale signed helper assertions that still counted the
removed setup proof. Existing reader, topology, file and batch controls now assert
the two real worker boundaries. Post-join cleanup revocation happens on the second
proof after confirming the worker joined. The batch matrix retains pre-worker
no-effects and post-join retained bytes/refused replay, removing its obsolete third
sample. A separate mandatory macOS step selects only these seven existing cases;
its closed named-report validator rejects omitted, skipped or failed evidence.
The topology cases use controlled credential callbacks and a real parser process;
the separate 43-case gate retains genuine signed request/decision coverage.
Local assertion execution totalled 7.798 seconds, reusing existing fixtures. It
adds one focused test process, not another full success journey. Missing or
nonpassing report variants use a cheap VM test with shared synthetic fixtures.
