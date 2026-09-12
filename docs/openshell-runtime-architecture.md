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

The MGMT seed is copied from a reviewed committed tree plus safe working-tree
overlays. It excludes host runtime, dependency, credential, log, and repository
administration paths. A new portable Git repository is initialized inside the seed,
so normal edits, diffs, and local commits work without copying host `.git` state.
The host-side baseline records the source commit and file hashes.

Conversation/thread state and the sandbox workspace are checkpointed together before
an operator-approved stop. The private, versioned archive is bound to the exact
conversation, provider thread, account binding, policy/image identity, physical
sandbox ID, and source resource version. A deleted or replaced sandbox is restored
from that verified archive before Mitzo starts the app server and resumes its
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
a stop does not grant future deletion consent; automated retention deletion remains
inactive until a separate persisted consent source is installed.

## Acceptance status

## Lifecycle operations

Lifecycle cleanup is disabled by default. When enabled, a fully quiescent detached task may be stopped after 30 minutes; retention defaults to seven days and accepts no value below five days. Reconciliation runs every five minutes. Deletion separately requires authenticated retention consent and a current verified checkpoint; active, queued, recovering, shared, Task Board-owned, or ambiguous tasks remain blocked. The checkpoint archive helper is packaged in the pinned runtime image and preserves supported Codex state plus the sandbox workspace. Operators can roll back by disabling lifecycle cleanup and restoring a verified archive before starting the provider app server. Podman `system df` telemetry is usage only, never filesystem-free capacity.

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
