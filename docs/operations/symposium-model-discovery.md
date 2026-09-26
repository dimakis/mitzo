# Model discovery without inference

`runSymposiumModelDiscovery` is an ESM acceptance helper for an already-owned,
reviewed native subscription host. It initializes `CodexAppServerClient` without
a lifecycle transport, reads `account/read` with `refreshToken: false`, and lists
models. The client rejects thread/turn methods in this mode. This helper does not
send a prompt, start a conversation, refresh a credential, or select a test model.
It has no automatic CLI entry point and does not run at import time.

A trusted host caller supplies `DiscoveryConfig` and
`createDiscoveryHostOperations(config, options)`. The configuration pins the
OpenShell CLI digest, workload image digest, policy digest, gateway, workspace,
exact attached provider name/ID, and explicit local Podman socket URL. Options
provide absolute executable/policy/journal paths, expected namespace, private
management environment and pinned owned configuration files. `attestGateway`
is mandatory: use the retained owned-host capability to attest the running
process, effective driver/configuration, TLS guest hostname coverage, the same
Podman socket, and the selected provider's private custody. Never substitute a
no-op attestation or reconstruct trust from a user-supplied JSON file alone.
The helper does not start or replace the gateway.

The adapter inherits no process environment. Only PATH and private HOME/XDG
roots are accepted. It verifies file ownership, modes, digests and private
journal/environment directories before operations; it creates the sandbox with
`--no-auto-providers`. Attachment rows prove a sole codex provider name/type; a
separate global provider inventory proves its exact ID, name, type and workspace.
Incomplete/paginated inventory fails closed. The read-only client runs through
the owned attempt controller in its fixed `/sandbox/workspaces/mgmt` directory;
this temporary workspace contains no artifact data. No credentials,
account email, raw provider error, command stderr or raw model response is emitted.
The returned summary contains a bounded status, model count and syntactically
bounded Luna model IDs. This is discovery evidence, not inference acceptance.

The journal is created exclusively with mode 0600 before `sandbox create`, with
a random 19-character requested name and unique claim. Existing journals trigger
cleanup reconciliation only, never another discovery attempt. Cleanup cancels
the exact claim, requests upstream deletion, then polls up to twelve times for
both gateway absence and absence of the physical workload/supervisor on the
explicit Podman endpoint. A failed or timed-out create is reconciled by name and
claim, even if the create response was lost. A replacement or changed owner is
never deleted.

If creation is ambiguous and no exact sandbox identity was ever observed,
apparent absence is insufficient: a delayed creation could still arrive. The
journal remains and the result is `reconciliation_required`. Likewise, failed
custody checks, incomplete inventory, or remaining physical resources retain the
journal. An operator must reconcile the host before removing such a journal;
there is no force-cleanup or success fallback. The twelve polls are bounded and
may return reconciliation for a slow but eventually successful deletion.

Tests use injected lifecycle operations and mocked child processes. They cover
intent-before-create, lost creation responses, provider mismatch, late physical
deletion, resumed reconciliation, replacement identity, pinned file changes,
private environment isolation and explicit Podman endpoint selection. The helper
has not been executed against a real OAuth account as part of this change.
