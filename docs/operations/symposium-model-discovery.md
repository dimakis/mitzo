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

Inventory completeness is required for every sandbox, global provider and attachment check.
The pinned v0.1 CLI exposes `--page-size` and `--page-token` on all three list commands;
the adapter consumes up to 100 unique continuation pages and accepts completion only
with an explicit empty `next_page_token`. Missing or malformed tokens, repeated tokens,
exhausted page bounds and bare arrays fail closed without returning partial rows.
Legacy CLI collection arrays are not completeness evidence and are unsupported here.

The host adapter exclusively locks the journal for the entire attempt, including
reconciliation and cleanup. A concurrent caller cannot inspect, cancel or clear the
active attempt. The private exclusive lock is synchronized to disk before any work;
a process crash retains it and requires explicit host recovery after confirming no
active owner remains. It is never automatically stolen using a PID or timeout.
The read transport starts SSH in a detached process group and closes the entire
group, including its OpenShell ProxyCommand, using the shared transport helper.
The receipt itself is synchronized before dispatch: each exclusive initial write and
atomic identity update syncs file contents and the containing directory. Cancellation
SSH uses the same detached process-group termination on timeout and completion as the
read transport, so its ProxyCommand is included in local cleanup.

A rejected preflight before external creation can clear only the exact private
journal created under the still-held host lock. This local rollback does not
require current gateway custody, because no external allocation was dispatched.
A replaced journal, lost lock, observed sandbox ID, or dispatched create retains
reconciliation rather than claiming cleanup. The host records dispatch immediately
before the CLI process starts; inventory and physical cleanup remain required
for any dispatched attempt.

An unreadable or malformed journal, or custody failure before journal absence is
proved, reports reconciliation required. Successful cleanup deletes only the exact
receipt under the retained lock; a replaced receipt or lost lock remains for host
recovery instead of being erased. These checks apply to ordinary completion as
well as undispatched rollback.
