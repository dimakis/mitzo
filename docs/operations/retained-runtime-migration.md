# Retained ordinary Codex runtime migration

An accepted dynamic knowledge runtime can replace a supported retained runtime at startup/resume or the next completed-turn admission boundary. No active command is claimed until migration succeeds. The shared lifecycle reservation serializes the source/candidate transition with ordinary stop/checkpoint/reconnect operations. A transport owned by that conversation is closed; a fresh checkpoint process scan proves actual source quiescence. The migration never kills unknown writers.

The conversation database is authoritative for ordinary ownership, account/provider/model/profile binding, the existing provider thread and its generation. If an old ordinary conversation lacks an artifact mapping, the transaction can bootstrap one only after the trusted adapter observes its owned physical sandbox, actual immutable Podman image and actual gateway policy. Labels alone cannot authorize migration. The reviewed supported source image is `sha256:b89016abe4c17850ee31e2c4613697f6a4871356953952b0edcdb4fdfb8db624`; unknown images, policies, ambiguous provider activity and unsupported provider/Git layouts remain blocked with a safe user-facing reason.

The SQLite migration relation preserves the immutable original checkpoint identity, old physical source, target image/policy and a random candidate name committed before external creation. Each update uses a generation compare-and-swap. Candidate routing must retain the same workspace, gateway, workdir and full account route, with a distinct physical ID. The target must have the exact accepted immutable image and protected runtime attestation. The existing strict checkpoint restore verifies the original identity; it is never rewritten to pretend the source archive belongs to the target.

Before native protocol validation, a fresh candidate capture must have the same content digest as the source. Git directory metadata/history/index, dirty staged/unstaged changes, untracked files, modes and recognized provider state are preserved. Capture, restore, verify and candidate recapture execute the host release’s reviewed checkpoint helper via fixed `/usr/bin/python3 -I` and a fixed bootstrap. The host validates its physical module-relative regular file against a SHA256 pin embedded in the transport, freezes the bytes into quoted argv, and the bootstrap checks that hash again before execution. It never invokes or overwrites `/sandbox/mitzo-checkpoint.py`; immutable source and target images can retain their old helper bytes. This host-owned migration tooling is distinct from protected image runtime inputs: image digest, gateway policy, compiler/recipe/runtime attestation and original checkpoint identity remain mandatory. Changing the helper requires an accepted host release with a matching transport pin. The exact top-level Git config bytes and mode are included in the checkpoint digest and verified again on restore: supported settings preserve author identity, credential-free HTTPS remotes/fetch refspecs, branch upstreams, and basic non-bare repository format/file-mode settings. The trusted system Git parses the config with includes and ambient config disabled. Raw comment markers are unsupported, including markers inside values, so ignored text cannot introduce unverified credential material. Credential-bearing URLs, query/fragment URLs, credential helpers, headers, includes, hooks, external worktrees, signing/executable settings, SSH/local/helper remotes, nested/worktree configs and all other settings block migration with a value-free diagnostic; they are never silently dropped or copied without validation. Standalone credential stores remain excluded. Legacy v1 archives that omitted `.git/config` fail closed before replacing either root; restore never invents remote/upstream/identity settings or rewrites the archive. `.git` pointer files and symlinked Git metadata are explicitly unsupported; restoring external absolute host pointers would not preserve a valid repository. The temporary validation client calls only initialize and `thread/resume`, with the same provider thread/model and no fallback. Tools/approvals are denied; no turn/model call occurs. Closing that client is followed by another actual writer barrier.

The final SQLite transaction checks the authoritative thread generation, ambiguity and original physical routing, then records the committed relation and candidate artifact mapping atomically. The separate lifecycle row is repaired on startup if a crash occurs after commit. Once repaired, ordinary lifecycle checkpoint restoration and provider-thread rollovers own subsequent generations; migration history cannot reset a newer thread/checkpoint. A recreated candidate must still pass the ordinary strict checkpoint restore before transport launch and artifact persistence.

Every pre-commit failure retains the original active mapping, old sandbox, source checkpoint and any candidate. Timeouts, cancellation, lingering writers and capacity shortages persist an observable retry phase with a 60-second backoff; an explicit subsequent send/resume retries that phase using the same candidate name. Fresh source capture on every retry detects intervening task/provider changes. Unknown contracts, binding drift and invalid content require inspection. Admission failures leave queued FIFO work unclaimed and expose an explicit recovery pause. There is no automatic post-commit switch back to a stale source after new provider work; that would lose subsequent task state. No migration deletes the original sandbox.

Capacity is evaluated after capture and before candidate creation, using actual archive bytes and member count, allocated seed size, host available blocks and the verified current VM storage filesystem. The conservative bound reserves three archive/extraction copies, 4 KiB per archive member, two fresh seed copies and 64 MiB headroom. Target image layers must already be cached. Requirements and free-byte observations are recorded in the migration relation. A nearly full VM can admit a small payload if it fits; insufficient or ambiguous capacity blocks without pruning other images, worktrees or sandboxes.

Production rollout still requires accepted source/review/CI and an active-turn drain before any global service replacement. This implementation does not activate services or migrate production sandboxes during tests. An operator must retain original sandboxes/checkpoints until successful current-generation adoption is verified. A process restart cannot be used as proof that a provider turn completed.

Offline regressions cover strict source/target identity, real archive/Git/provider preservation, source content equality under different image/physical identities, candidate attestation/native validation failure and cancellation cleanup, uncertain create replay, CAS concurrency, FIFO admission recovery, policy/account drift and exact capacity bounds. No live model calls are part of these tests.

## Authored and effective policy identities

The checkpoint policy SHA remains the canonical JSON digest of the original parsed
reviewed **authored base**, including its explicit false defaults. It is never
rewritten to the target policy, a materialized policy or a newer profile revision.
In-flight records with a different original contract fail closed. A separate source
and candidate attestation records the actual **full effective policy SHA**, selected
provider instance IDs/types, reviewed profile-definition hashes, live revisions and
scope/source metadata. Positive profile revisions may advance only when the exact
reviewed security definition and provider authority remain unchanged.

OpenShell omits explicit false `request_body_credential_rewrite` and
`allow_uninspected_credentials` endpoint fields and serializes an unused credential
query parameter as empty. Only these documented defaults are normalized. Runtime
observation reconstructs the complete expected policy from the accepted base plus
exact approved provider layers, and compares the whole object. No `_provider_*`
prefix is ignored. The CLI `--base` view only strips that prefix and cannot supply
this attestation. Extra endpoints, binaries, credential destinations, bypass flags,
filesystem permissions and unknown fields block admission.

OpenAI and Google Workspace definitions are pinned to the existing reviewed YAML.
The explicit GitHub definition in `infra/openshell/providers/github-reviewed-profile.json`
and the endpointless compatibility OAuth definition in
`infra/openshell/providers/openai-codex-oauth-reviewed-profile.json` were independently
matched to their [public .2 definitions](https://github.com/NVIDIA/OpenShell/blob/a44bf4ad9ee2cf1e6bce350807e4a7b8458e137d/providers/github.yaml) ([OAuth](https://github.com/NVIDIA/OpenShell/blob/a44bf4ad9ee2cf1e6bce350807e4a7b8458e137d/providers/openai-codex-oauth.yaml)):
read-only REST/GraphQL and clone/fetch transport, with push denied. This is a reviewed
definition pin, not a claim about the installed CLI binary's source commit. Mutable
profile exports are observations; they never become permission authority. The OAuth
profile keeps its exact gateway-only refresh/credential schema and contributes an
empty named network rule; only serialized empty endpoint/binary arrays are omitted.

Provider inventory omits the actual profile scope selector. The scoped catalog exposes
both workspace profiles and platform fallbacks. Every selectable definition for each
approved provider type must independently match its reviewed pin, with exact
source/scope metadata and positive user revision. The export must match a catalog
entry, and the full relevant catalog is rechecked. A possibly truncated 100-entry
catalog, duplicate scopes or a differing global credential schema blocks admission.
Separate catalog definition hashes/revisions are retained in policy provenance; no
profile selector is inferred from a provider label.

Observation binds scoped gateway/workspace commands to actual owned physical policy,
selected account route, exact durable automatic/granted approvals, physical attachment
union and provider inventory identities. Profiles, attachments, approvals, inventory
and physical policy are rechecked before accepting the snapshot. Candidates inherit
only the original source's freshly attested durable grants, persist intent before
attachment and prove the same effective authority before restoring or committing.
A committed migration remains historical: each subsequent admission verifies current
physical image and effective policy against **current** trusted approvals, so later
legitimate grants and ordinary thread/checkpoint recovery do not relabel the original.
Unknown profiles and unsupported materialization contracts remain visibly blocked.
