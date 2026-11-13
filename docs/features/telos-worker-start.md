# Starting an allocated Telos worker

An assigned feature lead can use `TelosStartSlice` with its exact child and
`execute: true` after the operator authorizes execution. Without `execute`, the
tool still allocates or recovers a chat only. The worker receives its slice title
at allocation; recovery repairs an empty title and preserves a chosen name.

Execution reuses the existing workspace reservation, selected account/model/profile,
retained role, task binding, work holds and ordinary Local Mac Codex command owner.
It does not require a live child runtime or manual chat initialization. It does not
give general peer messaging permission to resume cold or stopped chats.

The response separates the historical `allocation` receipt from `execution`:
`admitted` records ordinary command admission; `started` requires retained provider
acceptance. Neither proves task completion. Failed and uncertain outcomes remain
explicit. A deterministic command identity and retained start event prevent aliases,
concurrent calls and lost replies from admitting duplicate first commands. An
uncertain startup without an ordinary receipt is inspected rather than replayed.

A worker with an existing command or native activity uses its original ordinary
recovery flow. This adapter does not override a changed reviewed brief, superseded
assignment, stop, cancellation, revocation, unavailable account or work hold.

The pending first command retains an exact source-runtime/operator/tool fence through
native bootstrap and immediately before provider dispatch. Each canonical assignment
check opens a fresh read-only work owner, so it outlives the completed setup request
without retaining that request's database connection. Source reassignment or startup-tool
revocation refuses dispatch before provider markers. The source fence is released only
after that first provider acceptance; later worker commands and tool continuations keep
their existing independent worker/operator authority and normal recovery behavior.

`TelosCreateSession` accepts the canonical item revision returned by
`TelosManageItem`, while retaining the separate relationship revision internally.
Both the canonical brief and current parent lead are rechecked during proposal review.

`TelosManageItem` reads include `workContext.currentLead` and `currentWorker` with
the canonical assignment revision, readable conversation name, navigation path,
saved runtime selection and an observed live/not-live/unknown state. The separate
`latestAllocation` preserves the original receipt. A different current worker is
never silently substituted into that receipt. `startExistingWorker` describes
route eligibility and the missing condition, not permission or provider readiness.
Mixed engines remain visible; the explicit startup adapter remains Local Mac Codex.

The sidebar and Conversations page offer Tree navigation with outcome orchestrators,
feature leads and slice workers. Current canonical assignments determine parents;
standalone features remain roots. Previous assignments, unreadable relationships
and unknown runtime details remain visible. Each row retains its own agent, engine,
execution location, model, status and actions. Loaded ancestors are navigable through
breadcrumbs, and unloaded parents/pagination are labelled. Peer discovery also uses
reviewed setup names for older unnamed Telos chats without reading their messages.

UI reuses navigation rows, shared semantic tokens, MotionDetails, SessionActivityStatus,
UiIcon and the existing action menu. Offline fixtures cover three levels and mixed
runtime metadata across phone/desktop themes. Browser execution in this host executor
is blocked by macOS Mach-port registration permissions; DOM and design tests are
separate from rendered visual evidence. No browser success or screenshots are claimed.

Validation uses real Telos/EventStore/task/workspace owners and the mounted HTTP
route/tool consumer, with simulated ordinary dispatch. The canonical native journey
covers both manual and lead starts with synthetic RPC responses and the pinned
qualified native artifact; it makes no real model calls. Local nested sandbox
restrictions can block its later artifact-export phase; CI and live acceptance are
separate evidence. No production activation is implied by these source changes.
