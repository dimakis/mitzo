# Native seat creation receipts

Native Personal ChatGPT seats created by the owned host use separate supported
OpenShell commands for creation and seed upload. A successful `sandbox create`
process must return the exact Ready sandbox ID, name, workspace and expected
ownership/provider labels before the host records terminal creation completion.
Only then does `sandbox upload` run for an ordinary seat, followed by provider
and mount checks. An attested artifact-backed seat never uploads the seed: this
avoids writes to a reader mount or overwriting a writer's shared artifact volume.
Artifact initialization and native workdir/mount alignment remain separate host
contracts; skipping upload is not proof that those contracts are satisfied.

The durable seat record distinguishes an unknown create (`creationStarted=true`,
`creationCompleted=false`) from a settled create awaiting configuration
(`creationCompleted=true`, exact physical identity, `state=reserved`). The latter
is cleanup evidence, not admission: another ensure is rejected until explicit
seat cleanup. Successful configuration transitions the record to ready.

If upload or later configuration fails, the original failure is returned and the
exact ID remains recorded. The workspace creation fence can settle without
claiming upload/provider/mount success. The authenticated director status exposes only bounded creation phases
(`create`, `upload`, `provider`, `mount`), safe `SEAT_*_FAILED` codes, and the
host's cleanup capability. Native subprocess output is not part of diagnostics.

The explicit **Clean up failed seat** action, including for the primary seat,
requires typing `CLEAN UP FAILED SEAT` and the current roster revision and seat
generation. `POST /creation/recover` durably fences new work and cancels stale
queued/retryable deliveries before calling exact physical cleanup. It can proceed
only while the same owner retains the terminal receipt. After cleanup is proven,
a transaction rotates the membership to a new suspended generation, preserving
the primary role and account binding. A separate **Restore** action is required;
cleanup never creates a replacement or calls a model. Retry uses the same durable
request; partial cleanup stays fenced, and a completed retry never repeats deletion.
After a browser reload, authenticated status returns the pending operation key only
to the original operator while the revision, generation, and retained host proof
still match. The UI reuses that key after fresh typed confirmation. A new app session must explicitly obtain scoped fresh reauthorization as described
below; stale bindings and superseded executors remain rejected. Successful cleanup and session changes clear the typed confirmation.

Artifact lease release still requires native absence and driver deletion
proof for that exact ID. No provider inventory, mount failure, or empty sandbox
list is itself proof of completed creation.

Unknown creates remain fenced. The previous live fixture has no terminal receipt
and cannot be upgraded by this code. Restart or custody loss does not restore an
incomplete seat's cleanup authority from its durable metadata. No blind retries,
credential copying, or metadata clearing are introduced.

### Recipient and operation-key isolation

Failed-seat cleanup and ordinary seat removal cancel only that seat's recipients.
Other pending recipients retain their queue state; other executing recipients retain
claims and may finish normally. A delivery settles when its remaining recipients
finish, while cancelled recipients cannot dispatch again. A cancelled executing seat
still retains an unsettled physical attempt until terminal cleanup is proved.

The cleanup fence reserves its operation key in the same SQLite transaction used by
membership transitions. Existing membership keys and other recovery keys are rejected
before physical cleanup, and another seat cannot consume a pending recovery key.
Exact retries reuse the original request and completed membership result.

Delivery admission checks the session cleanup/seal fence in the same transaction as
its ready-to-delivering transition. If a different SQLite connection establishes a
fence before a recipient claim, finalization returns idle work to ready even when
that claim throws. Existing executing recipients retain their claims and finish;
failed, cancelled, and terminal deliveries are not revived by this requeue.

### Fresh app authentication for a pending cleanup

`POST /api/sessions/:id/symposium/creation/recovery/reauthorize` transfers execution
authorization for one existing pending cleanup while its original host still
retains the exact terminal creation receipt and current custody. This app uses a
shared-passphrase operator identity; it does not independently identify a person.
It does not recover gateway custody after restart, settle unknown creation, or
create/restore a seat.

1. In the new authenticated app session, GET the director status. A pending seat
   with retained custody exposes `creationDiagnostic.recoveryAuthorization`:
   `operationId` (opaque SHA256), `revision`, and `state`. Only the current
   executor receives `recoveryIdempotencyKey`; a new session does not need it to
   request reauthorization.
2. POST `/api/connections/reauthorize` with `{ "passphrase": "..." }`, using the
   current app auth and same-origin JSON. Retain the returned short-lived `csrf`
   only in memory. Do not log or copy app auth, passphrases or prior session inputs.
3. POST the scoped endpoint above with `x-csrf-token`, JSON `seatId`,
   `expectedRevision` (config revision), `expectedGeneration`, `operationId`,
   `expectedAuthorizationRevision`, a new handoff `idempotencyKey`, and
   `confirmation: "RESUME FAILED SEAT CLEANUP"`. No initiating actor or physical
   identity is accepted from the caller. Fresh auth and CSRF are rechecked after
   any wait for in-flight cleanup. The response returns the operation ID and new
   authorization revision. Exact handoff retries return the same receipt while
   that authorization remains current; a superseded handoff cannot restore itself.
4. GET status again. The newly authorized session receives the original cleanup
   key. Call the existing `/creation/recover` with that key and fresh typed
   `CLEAN UP FAILED SEAT` confirmation. Cleanup preserves its immutable original
   request and initiating actor; append-only handoff records audit the executor
   changes. A separate Restore remains necessary after successful suspension.

SQLite immediate transactions serialize authorization CAS and execution claims
across store connections. Handoff cannot proceed while an execution token is held.
The token is released only after a durable stopped sandbox receipt and all native
attempts have settled. A local CLI timeout does not prove remote settlement: the
execution claim remains fenced, even if the remote operation later completes. A
crash-held or uncertain claim is not expired or auto-unlocked. Terminal physical observations persist even
if authentication expires or membership completion fails. A retry may finish from
that stopped receipt without repeating deletion, while the current executor and
retained host checks still apply. Historical completed result reads never delete.

The director UI offers a fresh passphrase and typed authorization form only for
an eligible pending operation. It clears the passphrase immediately after submission,
uses the existing recent-auth endpoint and scoped operation reference, then refreshes
status. Cleanup still requires a separate typed confirmation and click. Expired or
rejected authorization cannot trigger cleanup. A fenced execution may still be
running or have an uncertain outcome; the UI does not offer retry or handoff in
that state. Lost custody remains unavailable. No restart-recovery action is offered. Mixed-version
controllers/downgrade across the new authorization ledger are not supported.
