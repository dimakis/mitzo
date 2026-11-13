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

`TelosCreateSession` accepts the canonical item revision returned by
`TelosManageItem`, while retaining the separate relationship revision internally.
Both the canonical brief and current parent lead are rechecked during proposal review.

Validation uses real Telos/EventStore/task/workspace owners and the mounted HTTP
route/tool consumer, with simulated ordinary dispatch. The canonical native journey
covers both manual and lead starts with synthetic RPC responses and the pinned
qualified native artifact; it makes no real model calls. Local nested sandbox
restrictions can block its later artifact-export phase; CI and live acceptance are
separate evidence. No production activation is implied by these source changes.
