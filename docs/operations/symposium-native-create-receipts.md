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
still match. The UI reuses that key after fresh typed confirmation. Another
operator or stale binding cannot resume the operation; POST identity checks remain
strict. Successful cleanup and session changes clear the typed confirmation.

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
