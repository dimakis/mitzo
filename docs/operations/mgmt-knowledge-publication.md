# MGMT knowledge publication contract

Status: selected and implemented for K1 offline publication, 30 September 2026. This ADR selects the publication contract. K1's offline producer/consumer repair does not authorize deployment or establish sandbox adoption.

## Decision and ownership

MGMT owns accepted knowledge and publication intent. Initially only an exact commit accepted on canonical `dimakis/mgmt` main is publishable; unsaved drafts and feature branches are excluded. The trusted publication service owns source acquisition, generated-index validation, immutable storage and promotion. K2 will materialize the exact revision in its own snapshot, so publication cannot require a clean personal main checkout. Existing hooks and Centaur events are wakeups; they are not the authority or durable queue.

Mitzo owns the bundle builder and consumer verification. Every invocation extracts the complete builder tool set from one full pinned Mitzo commit: `prepare-mgmt-seed.sh`, delegated `prepare-mgmt-knowledge.sh` and sibling `runtime-resolution-contract.py`. The publisher reads one selected runtime stack lock from that same commit, validates its fields, and passes its runtime inputs explicitly. It does not inherit ambient compatibility settings. Runtime contract releases own image digest, dependency projection, base image, target platform and target Python marker environment. ContexGin remains the context selection/compiler owner; Mitzo owns paths, capabilities, session/task state and adapter delivery. Publication does not introduce another compiler or infer missing context ownership.

## Bundle identity and compatibility

Retain `baseline.json` as the existing envelope alongside `mgmt/`, extending its contract explicitly rather than creating a second incompatible manifest. Dynamic knowledge bundles carry an explicit `knowledgeSchemaVersion` (currently `1`), `knowledgeCompilerSha256` and `knowledgeRecipeSha256`; all are required, covered by the payload digest and compared with identically named selected stack `runtime` fields. `knowledgeCompilerSha256` identifies canonical inputs comprising exact ContexGin commit, compiler entrypoint bytes and interface/version; `knowledgeRecipeSha256` identifies the selected recipe contract. K1 validates supplied release pins; Stage 2 must attest their actual runtime inputs. Dynamic knowledge bundles also carry source `startingCommit`, `runtimeBaseCommit`, `runtimeDependencyProjectionSha256`, file records with SHA-256 and mode, and a per-publication `payloadSha256`. The canonical payload encoding uses recursively sorted UTF-8 object keys, UTF-8 JSON, compact separators and no ASCII escaping. Payload digest covers all behavior-affecting source/runtime compatibility/file fields. Informational host paths are not compatibility evidence.

Builder parsing uses isolated declared tool versions: PyYAML `6.0.2`, packaging `24.2` and tomli `2.2.1`. Provision these exact uv dependencies before offline publication; ambient Python modules do not satisfy the contract. Approved source files are archived from the selected commit in a fresh bare repository, preserving committed attributes while excluding personal/global archive attributes and replacement refs. Generated metadata uses the selected snapshot timestamp even in shallow checkouts. Portable Git is freshly generated with fixed format, branch, identity, snapshot-derived commit time and config; transient reflogs/editor state are removed and its index is rebuilt without filesystem stat caches. File modes are normalized under a fixed umask before the complete tree is hashed.

Separate version axes:

- The runtime release pins the image digest and immutable dependency/compiler/schema/recipe compatibility identities.
- Each knowledge publication pins its source SHA and payload digest. Those change together when knowledge changes.
- The implemented `publication.json` record binds source SHA, per-publication payload digest, baseline-byte digest, builder commit, selected runtime image/digest and compatibility fields, and validation evidence. K2 must add creation time and durable service ownership metadata. A consumer selects and records one exact validated publication.

When the source includes the Jira subproject, baseline `runtimeJiraInputsSha256` additionally matches stack `runtime.jiraRuntimeInputsSha256`: a conservative canonical digest of exact `jira_process/pyproject.toml` and `jira_process/uv.lock` file digests. These independent runtime inputs are covered by `payloadSha256`; their drift requires a runtime release.

A dynamic bundle is compatible only when its supported schema, runtime base/dependency projection and context compiler/recipe identities match the released contract. Knowledge-only A then B must pass with the same runtime image and dependency contract, without editing the application stack lock. A fixed `runtime.seedPayloadSha256` may verify a static legacy image seed; it must not pin the evolving digest of dynamic publication. Dynamic consumers still recompute each bundle's digest and every file hash/mode, validate provenance/indexes, reject extra/missing files and snapshot private upload inputs before use. Removing the fixed application payload comparison does not remove bundle integrity verification.

Missing compatibility fields, invalid marker environments, stale locks, projection mismatch, unsupported schema/compiler/recipe or malformed payloads block promotion with a specific reason and the action required to release a compatible runtime. No host dependency re-resolution, silent image rebuild, compiler substitution or fallback runtime is permitted.

## Portable source boundary

For K1 select a versioned portable path allowlist:

- Root files: `AGENTS.md`, `CLAUDE.md`, `CONSTITUTION.md`, `KNOWLEDGE.md`, `SERVICES.md`, `README.md`.
- Memory: `memory/**/*.md`, excluding `memory/scripts/`, `memory/manifest/` and hidden path segments.
- Eligible spokes: `jira_process`, `slack_observe`, `architecture`, `professional`, `patents`, `music`, `health`, `command_center`, `knowledge_space`, and `okrs/shared_eng_excellence`. Admit only each listed spoke's `CONSTITUTION.md`, `AGENTS.md`, `CLAUDE.md`, and `context/**/*.md`; nested professional blog/linkedin guidance follows the same patterns.
- Generated retrieval data: exactly `memory/manifest/index.json`, `wikilinks.json`, `by_type.json`, `by_tag.json`, rebuilt deterministically from archived Markdown and validated against the exact source SHA.

Explicitly exclude `career/`, `direct_reports/`, and `okrs/private_eng_excellence/` from portable publication to preserve declared private boundaries. Any future addition is an allowlist/schema contract change with reviewed fixtures, not a new broad traversal wildcard. Runtime tools are a separate declared lane: only files required by the existing sandbox runtime may accompany the knowledge bundle, and their semantics remain bound to the dependency/compiler runtime contract; arbitrary executable scripts are not knowledge.

K1 must test the selected allowlist and retain #520's archive/filter/hash/mode/provenance checks and #300's manifest checks. K2 implements service-owned exact revision acquisition and durable reconciliation under this contract; it does not decide a different implicit source boundary.

Exclude host configuration at every depth: `.claude`, `.codex`, `.cursor`, `.mitzo`, `.mitzo.json`, hooks/MCP configuration, credential/token/key files, `.env*`, personal Git metadata/configuration, virtual environments/dependency directories, logs, caches, databases and non-allowlisted data. Reject symlinks, unsafe paths and escaping parents. Tests must exercise excluded tracked paths as well as ignored/untracked inputs; a clean source checkout alone proves no confidentiality boundary.

K1 ports #520's exact-commit archive/filter/hash/mode/provenance checks and #300's manifest/publication checks. Its integration repair is not evidence that the complete final spoke allowlist or service snapshot exists; K2 must make the portable allowlist explicit before automatic production publication.

## Storage, promotion and delivery

Use existing publisher-owned local immutable version directories, with a manifest-qualified promotion reference. Build in a private staging directory on the same filesystem, validate completely, publish an immutable version and atomically replace the promoted pointer. An atomic symlink is acceptable for the private publisher's local pointer; consumers must resolve once, validate and snapshot the selected version, rather than follow a moving pointer during upload or a turn. No generic orchestrator or new artifact store is introduced in K1. Remote storage can be added only through the existing authorized persistence/publication service.

Choose verified immutable copy for sandbox delivery. Keep versioned knowledge outside writable task artifacts; do not assume OpenShell offers a supported read-only mount. The exact sandbox path/receipt wiring belongs to K3 and must cover both ordinary creates and artifact-backed Symposium seats. Knowledge publication must not mutate retained sandbox task roots or replayed checkpoints. A writable portable Git root used by the legacy seed path is a compatibility bridge, not the final knowledge storage contract.

Retain every active, manually pinned, rollback or checkpoint-referenced publication, plus at least the latest ten successful unreferenced versions for thirty days. K1 does not garbage-collect. K2's retention process may delete only fully unreferenced immutable versions after proving no active publisher/adoption uses them. Rollback atomically selects a previously verified compatible version; incompatible rollback requires the corresponding runtime release.

## Adoption policy

New supported chats select one exact latest compatible publication and record source SHA, bundle digest, runtime/compiler/recipe identities and selection reason. Enrollment in retained-chat adoption is explicit; enrolled chats adopt compatible knowledge before their next safe turn. An active turn remains on its recorded version. Preserve manual pins, rollback selection and provider/transcript history. Symposium adopts one coherent group version. K4 must refresh retrieval and the supported model context delivery, not merely files or tools. Incompatible releases and legacy-root conflicts remain blocked and observable. K1 implements publication interoperability only.

## Revalidation and dependencies

Initial fetched implementation main revisions: Mitzo `78336a0ec0c14add91814a520de08bf2bab2d772`; MGMT `bc6eb2959ecef5e0578467d3cc0cbae882771914`. Historical input heads: Mitzo #520 `1db400d0525bf390a13d8583bcf028870f0af75b`; MGMT #300 `424ca96cb8da2f0417f11383b099a26762f1ae14`. Final Mitzo implementation rebased onto current main `bc8cc3bd7a9e5a4fdeabfa5357b3f3ea4f9c6551` after the independent chat-header change #682 landed. Fresh fetches confirmed both historical PR heads unchanged; #520 remains open with conflicts and #300 remains open and mergeable.

Delivered: exact seed/runtime ownership exists; compiler invocation lives in `compile-mgmt-context.mjs`; existing source filters deliberately exclude host configuration; Centaur #43 and ContexGin #33 deliver push-triggered host knowledge rebuilding; current Mitzo create receipts/lifecycle fences/immutable runtime staging must be reused. Host rebuilds are not sandbox distribution.

Missing prerequisite: instruction/context workstream `1dbe4a6983f68cc7` Stage 2. Current Mitzo still pins ContexGin `52fe1c7c390b1d028d2bfd43f7b2b35cfff3580e`; sandbox compiler calls `compile({workspaceRoot, tokenBudget})` with no selected recipe/scope or resolved ownership/deduplication contract. Telos records Stage 1 implemented in ContexGin #43 at historical tested commit `fd24dd29513cd8c743945444ec7b1589a4532025`, while Stages 2–5 remain unimplemented. Fresh remote refs are ContexGin main `683f9007db686e710ed9a5410468fe33df1c5382`, #43 head `8b7f991d59471ad013a4a1579cd4b9900d1d213e`, and Centaur main `f388357c42d1f6f2815503911764f9313a6e598e`; these newer refs do not change the compiler revision actually pinned by Mitzo. Fresh GitHub metadata confirms ContexGin #43 is merged; Mitzo still needs Stage 2 to pin and validate that reviewed compiler. Do not change compiler pins under K1 without those delivery gates.

Current production stack lock identifies runtime `release-36731bd-bf59b381-20260924`, image digest `sha256:02bc7dcac0e1d76b5e019fbc7bbc0ab6684b86eaf71ccc33e087e750340749b4`, MGMT base `bf59b38188eb9cbfbceb3ddbf5d669fe212445d9`. It lacks the new dependency projection/target marker/seed compiler-recipe-schema attestation. A new isolated runtime baseline and Stage 2 context delivery evidence are required before production dynamic publication. Offline fixtures may supply explicit validated synthetic compatibility contracts; label them accordingly.

Artifact-backed creates currently skip legacy MGMT seed upload. K3 must integrate separate versioned knowledge delivery and receipts there; textual resolution of #520 conflicts is not sufficient. Stage 4 inspector evidence remains a separate prerequisite for truthful adopted-context provenance. K1 can complete its offline actual-component contract proof while those broader rollout prerequisites remain active.

## Prior PR disposition and K1 acceptance

#520 is a design input: port archive/filtering, manifest checks, exact runtime resolution, private snapshots, preparation and integrity tests into current lifecycle APIs; replace its evolving-payload stack-lock equality. #300 is a design input: port atomic manifest/provenance/publication checks; repair incomplete builder extraction/settings. Its personal-main acquisition and retry/directory locks move to K2 service-owned durable reconciliation. #213's hook fallback overlaps host rebuild integration; examine and reconcile at closeout. This ADR does not merge or close any PR.

K1 requires a failing-first integration test that runs both real publisher and builder, publishes A and knowledge-only B, and makes the real consumer accept both under an unchanged compatible runtime/image lock. Regression tests must cover missing settings/helper, integrity tampering and mode/path/schema/dependency mismatch, preserving the prior promoted version. Record exact tested commits, commands, green repository checks and remaining rollout dependencies in Telos. Tests with real model calls require exact supported Luna model/account announcement; K1 offline tests require none.

The checked-in cross-repository acceptance test lives in [MGMT #318](https://github.com/dimakis/mgmt/pull/318), `tests/test_openshell_publication_contract.py`. MGMT's required `knowledge-publication` CI job checks out one exact Mitzo builder/consumer commit and invokes Mitzo's checked-in `server/__tests__/mgmt-knowledge-publisher-integration.test.ts` entrypoint with `MITZO_KNOWLEDGE_PUBLISHER_REPO` set to the MGMT checkout. That entrypoint runs the actual publisher, actual manifest generator, all pinned builder scripts, production verifier and runtime admission through MGMT's owned pytest fixture. It requires a successful subprocess exit, at least one JUnit test case, and zero skipped tests, errors or failures. Ordinary public Mitzo CI skips this entrypoint only when the private publisher checkout selector is unset; an empty, missing or invalid explicitly selected checkout fails. Set `PYTHON` to the actual provisioned Python executable (the default is `python`); the paired fixture's dependencies must be installed in that environment. No private MGMT implementation or fixtures are copied into Mitzo. The fixtures publish A then knowledge-only B, keep the runtime stack lock unchanged, and verify failed publications preserve the promoted version. Repin this CI checkout whenever the paired Mitzo implementation changes. Mitzo's `openshell-knowledge-upload.test.ts` separately exercises ordinary and phased dynamic creation/upload with a fake CLI, verifying a source change during creation cannot alter the selected snapshot and failed creation cleans it up. No live sandbox or model call is needed for these contract tests.

### Actual paired acceptance evidence

The 30 September regression run at MGMT `65bf11312b5919082f17c3c2347849e9a7a3ad36` checked out exact Mitzo `5b392ee43a6378ce165e5e56218d740c217cea07`. The [required paired CI job](https://github.com/dimakis/mgmt/actions/runs/36751779038/job/110011957779) records the full checkout SHA, owned pytest **28 passed in 40.56s**, then the Mitzo entrypoint reporting **28 executed cases with zero skips, failures or errors**. This is historical regression evidence; every later implementation head needs a fresh successful paired run before merge.

The immutable [MGMT workflow](https://github.com/dimakis/mgmt/blob/65bf11312b5919082f17c3c2347849e9a7a3ad36/.github/workflows/ci.yml) provisions the actual publisher and exact consumer checkouts, primes the pinned isolated parser environments, and runs both entrypoints with offline execution selected. Its aggregate `CI` job requires `knowledge-publication` to succeed; skipped or cancelled publication cannot satisfy it. The [owned pytest fixture](https://github.com/dimakis/mgmt/blob/65bf11312b5919082f17c3c2347849e9a7a3ad36/tests/test_openshell_publication_contract.py) exercises actual generation, publication, builder extraction, production verification and runtime admission. It also tests parser contamination, Git metadata/dates/attributes/default XDG ignores, full versus shallow history, replacement refs, ignored manifest injection, missing inputs, draft source, compatibility drift and tampering while preserving the prior promotion.

Independent reviewers need read access to both exact checkouts and the authenticated CI result to verify this cross-repository proof. A public-only checkout with network disabled cannot inspect private publisher sources or hosted CI links; absence of those inputs is a review-evidence limitation, not successful execution of the paired test. Local manual review may provide both private checkouts and fetched CI evidence without copying private sources into this public repository.

## Ordinary Codex adoption implementation

The implementation adds `OpenShellRuntimeManager.adoptKnowledge` at the ordinary
Codex turn admission boundary. It selects through the existing publication
verifier, copies a private verified selection to a separate versioned sandbox
knowledge root, removes portable task Git from that view, verifies exact uploaded
file bytes and modes, and compiles through the reviewed ContexGin entrypoint.
Physical sandbox identity and ownership are checked before and after delivery.
The Codex adapter delivers the selected compiled context through the public
`turn/start.additionalContext` application-context field on the same provider
thread. Selection happens between completed turns; queued user messages remain
unchanged. This also works before the first turn, when the native thread has no
persisted rollout and cannot be resumed.

Native app-server launchers apply an inherited Landlock write boundary: task
files, private provider state and temporary files remain writable, while the
knowledge lane cannot be modified by an agent or its background descendants.
Actual runtime recipe attestation includes this boundary and both launchers.
Knowledge caches use content-addressed paths and reuse verified copies across
manager restarts. Sandbox-local cleanup retains active and manually pinned views,
at least ten recent copies, and copies younger than thirty days; publisher
versions and checkpoint artifacts are outside that cleanup's authority.

The compiler pin is ContexGin `683f9007db686e710ed9a5410468fe33df1c5382`, which
reads tracked `AGENTS.md` once and uses it ahead of legacy `CLAUDE.md`. Runtime
staging builds this exact source with frozen dependencies and fingerprints the
installed dependency closure and context recipe. Target markers are observed
inside the built image and the canonical resolution-contract helper computes the
runtime projection. These are runtime release inputs, not invented seed hashes.

This is implemented consumer support, not production enrollment evidence. The
legacy deployed lock has no dynamic contract. A reviewed compatible image/lock,
a supervised MGMT publisher, and consumer selection at its current publication
are required before enabling it. Host, Responses, Claude and Symposium adoption
remain separate enrollment work. No task checkout, draft, checkpoint or old
worktree is rebased by knowledge publication.
