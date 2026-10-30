# Callback completion and the 30 October continuation incident

Provider completion raced an original host callback. The application retained the
completed native turn, but its last tool receipt arrived five milliseconds after
the application terminal event. The old owner correctly retained uncertainty; a
later bootstrap then hid that reason behind `Owned local Codex chat unavailable`.
The observed phone reconnect and native bootstrap succeeded. Device switching is
not established as the cause.

## Prevention

The original callback owner tracks tools, questions, native approvals, SDK hooks
and SDK permissions. A completed native turn seals new effects and drains existing
callbacks before a completion hook, successful application terminal or FIFO
release. Exact native RPC cancellation is identity-bound. An error, rejected
callback, timeout or unknown effect retains recovery custody and the completed
provider outcome. Structural JSON cannot manufacture original outcome evidence.

SDK control callbacks do not expose a trustworthy native turn identity. Separate
query closures prevent a delayed old callback from acquiring a successor's
authority. Each successor resumes the existing SDK history after the original
process actually closes. Account, workspace, model, thinking and permission
settings remain with their existing owners. Native Responses/Gemini retains its
existing serial tool execution and checkpoint owner; it does not acquire Codex
thread/recovery APIs. Runtime failures are sanitized and retained for reconnecting
viewers with an actionable reason and stable diagnostic reference.

## Exact historical repair

This is a prepared operator operation, **not production activation authorization**.
Staging remains stood down. Required source review, combined CI and acceptance
precede a separately explicitly authorized production deployment. Neither a draft
PR nor publication alone confirms adoption.

The default-disabled repair is limited to incident
`ce932ac5-186e-87be-96b6-e09968c5d87f`. It is not a generic ambiguity override.
The manifest pins its original command/attempt/thread/turn/generation, two queued
commands, all eleven host-tool receipt fingerprints, application event sequence,
original accepted source contracts and exact native rollout hash/format. The
original sources positively disable project hooks for this owned local route.
The sole late operation was `RequestWebAccess.request_access`: its original
implementation resolves an in-memory access grant and performs no fetch or
downstream write. Other original tool outcomes must have arrived before the
application terminal. No conversation prose is projected by inspection.

After accepted deployment, an authorized operator must separately enable
`MITZO_CALLBACK_INCIDENT_REPAIR_ENABLED=1` and select the retained original
accepted source directory with `MITZO_CALLBACK_INCIDENT_ORIGINAL_SOURCE`.
Source paths are server configuration, never HTTP request fields. Preserve the
original release and diagnostic records. Activation is deliberately reversible;
disable the incident endpoint after the selected operation.

Use the owning server's authenticated JSON endpoints:

- `POST /api/sessions/ce932ac5-186e-87be-96b6-e09968c5d87f/codex-callback-repair/inspect`
  with `{}` returns only an inspection plan hash and retained queue count.
- `POST /api/sessions/ce932ac5-186e-87be-96b6-e09968c5d87f/codex-callback-repair/apply`
  with exactly `{"planHash":"<fresh inspected hash>"}` freshly requalifies the
  original operator, account, local target, custody, physical home, provider
  terminal, event order and saved work before applying that plan.

Both operations hold the actual repository startup mutex and ordinary conversion
hold in the owning server. A standalone script cannot replace those process-local
fences. Live owners, changed routes/history/queue, adviser/worker/Telos/Symposium
scope, pending dispatch/ownership/startup, capacity recovery, other unresolved
effects, unstable files or mismatched evidence refuse the operation.

The apply transaction creates a private, fsynced backup of the selected retained
rows beside the native database and a distinct operator audit record. It changes
only the selected command's ambiguity/recovery acknowledgment and conversation
recovery flags. It does not change input, status, attempt, tool results, native
history, generation, workspace or queue order. It creates no historical
completion-phase receipt. An exact repeat is idempotent; changed retained work
requires a fresh investigation. Generic recovery continues to refuse historical
missing evidence outside this reviewed incident.

The response reports `dispatched:false`. No resume, retry, provider call or queue
pump is invoked. Verify the actual accepted runtime and preserved queue before
the user's next explicit continuation in Mitzo. Never replay the completed
command or remove apparently duplicated queued instructions on the user's behalf.

## Validation evidence

Offline tests cover callback/terminal races, actual mocked native stdio and RPC
cleanup, late approval refusal, unknown effects, SDK query/process/history and
control boundaries, adviser tool ceilings, safe durable diagnostics, evidence
conflicts, exact incident CAS/backup/idempotence and authenticated route fences.
The incident evidence parser was also checked read-only against retained source,
native and tool-event metadata: all pinned fingerprints and event order matched;
zero provider calls and zero state changes. That inspection did not restore the
production conversation.
