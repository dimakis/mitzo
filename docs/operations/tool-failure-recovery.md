# Tool failures and continuation

A tool failure is a result the agent must explain and use to continue the user's
task. It must not silently end the conversation or become a successful result.
The shared contract applies to Mitzo-owned tools across the Codex native and
OpenShell adapters, the Claude SDK adapter, and the deferred Gemini adapter.
Provider-owned built-ins still execute through their provider's tool loop;
Mitzo supplies the same recovery guidance without inventing provider receipts.

## Outcome and authority

Failure and uncertainty are separate. A known refusal or completed failure keeps
its original settled receipt. A returned failure from a reviewed read-only
built-in uses the same default across adapters. New built-ins must declare their
behavior in the shared catalog; mixed tools require operation-specific checks.
Configured MCP descriptions and annotations cannot declare recovery authority.

Interrupted native recovery uses that same read classification, including
TaskExecution reads. Generic HTTP requests are excluded because GET alone does
not prove that the endpoint has no side effects. Fresh native history, original
account/workspace custody, matching request hashes, and retained results remain
required. Recovery neither retries the operation nor changes its failed result.

Unknown writes, missing outcomes, cancellation, owner loss, and execution
watchdog retirement retain their recovery fences. Do not change an uncertain
receipt into success or replay a command to make the chat resumable. Independent
authorized work may continue while the engine owner is valid; an invalid or
retired owner must visibly pause for recovery.

## Agent feedback

Unexpected tool exceptions use a shared sanitized diagnostic with a stable code,
reason, phase, effect status, diagnostic reference, and next action. Logging uses
the current trace and session/call identity. Raw upstream errors and credentials
are excluded. Returned domain-specific errors retain their existing content.
Original outcome evidence survives adapter conversion into model tool results.

Codex local and OpenShell conversations use the same exception reporter as the
Claude SDK and deferred Gemini adapters. An original trusted exception's private
settlement receipt takes precedence over diagnostic defaults, including an
explicit unknown receipt. Adding project-hook feedback to text or rich results
also preserves that receipt. A known failed operation stays failed without
inventing unresolved effects; unknown work remains fenced. These in-memory
receipts cannot be supplied by tool text, JSON fields or configured MCP metadata.

The shared Telos backlog adapter also retains proof that validation or approval
failed before a canonical mutation was dispatched. Denied approval remains a
failed operation with no update applied; it does not create an unknown-write
blocker. Once mutation dispatch begins, unconfirmed results remain unknown.
Explicit original-owner uncertainty takes precedence, including during approval.
Structured diagnostics identify the conversation and whether failure occurred
before dispatch or during mutation/result handling.

Memory exhaustion, filesystem denial, storage exhaustion, connection failure,
and deadlines have explicit messages. Shell failures include the observed exit
code or signal even when stdout is empty. High shell exits remain uncertain:
the current sandbox worker can encode a child signal or startup/cleanup failure
as an exit code, so a numeric code alone cannot safely settle those cases.

The agent is instructed to explain the reason, preserve partial work, state what
is known or uncertain, and use the original receipt before retrying. Denial and
cancellation do not authorize another route or an automatic retry.

Host Codex tool validation publishes its failure before closing physical custody.
An unclassified validation exception carries the reviewed `tool_validation_failed`
message; internal telemetry retains the validation stage and sanitized failure
reason under the existing trace. The original cause remains private. Existing
reviewed account, workspace and policy failures keep their specific code. Strict
client replay receives only the public failure code and reference, while the
original operation and its uncertainty remain unchanged.

Subscription and API credential owners publish before their own physical close,
including failures below bootstrap. Existing reviewed failures retain their code;
new live credential failures retain their private cause and report the reviewed
validation code. Initial login failures keep their existing classification.
Initial bootstrap refusal and cancellation also keep their startup classification
until qualification completes and the lease is handed to its consumer.
Both credential owners consult that same handoff state on each failure, including
credential checks performed during initial model qualification. If the phase
cannot be read, the original failure and physical cleanup remain intact.

Trusted Git commit preparation does not repeat full provider and workspace
validation for every immutable object. It validates the complete owner before
and after object preparation and before the branch update, while synchronously
checking current authority and physical Git identities at each object write.
Owned temporary cleanup uses its original physical identity even after
revocation. Callers without a synchronous owner retain full asynchronous
validation at the original object-write boundaries. This shared host executor
does not alter provider-owned tools or settle an interrupted commit receipt.

## Verification and limits

Offline regressions exercise failed reads through the native adapter, shared
hooks, the registered Claude SDK callback, the Gemini provider loop and durable
history, and cold Codex reconciliation. They also preserve unknown writes,
cancellation, account changes, missing receipts and request-hash mismatches.
These are synthetic tests, not live-model or production recovery evidence.

Completion regressions cover both resumable and terminal Codex transports:
a settled thrown failure retains its failed result in SQLite, completes its
original downstream phase and admits a new command without replaying the tool.
The SDK callback and native-hook tests verify settled and unknown exceptions,
and rich/text feedback tests guard both directions of receipt loss. Existing
Gemini continuation, cancellation, cold recovery and queue-status tests retain
their independent failure and uncertainty checks. This does not rewrite earlier
unknown receipts or establish the cause of a particular production warning;
that requires the original conversation's operation evidence.

Telos regressions pass a refused audit update through the real backlog adapter
and both Codex completion transports, checking the unchanged canonical item,
durable failed receipt and subsequent command admission without replay. A failure
after a real canonical commit remains unknown, as does an explicitly uncertain
approval failure.

| Supported route                               | Recovery coverage                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Local Codex subscription and API accounts     | Credential-owner and bootstrap failures through the real lifecycle bridge; conversation, retained replay and client receipt rendering |
| OpenShell Codex subscription and API accounts | Shared native conversation diagnostics and host TaskExecution receipts; sandbox built-ins remain provider-owned                       |
| Claude SDK Vertex and personal accounts       | Registered credential callback, shared tool diagnostics and host TaskExecution receipts                                               |
| Anthropic-compatible API accounts (EnMaaS)    | Same registered Claude SDK callback; offline account, model and permission-mode admission regressions                                 |
| Legacy unbound Claude SDK                     | Same registered callback; no named Anthropic API account admission is implied                                                         |
| Gemini Vertex                                 | Deferred provider loop, shared tool diagnostics, durable failed-tool history and cancellation                                         |
| Retired custom OpenAI Responses engine        | Rejection remains enforced; supported Responses protocol accounts use the Codex harness                                               |

Historical shell operations without adequate terminal evidence still require
operation-specific reconciliation. This change does not recover every legacy
uncertain write, remove a stopped owner's fence, or automatically restart a
provider process. A deployed build and verification of the original retained
sessions are separate from PR acceptance.
