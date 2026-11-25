# Context snapshot transport and lifecycle

Ordinary contributor implementation for slice `879f5a86384c0ae9` under feature
`05f51bcee39031b1`. No canonical lead/worker assignment changes. This is a dependent
candidate based on PR #1424 at `d88b662f20bd77cf9f06e6f2b04c6ee72886bf63`.
Accepted main inspected before implementation was
`9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`; its Claude trace attribution changes
are not occupancy measurements. The separate held integration `413c30fc` is not
part of this branch. No main-only publication or landing is performed here.

## Delivered boundary

- `ContextSnapshotRequestSchema`, `ContextSnapshotResponseSchema` and the host-only
  `ContextSnapshotOwner` port build on contract v1 from #1424. Unknown additive
  response fields are stripped, unsupported versions and malformed known fields
  fail. A response cannot present another conversation's snapshot or mark missing
  or stale evidence available. Refresh request fields are strict.
- `EventStore.contextSnapshots` borrows the existing database, transaction and
  backup ownership. One last valid parent snapshot per conversation retains the
  complete measurement contract. A compare-and-set revision fences invalidation
  and competing writes; duplicate/older receipt times and wrong identities cannot
  overwrite it. Subagent measurements cannot overwrite the parent's row.
- `ContextSnapshotLifecycle` coordinates explicit collection, cancellation,
  retention, expiry and pre-retirement capture. It never creates a runtime, sends
  a generation request, estimates token counts or converts request usage to
  occupancy. Collection remains with each engine adapter.
- The ordinary session API mounts authenticated `GET /api/sessions/:id/context-snapshot`
  and `POST /api/sessions/:id/context-snapshot/refresh`. GET is passive and returns
  loading/available/partial/stale/unavailable evidence. POST also returns explicit
  cancelled/failed states. Both use `Cache-Control: no-store` and bounded reason
  codes; provider errors, source paths and prompts are not diagnostics.

**No native adapter installs the port in this candidate.** A normal refresh
therefore reports `adapter_not_attached`; it does not silently call the stable SDK
proxy. This installs the shared transport and lifecycle foundation, not an enabled
context inspector. Engine adapter installation, retirement/compaction hook wiring
and UI consumers remain dependent work with the owners below.

## Request and authority rules

Refresh JSON is `{requestId: UUID, detail: "summary" | "full", allowTokenCount?: true}`.
Detail defaults to summary. The request must carry `X-Mitzo-Context-Intent:
refresh-summary` or `refresh-full`, respectively, and pass the shared same-origin
JSON and current interactive operator guards. Full requires explicit token-count
consent in addition to current host authority; an adapter may still refuse it.
Internal-token requests do not carry browser authority and cannot inspect here.

Summary refreshes reuse current evidence for at most 30 seconds. Concurrent
summary work shares a collection only within one native owner, scope, attachment
generation and authenticated authority. Every waiter checks its own authority;
cancelling one waiter leaves siblings intact, while cancelling all cancels the
shared control. There are at most 64 tracked collections, each with a five-second
deadline. Timeout/cancellation fences late results even if a native control cannot
be physically interrupted. No automatic retry or full-detail fallback occurs.

A full request is claimed durably before dispatch. The same request ID cannot
repeat a possibly charged token-count operation after timeout, failure or restart;
duplicate replies say `superseded`, and changed authority/scope says
`request_conflict`. The response is a fresh passive cache view, not a fabricated
replay of a completed original request. A new explicit request ID is required for
another attempt. Claims live with the conversation and cascade on physical removal;
they are never pruned by age into permission to repeat a call.

Authority, native owner object, parsed scope and attachment generation are checked
at collection, authorization continuations, storage and response delivery. The
runtime resolver uses only `SessionRegistry`'s existing attached, unsuspended,
unaborted session. Registry detach/reattach and suspend/resume replace an opaque
attachment fence even if the native query or transport object is unchanged. This
fence is neither token usage nor evidence of a new native query.

## Freshness and persistence

The database stores observations, never active login authority. Cold restore
requires a new observation before evidence can be current, even if string IDs
match. A different current scope suppresses the old payload; the last valid row
is retained for truthful recovery. Stale evidence marks capacity stale as well.
Unknown capacity stays unknown. The 30-second cache bound is a host freshness
policy, not a provider occupancy guarantee or a compaction threshold.

Adapters call `invalidate(sessionId, reason)` on compaction, turn completion,
query retirement and runtime transitions. Invalidation also creates a revision
fence when there has never been a successful observation. Account/model/query/turn
replacement must replace the port and update its complete scope before another
operation can be accepted. Adapters push already-normalized Codex usage with
`observe(owner, snapshot)`; latest-request totals stay in `requestUsage`, with no
invented `usedTokens` or free space.

Before destroying an inspectable Claude native query, the adapter awaits
`captureBeforeRetirement` under its existing authority. It must retire the native
query in its **own finally**, even if capture/storage fails. Capture invalidates
earlier pending work, requests a new summary rather than accepting a recent cache,
and retains the result as stale after completion. A late or failed capture never
replaces the last valid snapshot. Full token-count work is never automatic at this
boundary.

## Reuse and implementation handoffs

- Propagation `9683053156990fed` under `ab5edf8fca9c4c9e` was read in full: active,
  unclassified, no saved implementation updates or owner. Its existing
  token/session propagation remains the owner of token updates. This candidate
  adds a measurement snapshot owner to the same EventStore rather than a second
  cumulative token store. No open competing snapshot PR was found in the inspected
  first 100 open PR records on 21 November 2026.
- Claude adapter slice: install a `ManagedSession.contextSnapshotOwner` only for a
  qualified actual native query/turn. Implement `collect` via #1424's
  `inspectClaudeContext`, forwarding the abort signal and full authorization. The
  supplied `assertCurrent` must run again after any adapter-owned async admission
  and immediately before native dispatch. Supply the actual query accessor, not
  `createSdkTurnQuery`'s stable proxy. Wire capture/retirement and compaction at the
  native owner; this candidate does not add hooks to either private SDK driver.
- Codex adapter slice: normalize trusted App Server events with
  `normalizeCodexContext`, prove exact thread/turn/runtime binding, then call
  `observe`. Event-only adapters omit `collect` and report `refresh_unsupported`.
  Both Local Mac and OpenShell retain their own runtime owners.
- Transport composition owns one `createRuntimeContextSnapshots` instance in
  `app.ts`. Adapter hook installation must receive that same lifecycle instance;
  constructing a separate coordinator would lose in-flight cancellation ownership.
- Composer ring `b08acd7f246ad19a` and inspector UI stay separate. Consumers should
  validate the response schema and display freshness, reason and accounting basis.
  No UI rebuild, polling loop or WebSocket token-update rewrite is included.
- Ordinary Claude/OpenShell stays blocked on shared runtime `d6c89fbaa86354d6`,
  lifecycle `e76c84742da6c0bf`, harness `477c9d52d200c0f6`, account routing
  `0d7dbc820e14e56d` and readiness `65129503d34b4bc3`, matching PR-monitor
  architecture `d55d0cc700b64680`. An installed port alone cannot enable this route.
  Historical inventory `0880117e42734402` remains inventory, not occupancy.

## Offline evidence and remaining qualification

Tests exercise the actual SessionRegistry, SQLite EventStore, control adapter,
normalizers and Express router, with in-memory query/provider fixtures. They cover
cancelled siblings, total cancellation, deadlines, late results, changed bindings,
replacement owner objects, compaction fences, parent/subagent separation,
malformed results, duplicate/out-of-order receipts, pre-retirement capture,
detach/reattach and suspend/resume, expiry, cold persistence restore, durable full
request deduplication, authority revocation and sanitized storage failure. Fixtures
cover Claude local summary/full, explicit unsupported Claude/OpenShell and both
Codex placements' latest-request accounting. These are offline control/consumer
probes, not installed native-runtime or provider qualification.

The shared HTTP guards were extracted unchanged from `connections-router.ts` into
`operator-http-authority.ts` and re-exported for existing consumers. This avoids
loading/typechecking the connection provider registry for a snapshot HTTP guard.
An initial targeted server typecheck reached the enforced 1 GiB heap through that
dependency; after extraction the same focused check passed within the bound.

Remaining delivery gates: engine adapter hook installation and runtime
qualification, UI/store integration, dependent-branch integration, CI and Centaur's
exact-current-head final LGTM/merge recommendation. No live model/token-count call,
paid qualification, merge or deployment was run. Live probes still require the
exact supported Luna model and charged account declared in advance; another model
requires explicit approval.
