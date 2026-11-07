# Tool deadlines and failure recovery

Implementation evidence as of 7 November 2026. This describes the candidate
source contract; acceptance and runtime deployment require separate evidence.

`@mitzo/harness` owns one asynchronous tool lifetime. Codex dynamic host tools,
Mitzo-hosted SDK tools and the deferred Gemini compatibility executor use
`runGuardedTool`. Nested adapters inherit the original lifetime. Defaults are
180 seconds of execution, 125 seconds of approval wait and 10 seconds of cleanup.
The existing permission owner still expires approval at 120 seconds. Time spent
awaiting a human decision does not consume the execution budget. Phase budgets
are cumulative, including when an adapter re-enters a phase.

Timeout or cancellation releases the caller even when an adapter ignores abort.
The original operation remains uncertain. Late promises are observed and their
callbacks retain the original retirement fence. This does not establish that a
remote mutation stopped. Cleanup has a fresh bounded lifetime so cancellation
does not skip resource release; each cleanup is attempted within the remaining
total budget. MCP shutdown retires calls immediately, closes each acquired or
late peer once, and bounds the caller's drain. Its `mcp.shutdown` trace records
failure even when best-effort shutdown continues.

An execution deadline immediately fences further callbacks and retires the
provider owner after retaining the failure. SDK callbacks abort their owning
session; Codex records the unknown result before closing its original transport.
The provider cannot continue issuing tools under the timed-out turn.

Cancellation joins the original adapter's cleanup within the cleanup budget,
keeping the original guard retired and its signal aborted. An exact native
RPC-consumed cancellation may race the adapter's privately settled refusal.
Only the original private settled-error receipt qualifies custody; rejection,
unqualified late success and cleanup timeout retain uncertainty. Gemini leaves a
cancelled in-flight call unanswered in durable history so restart projects its
unknown outcome before any new work.

`@mitzo/protocol` defines the shared failure envelope: `code`, `phase`,
`effectStatus` and `recovery`. Existing diagnostic IDs, task request IDs and
operation-specific repair guidance remain intact. A public envelope describes an
outcome and grants no authority. In particular, an MCP result cannot manufacture
the private settled-effect receipt needed for automatic continuation.

For TaskExecution, an authentication refusal before dispatch reports
`not_started` and asks the operator to reconnect this chat. An authentication loss
after dispatch retains `unknown` and requires inspection of the original
grant/request receipt. Invalid input, explicit denial and cancellation have
distinct recovery actions. Denial and cancellation never trigger automatic
continuation.

## Unexplained native approval expiry

The reported incident was an approval expiring before a native command started,
followed by the provider ending without an explanation. A shell execution
timeout could not govern that pre-execution wait.

The original approval owner now records a typed failure against the exact native
command, attempt, thread, generation, turn and call. If the provider ends without
explaining a settled, eligible failure, the durable queue can create at most one
reasoning continuation for the original command. The controller does not resend
the failed operation. It asks the agent to explain the retained result and the
next permitted step, preserving original intent, system prompt, model, thinking,
account, workspace and permission ownership.

Local and OpenShell execution owners derive admission from the consumed original
command and revalidate the receipt before enqueue, claim and dispatch. A native
queue row alone provides no execution authority. Repeated completion and restart
cannot create another child. A newer explicit user command supersedes an
undispatched child. Stop, owner/account change, unknown effects, recovery state,
explicit denial and cancellation suppress automatic dispatch. Recovery children
cannot request fresh native approvals or recursively create another child. Peer
and Symposium work keep their separate delivery/consent owners.

Only ordinary prelaunch command approval can certify `not_started`. Subcommand,
managed-network and stdin callbacks retain unknown parent effects. An actual user
denial stays a denial even if handling resumes after expiry. Recovery selection
runs after terminal projection marks all unfinished native items unknown, so an
earlier settled failure cannot override a later missing result.

## Coverage and limits

The shared guard covers Mitzo-hosted adapter callbacks; native commands and
provider-owned SDK tools still use their provider/process lifecycle and existing
execution limits. Native approval expiry is covered separately above. No result
from this implementation certifies termination of an external process or remote
effect. A blocked JavaScript event loop cannot be preempted by a JavaScript
timer. The incident's event-loop stalls still need CPU attribution and work
isolation; this change does not claim to repair their cause. The legacy
task-board MCP HTTP client also retains its own lifecycle and needs separate
deadline adoption if enabled.

Offline regressions cover noncooperative callbacks, late settlement, cancellation,
approval versus execution accounting, cleanup stalls, MCP drain, TaskExecution
authentication and denial, native approval expiry, owner admission, durable
deduplication, restart, changed scope and newer user input. No live model or
production tests are part of this change.
