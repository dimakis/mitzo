# Context measurement contract v1

This contract is the qualification slice for Telos `a8cf488c91067f04`. It provides
typed observations, pure adapters and an inspection port, not an API endpoint or
composer UI. See the [pinned matrix](../operations/context-measurement-matrix.md)
for evidence and unsupported routes, and [handoffs](context-measurement-handoffs.md)
for integration owners.

## Shared snapshot

[`ContextMeasurementSchema`](../../packages/protocol/src/context-measurement.ts)
is the canonical schema and exports inferred TypeScript types through
`@mitzo/protocol`. Version 1 contains:

- Identity: session, optional thread/query/turn, parent or subagent scope and
  mandatory owner generation. Child observations require parent identity.
- Binding: engine, placement, exact model, opaque account reference, runtime
  binding revision and optional inspected runtime version. No credentials.
- Host observation time and explicit current/stale/unknown freshness. Receipt
  time does not establish the provider's request time.
- Measurement basis and method, assurance, optional estimated used tokens or
  latest-request usage, category rows and source contributions.
- Separate model limits (existing `ModelTokenLimitsSchema`), resolved compaction
  window, usable window, buffer/free observations and capacity freshness.
- Signed residual and reconciliation status. Unknown is distinct from zero.

Known numeric fields must be safe, finite, nonnegative integers; capacities are
positive. Signed residual can be negative. Arrays and strings are bounded, IDs
must be unique and contribution category references must exist. Unknown major
versions and invalid known fields are rejected. Additive object fields are
stripped rather than forwarded. Unknown upstream category IDs remain opaque;
unknown kinds map to `unknown` and never enter usage arithmetic. Labels never
determine kind. Future changes to semantic enums require an explicit adapter or
version decision; they cannot silently become a known measurement.

## Accounting semantics

`used` occupies the window; `free` is remaining space; `buffer` is compaction
reserve; `deferred` describes out-of-window schemas. Deferred and buffer counts
do not inflate used content. The adapter preserves reported free/buffer values;
it never derives missing values from a guessed capacity. A policy window is not
automatically the model's hard limit. The Claude control does not establish which
one its resolved window represents, so its capacity kind stays unknown.

Claude structured totals are estimates. Summary uses last-response usage and
local estimates. Full performs per-category token-count work but some drilldown
shares remain estimates, so the overall assurance is mixed and rows conservatively
remain estimated. The adapter preserves `totalTokens` unchanged and records
`totalTokens - sum(known used rows)` as a signed residual. It neither clamps
overage nor distributes disagreement. Unknown kinds make reconciliation unknown;
a negative residual is inconsistent, a positive residual is partial.

Drilldowns are not additional usage. The initial adapter labels their relation
unknown until an upstream partition guarantee is established. Their opaque
snapshot-local references are not stable file identifiers and confer no source
access. Paths, names and private contents are not forwarded. An authorized
drilldown resolver is future integration work, not delivered by this slice.

Claude raw response input, cache-read and cache-creation buckets count once each
for latest-request input; do not accumulate repeated prompt input across requests
as occupancy. Codex cached input is already included in input, and reasoning
output is included in output. The Codex adapter reuses `observedCodexUsage`
validation, retains `last` input/output accounting, and leaves `usedTokens` absent.
Session cumulative totals and `last.totalTokens` do not prove current occupancy.
The schema rejects usedTokens on latest-request or host-assembly observations.

Parent and child runtime contexts remain separate. Definitions of agents in the
parent prompt can contribute there, but a child runtime's usage cannot update the
parent gauge. Host assembly and historical read/search inventory show sources
considered or submitted, not what remains after native truncation or compaction.

Freshness must be invalidated by the integration owner on model/account/runtime,
thread/query generation, compaction or relevant input changes. Reconnect does not
make retained observations current. Consumers must treat stale/unknown capacity
as unavailable for free-space calculations and label estimates/latest-request
observations accordingly. This contract is display evidence, not admission or
budget enforcement.

## Adapter and control interface

[`context-measurement-adapters.ts`](../../server/context-measurement-adapters.ts)
normalizes already obtained Claude controls and Codex events. Codex requires
matching thread and turn; Claude requires the bound model. Both validate the
shared snapshot before returning it. No adapter opens a runtime or accesses
provider history.

[`inspectClaudeContext`](../../server/context-measurement-control.ts) accepts an
already authorized current-owner accessor, AbortSignal and optional bounded
deadline (default 5 seconds, maximum 30). It feature-detects `getContextUsage`,
binds the real query receiver and always passes explicit detail. Summary is the
default; full requires a host-supplied `authorizeFull` check before invocation and
after response. Missing authority never falls back to full, generation or another
account. Ordinary Claude/OpenShell is refused before calling a control.

The current-owner accessor must expose the **actual active native query**, not a
stable proxy that hides query replacement. Its identity and binding must come
from the existing runtime owner. The adapter captures validated identity and
checks it again after asynchronous authority and control responses. Replacement,
retirement, account/model changes or a changed query discard late results.
Integration must publish the owner generation at native query creation and clear
active state at retirement. The port alone does not wire those lifecycle events.

Each call owns its deadline and cancellation; no cross-caller cache/coalescing is
implemented. Integrators should avoid polling and coalesce only while identity,
detail, cancellation and authority lifetimes remain compatible. A timed-out call
discards late responses; it does not claim provider cancellation or undo token
count overhead. Do not immediately retry an uncertain full request.

Failures are typed: unsupported route, missing control, retired query, changed
scope, timeout, cancellation, invalid response, control failure and missing
token-count authority. Unexpected failures are logged with bounded stage/reason/
session metadata. Raw SDK error messages and response payloads are never surfaced.

## Qualification boundary

The tests in `server/__tests__/context-measurement.test.ts` are offline fixtures.
They cover invalid numbers/shapes, unknown fields/kinds, overlap/residual, cache
subsets, identity changes, unavailable routes, token-count authority, failures,
timeouts and cancellation. They do not qualify an actual model, network endpoint,
ordinary OpenShell runtime or current token occupancy. Live model or token-count
qualification requires a separately declared supported Luna model and charged
account; another model requires specific approval.
