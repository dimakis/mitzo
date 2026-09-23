# Native deliberation admission

`/deliberate` uses the general EventStore execution/attempt lifecycle. Symposium
records model manually approved seat deliveries, not this sequential debate.
Reusing them would add a second root lifecycle. Ordinary chat admission remains
unchanged; deliberation composes the same `beginExecution`, `beginProviderAttempt`,
and token-fenced terminal transitions directly.

One originating client command ID admits one root execution. Its versioned hash
binds trimmed task text, the full behavior-changing deliberation configuration,
the caller's selections, and an opaque revision of the actual environment-backed
provider routes and credentials. No credentials or private endpoints are stored.
The route is checked again before each child dispatch. Each phase uses a stable
`deliberate:<executionId>:<phase>` attempt ID; an existing attempt never dispatches
again. The harness accepts a narrow call boundary and provider factory so durable
admission precedes construction and each child attempt precedes phase events.

Exact retries only inspect the original receipt; they never restart orchestration.
A new command following an ambiguous outcome requires `/deliberate --confirm-ambiguous <task>` (or `confirmAmbiguous: true` in the API),
matching the existing explicit ambiguous-retry API convention. Confirmation never
changes the meaning of an already admitted command ID. Recovery uses EventStore's
existing orphan recovery. A restart after any incomplete dispatch is ambiguous;
a failure before dispatch is safely failed. Cancellation records uncertainty for
an in-flight provider and fences late results and all later phases.

Usage-only commands do not enter this path. `/fuse`, automatic closeout,
Symposium behavior, reconnect protocol, and provider-route migration are deferred.

SSE and WebSocket enter the same root admission gate. For paid deliberation the
root receipt replaces the generic HTTP send receipt, so retries recheck current
configuration rather than bypassing conflict checks. A deterministic session ID
handles sessionless requests across both transports; its assignment and watch
registration occur after admission and before the first reasoning event.

Implicit Anthropic SDK retries are disabled for admitted calls, and cancellation
signals reach both adapters. Historical outcomes are read from durable terminal
events, so later generations cannot turn an old failure into apparent success.
