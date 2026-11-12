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

## Verification and limits

Offline regressions exercise failed reads through the native adapter, shared
hooks, the registered Claude SDK callback, the Gemini provider loop and durable
history, and cold Codex reconciliation. They also preserve unknown writes,
cancellation, account changes, missing receipts and request-hash mismatches.
These are synthetic tests, not live-model or production recovery evidence.

Historical shell operations without adequate terminal evidence still require
operation-specific reconciliation. This change does not recover every legacy
uncertain write, remove a stopped owner's fence, or automatically restart a
provider process. A deployed build and verification of the original retained
sessions are separate from PR acceptance.
