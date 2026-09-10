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
`sandboxProvider`. This name participates in the profile revision and is attached at
sandbox creation alongside explicitly configured service providers. Raw credential
values are never accepted by the runtime configuration.

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

Conversation/thread state and the sandbox workspace are durable independently.
Destroy/recreate recovery and reviewed save-back require a future checkpoint format;
they are intentionally not implied by stop/start recovery.

## Configuration

Automatic routing is opt-in until live acceptance completes:

- `MITZO_OPENSHELL_ENABLED=1`
- `MITZO_OPENSHELL_IMAGE=<pinned image>`
- `MITZO_OPENSHELL_POLICY=<absolute policy path>`
- `MITZO_OPENSHELL_SEED=<absolute prepared seed directory>`
- `MITZO_OPENSHELL_PROVIDERS=<comma-separated service providers>`
- `OPENSHELL_GATEWAY` and `OPENSHELL_WORKSPACE` select the control-plane scope.

The legacy single-sandbox development variables remain only for the preserved spike
probes and must not be used as the production lifecycle.

## Acceptance status

Synthetic coverage proves deterministic create/reuse/start behavior, provider
attachment, invalid-state failure, sandbox-scoped context compilation, credential
and host-metadata exclusion from the MGMT seed, portable Git commits, visible native
tool event mapping, cancellation, and same-conversation provider-thread resume after
transport replacement.

Still requiring separately authorized live acceptance:

- matched gateway/supervisor/image versions with a real Personal ChatGPT provider;
- bounded Google Drive read through the gateway-owned refresh flow;
- authenticated GitHub read/private clone through its provider;
- stop/start during a normal SSE chat with automatic transport replacement;
- production rollout and operational migration.

Kubernetes/Kata, alternative agent harnesses, sandbox destroy/recreate checkpoints,
and save-back remain explicitly deferred.
