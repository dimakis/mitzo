# Native seat creation receipts

Native Personal ChatGPT seats created by the owned host use separate supported
OpenShell commands for creation and seed upload. A successful `sandbox create`
process must return the exact Ready sandbox ID, name, workspace and expected
ownership/provider labels before the host records terminal creation completion.
Only then does `sandbox upload` run, followed by provider and mount checks.

The durable seat record distinguishes an unknown create (`creationStarted=true`,
`creationCompleted=false`) from a settled create awaiting configuration
(`creationCompleted=true`, exact physical identity, `state=reserved`). The latter
is cleanup evidence, not admission: another ensure is rejected until explicit
seat cleanup. Successful configuration transitions the record to ready.

If upload or later configuration fails, the original failure is returned and the
exact ID remains recorded. The workspace creation fence can settle without
claiming upload/provider/mount success. Existing explicit seat stop/removal can
clean up the incomplete seat only while the same owner retains its terminal
receipt. Artifact lease release still requires native absence and driver deletion
proof for that exact ID. No provider inventory, mount failure, or empty sandbox
list is itself proof of completed creation.

Unknown creates remain fenced. The previous live fixture has no terminal receipt
and cannot be upgraded by this code. Restart or custody loss does not restore an
incomplete seat's cleanup authority from its durable metadata. No blind retries,
credential copying, or metadata clearing are introduced.
