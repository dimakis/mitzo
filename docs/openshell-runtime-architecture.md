# OpenShell conversation runtime

## Boundary

Mitzo remains the trusted control plane: UI/SSE delivery, durable conversation and
queue state, account selection, approvals, sandbox lifecycle, and provenance stay
in the server. One OpenShell sandbox is the execution boundary for one Mitzo
conversation (or, later, one explicitly shared Symposium). The provider agent loop
and ordinary filesystem, shell, Git, and service CLI tools run inside that sandbox.

The sandbox never receives the Mitzo administrative socket, host repository
metadata, host credential directories, or a container-engine socket. OpenShell
providers hold credentials outside the agent namespace and expose only policy-bound
placeholders/injected requests. Adding a CLI therefore requires an image dependency
and a reusable provider/policy profile, not a new host execution endpoint in Mitzo.
OpenShell's per-binary and per-endpoint rules remain the enforcement mechanism. The
design avoids duplicating those rules as one Mitzo host wrapper per executable;
host-side tools are reserved for narrow trusted control-plane mutations.

## Lifecycle contract

`OpenShellRuntimeManager` derives a non-revealing sandbox name from the durable
conversation ID. At session open it:

1. fetches that exact sandbox;
2. creates it from the pinned runtime image and versioned MGMT seed when absent;
3. starts it when stopped, or reuses it when Ready;
4. fails closed for Error or transitional state;
5. compiles ContexGin context inside the exact seeded workspace before starting the
   provider thread.

The selected account profile may name an OpenShell provider with
`sandboxProvider`. This name participates in the profile revision and is the only
account/inference provider attached at sandbox creation. The separately configured
service-provider list accepts only Mitzo's reviewed non-inference allowlist. Raw
credential values are never accepted by the runtime configuration.

An SSH/app-server exit now invalidates the transport rather than closing the public
conversation. Mitzo marks in-flight work interrupted, retains queued work, creates a
fresh transport after explicit recovery acknowledgement, and resumes the exact
persisted provider thread in the retained sandbox. Explicit conversation close still
tears down only the transport; sandbox deletion is a separate future lifecycle.

## Seed and persistence

The MGMT seed is copied from one reviewed committed tree. The only working-tree
inputs are the explicit rebuilt-memory provenance allowlist: `memory/manifest/index.json`,
`wikilinks.json`, `by_type.json`, and `by_tag.json`; their attestations are checked,
then the published manifest contents are regenerated from archived Markdown. The
builder rejects missing, malformed, inconsistent, or symlinked artifacts and
excludes all other ignored files, host runtime, dependency, credential, log, and
repository-administration paths. A new portable Git repository is initialized inside the seed, so normal
edits, diffs, and local commits work without copying host `.git` state. It builds
and validates a new versioned seed in a temporary sibling directory before it is
published; it never changes an existing versioned seed. Publication uses an
OS-managed advisory lock bound to its coordinating updater process, so SIGKILL or
another ungraceful updater exit releases the lock automatically and cannot leave a
permanently stale version gate.

Each generated manifest must carry `sourceCommit`, written by MGMT's
`memory/scripts/build_index.py` from its checked-out `HEAD`. Mitzo requires that
marker to equal the archived `startingCommit` and validates the index source paths,
type/tag metadata and groupings against the archived Markdown front matter, and
the forward/backlink inverse before accepting the overlay.

The host-side baseline records both the seed content commit (`startingCommit`) and
the runtime-base commit whose executable dependency set it uses, plus hashes and
normalized modes for the exact non-`.git` seed payload. Production preflight checks that exact path set,
rejects payload symlinks, and requires all four manifest provenance markers to
match `startingCommit` before it accepts a dynamic baseline. The portable local
Git metadata is intentionally excluded because it is not seed content.
The production lock and runtime image labels must continue to match that runtime
base. This lets reviewed knowledge-only mgmt updates refresh future sandboxes
without rebuilding the immutable runtime image; dependency changes still require a
new image release. Compatibility is calculated from the normalized effective
`uv lock` plus `uv sync --frozen --no-dev --no-install-project` package set used by
the runtime Dockerfile, so a dev-only lockfile change may proceed while any changed
runtime package, default dependency group, source, constraint, or resolver effect
requires an image release. A seed at the same commit as its runtime base needs no
compatibility calculation; a newer seed fails closed unless its updater has `uv`
available to calculate that projection. The mgmt updater alone validates dependency compatibility and
atomically repoints its `current` symlink after a successful seed build. Existing
sandboxes retain their workspace; only future sandbox creation resolves that current
seed path.

Conversation/thread state and the sandbox workspace are checkpointed together before
an operator-approved stop. The private, versioned archive is bound to the exact
conversation, provider thread, account binding, policy/image identity, physical
sandbox ID, and the capture-time gateway resource observation. Ready observation
versions are not mutation revisions: gateway reads may advance them. The
per-conversation lifecycle admission lock instead keeps the workspace quiescent
from capture through stop; identity, phase, protection checks, and the archive
digest remain the durable fences. A deleted or replaced sandbox is restored from
that verified archive before Mitzo starts the app server and resumes its
existing provider thread; a missing or invalid archive is a recoverable error, not
a blank-thread fallback.

The server persists lifecycle fencing records in its private Codex directory. On
startup it marks interrupted lifecycle actions failed before accepting cleanup and
runs one abortable, non-overlapping reconciler. A live session, queued/recovery
work, Task Board ownership, Symposium configuration, unavailable event history, or
unknown/transitional sandbox state blocks mutation.

## Configuration

Automatic routing is opt-in until live acceptance completes:

- `MITZO_OPENSHELL_ENABLED=1`
- `MITZO_OPENSHELL_IMAGE=<pinned image>`
- `MITZO_OPENSHELL_POLICY=<absolute policy path>`
- `MITZO_OPENSHELL_SEED=<absolute prepared seed directory>`
- `MITZO_OPENSHELL_SERVICE_PROVIDERS=<comma-separated reviewed service providers>`;
- `MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS=<comma-separated reviewed providers>`
  advertises providers that may be attached to one retained conversation sandbox
  through a Mitzo approval card. It changes sandbox capability, not OAuth consent;
  currently `google-workspace` and `github` are accepted.
- `MITZO_OPENSHELL_WEB_SEARCH=live` explicitly enables native live search;
  omitted or `disabled` fails closed.
- `OPENSHELL_GATEWAY` and `OPENSHELL_WORKSPACE` select the control-plane scope.

MCP entries run inside the sandbox only when their normal config includes
`"execution": "sandbox"` and an absolute command path available in the pinned
image. Mitzo passes those definitions to the in-sandbox Codex process, never starts
them on the host, and rejects per-server environment variables so service secrets
continue to come from OpenShell providers. Unmarked MCP entries retain the existing
host execution path only for non-OpenShell sessions.

The legacy single-sandbox development variables remain only for preserved spike
probes. Mitzo rejects that shared-sandbox seam when `NODE_ENV=production`.

Lifecycle cleanup is disabled by default. When enabled, its defaults are a 30-minute
idle delay, five-minute reconciliation interval, and seven-day stopped retention
(`MITZO_OPENSHELL_LIFECYCLE_ENABLED`, `MITZO_OPENSHELL_IDLE_MINUTES`,
`MITZO_OPENSHELL_RECONCILE_MINUTES`, and `MITZO_OPENSHELL_RETENTION_DAYS`; retention
cannot be configured below five days). Operators inspect a fenced action through
`GET /api/openshell/lifecycle/:conversationId/preview` and execute its single-use,
short-lived token through `POST /api/openshell/lifecycle/confirm`. Confirmation of
a stop does not grant future deletion consent. An authenticated operator grants or
revokes persisted retention consent with
`POST /api/openshell/lifecycle/:conversationId/retention-consent` and JSON body
`{ "enabled": true }` or `{ "enabled": false }`. A delete still requires that
consent, a current verified checkpoint, and every lifecycle protection check.

Optional usage alerts are disabled until configured. Set
`MITZO_OPENSHELL_USAGE_THRESHOLD_BYTES` to a positive byte count and/or
`MITZO_OPENSHELL_SANDBOX_THRESHOLD` to a positive sandbox count. Telemetry emits
Pino lifecycle records and deduplicated threshold-crossing and recovery alerts.
Podman `system df` reports usage and reclaimable bytes; it never reports filesystem
free capacity.

## Lifecycle operations

Lifecycle cleanup is disabled by default. When enabled, a fully quiescent detached
task may be stopped after 30 minutes; retention defaults to seven days and accepts
no value below five days. Reconciliation runs every five minutes. Deletion requires
authenticated persisted retention consent and a current verified checkpoint; active,
queued, recovering, shared, Task Board-owned, or ambiguous tasks remain blocked.
The checkpoint archive helper is packaged in the pinned runtime image and preserves
supported Codex state plus the sandbox workspace. Operators can roll back by
disabling lifecycle cleanup and restoring a verified archive before starting the
provider app server.

Any checkpoint, stop, or delete error durably marks that lifecycle row `failed` and
excludes it from automatic cleanup. Recovery is deliberate: an operator resumes the
conversation so its sandbox and checkpoint identity are revalidated, then a later
explicit lifecycle preview may offer a new action. Failed rows are never retried
blindly by the reconciler.

Synthetic coverage proves deterministic create/reuse/start behavior, provider
attachment, invalid-state failure, sandbox-scoped context compilation, credential
and host-metadata exclusion from the MGMT seed, portable Git commits, visible native
tool event mapping, cancellation, and same-conversation provider-thread resume after
transport replacement. Synthetic MCP and web-search coverage additionally proves
in-sandbox runtime configuration, host-MCP suppression, fail-closed MCP validation,
and public tool event/result mapping without real service or model calls.

Still requiring separately authorized live acceptance:

- matched gateway/supervisor/image versions with a real Personal ChatGPT provider;
- bounded Google Drive read through the gateway-owned refresh flow;
- authenticated GitHub read/private clone through its provider;
- one policy-bounded MCP call and one live web search from the retained sandbox;
- stop/start during a normal SSE chat with automatic transport replacement;
- production rollout and operational migration.

Kubernetes/Kata, alternative agent harnesses, and save-back remain explicitly
deferred. Live checkpoint round-trip acceptance remains separately authorized.
