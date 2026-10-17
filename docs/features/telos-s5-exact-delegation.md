# Telos S5 exact slice delegation and recovery

S5 extends the accepted S4 owners at `d0b06dc200a154ef055a4e6f0eb386c4eb208607`.
The refreshed main contains that commit. Existing parent `85e8444019a4ae4a`,
S4 `4cd96f8d0f5a5f3f` and S5 `cf8dc85a4b6afaad` remain the tracking records.
Dimitri explicitly separated S4 qualification from starting S5; this implementation
and its offline checks do not close S4's interactive mock qualification.

## Exact request and ordinary worker

A retained ordinary outcome lead receives `TelosStartSlice`. It takes one exact
child ID and request ID. An ambiguous or missing child must be resolved in the lead
chat; the host accepts no title guessing, outcome-wide dispatch or sibling list.
Native Codex and the existing Telos MCP adapter use the same strict input and
internal route. Existing tool permission policy applies without an added custom
confirmation. Held profile tool-source activation remains held.

`POST /api/internal/telos/work/delegate` rechecks the internal credential, exact
client/session owner and current lead across awaits. The authenticated operator
route is `POST /api/telos/work/delegation/start`; its full reviewed input cannot
supply an allocation receipt. Both reach the same host and provision-only method
on `TaskOrchestrator`. The legacy raw attempt command cannot allocate a worker.

The host reviews the canonical child, complete ancestor revisions, selected source
custody and immutable artifact pins before retaining the first intent. Later fences
check unchanged canonical rows, material authority and current lead assignment.
The ordinary runtime/catalog/profile owners authorize the retained settings. A new
independent workspace uses the same pinned repository revision; the lead workspace
and immutable role context are preserved.

The ordinary preparation receipt atomically includes its delegation attempt marker.
It exists before role or TaskStore linkage, so a crash in that interval cannot make
an incomplete worker executable. Work context remains the S4 versioned context;
S5 adds no `executionTaskId` to it. The separate immutable TaskStore binding records
attempt, child, lead, worker, context snapshot and full context hash.

## Recovery and execution authority

Default start requests recover the current original attempt. Duplicate and concurrent
requests cannot allocate separate workers. A lost response or crash reuses its durable
allocation operation, ordinary session and exact task mapping. Uncertain acquisition
retains its identity instead of silently starting another acquisition. Explicit retry
requires the exact predecessor and preserves earlier chats, tasks, artifacts and links.
New chats never replace the item's current assigned worker.

Creation returns a coherent `chat_ready` / `execution: not_started` receipt with exact
worker, item and lead paths. It submits no worker command and chooses no attached
client. A later lead or worker model/thinking change does not replace a committed
creation receipt or rebind its worker. Immutable account, runtime target, workspace,
profile/context and permission authority remain checked.

Local and OpenShell first sends, continuations, native enqueue and provider dispatch
renew the durable scope through the existing ordinary owners. Incomplete or mismatched
linkage fails before execution. Only the proved worker receives its mapped task context;
TaskStatus and task mutations recheck that exact scope. Native OpenShell task tools and Local task MCP callbacks pin their original worker and task in HTTP headers; the route checks both before mutation so client rebinding cannot redirect a delayed request. Legacy unbound task MCP retains its dynamic task progression. Legacy loop start rejects mapped
Telos tasks. The worker cannot create task children or broaden the mapped brief.

| Fact                          | Evidence owner                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------- |
| Chat ready                    | Retained ordinary allocation and Telos delegation receipt                         |
| Command admitted or executing | Existing ordinary command/native execution receipts                               |
| Output saved                  | Existing artifact owner or task output record                                     |
| Worker reports done           | Exact mapped task enters `pending_review`                                         |
| Verified completion           | Separate review/acceptance; never inferred from chat creation or worker reporting |

## Approved receipt presentation

The receipt is a real navigation row in the originating lead transcript, including
through ChatArea's tool grouping. It matches the approved mock's message/diagonal-arrow
icons, metadata, creation provenance and row geometry. The user and composer stay in
the lead until the worker link is activated. Existing retained-role UI provides the
worker's exact item and lead return links. Receipt rendering makes no current running
or completion claim. See the shared UI contract and retained mobile/desktop captures.

The frozen design remains parent artifacts at **r1**: mock
`9d0559132154b92d0bbb427a982a0002`, standalone `ff847891190287af7dc8fae53e527a15`,
plan `5957850821c8afa3fd3b8e19e01fa34b`, UX contract
`c54d6f2479aab619b163187829b6bdff`, dependencies
`c99be8d519c5218a55640af3059c166b`, decisions
`ec3ff6f95811538c163be3602b6196e5`, manifest
`5707a8f5b093463065dfa663e1b6ff6f`. Approved mock SHA-256 remains
`97efd217cdd8246ee868a7165d2f0272b1d0b0fe76982d02dbb9f48abcfae4ab`.
No reference or protected Quick Chat Settings check is changed.

## Regression evidence and remaining gates

| Requirement                                                                         | Focused regression owners                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Exact child, ambiguous selection and real mounted lead route                        | `telos-work-delegation-host`, `telos-work-tools`, `telos-work-routes`           |
| Duplicate/concurrent delivery, restart and explicit predecessor retry               | `telos-work-delegation`, `telos-work-store`, `repository-delegated-workspace`   |
| Crash before role/linkage, mismatched attempt or allocation, actual command refusal | `telos-work-command-scope`, ordinary owned Local/OpenShell entry/consumer tests |
| Full context hash, no lead execution, exact task and evidence retention             | `telos-work-execution-authority`, `task-store`, `task-tools`, `task-context`    |
| No implied model turn, truthful receipt and later inference replay                  | Real ordinary/EventStore delegation and host tests; shared receipt schema tests |
| Native/MCP reachability and held tool-source compatibility                          | `codex-chat-session`, `telos-work-mcp`, catalog/selection tests                 |
| Visible approved receipt and retained lead draft                                    | Actual ChatArea/ToolPill component and intercepted mobile/desktop browser tests |

All local tests are offline with one worker and a 1 GiB Node heap. HTTP listener and
browser checks run through the approved execution tool outside Seatbelt. Browser
fixtures intercept traffic and invoke no backend or model. Independent Sol 6.1 UX
review covers the actual receipt source and refreshed captures; it does not claim
full-shell, live runtime, device or pixel-equivalence qualification.

CI, two distinct clean full-PR reviews and the trusted App-bound exact-head final
LGTM remain delivery gates. This change grants no merge or deployment authority.
Staging remains stood down. S6 controls, S7 workspace screens, S8 chooser/header/tree,
priority changes and shared S9 qualification remain separate scopes.
