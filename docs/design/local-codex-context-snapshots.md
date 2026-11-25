# Local Mac Codex context snapshot adapter

Ordinary contribution to existing slice `c99ca90aebf84f77`; canonical ownership
is unchanged. This candidate depends on #1431 at
`18afc8a0a0d196687df50fd3301a454bb1e9e28d`, which depends on #1424 at
`d88b662f20bd77cf9f06e6f2b04c6ee72886bf63`. The incremental review starts at
that exact #1431 commit. Neither its source checkout nor the separate held
`413c30fc` integration is modified.

## Installed path

`app.ts` injects its existing `createRuntimeContextSnapshots` instance into the
Codex chat composition through a registry-keyed WeakMap. Only owned Local Mac
sessions receive the adapter. The authenticated router and native owner share
the same lifecycle and EventStore; no runtime, account or coordinator is created
for inspection.

After the exact `turn/start` response and durable ownership acknowledgment,
`CodexConversation` captures the existing command, native transport generation
and account binding. Its passive scope accessor includes session/thread/turn,
model, account, runtime policy revision, CLI version and a generation minted
once at acknowledgment. It performs no RPC or acquisition. Replacement,
transport loss and terminal notifications retire that witness before async
completion work. Notifications from an old transport cannot enter its successor.

The existing `CodexSessionEvents` mapper forwards validated, exact-thread/turn
token usage and deduplicated compaction events. The adapter normalizes with
`normalizeCodexContext` and pushes through `ContextSnapshotLifecycle.observe`.
The cumulative usage watermark rejects duplicate and decreasing observations,
including replays across compaction and attachment changes. New turns replace
the owner. Current host authority, runtime ownership and registry attachment
remain required; old owner callbacks cannot invalidate a replacement owner's
evidence. Existing `provider_usage`, token updates and cost accounting remain
on their existing path.

The port omits `collect`, so explicit refresh reports `refresh_unsupported`.
Authenticated GET/replay reads retained evidence without starting a request or
acquiring an account/runtime/generation. Recovered lifecycle evidence remains
stale until separately verified by a new native observation.

## Measurement and qualification boundary

`tokenUsage.last` is the latest request, not current context occupancy. The
legacy `observedCodexUsage.agentContext` display still uses `last.totalTokens`,
but the snapshot never copies it into `usedTokens` or an occupancy percentage.
Request usage is retained with its latest-request basis; occupancy, categories,
contributions and free capacity remain unknown. Codex freshness is unknown,
and the consumer receives stale evidence rather than an invented current value.

This installs the Local Mac path and qualifies it with offline native transport
fixtures. It does not qualify live provider behavior, full occupancy/category
attribution, OpenShell Codex, either Claude placement, or the complete
both-placement slice. Shared runtime `d6c89fbaa86354d6` remains downstream.
Frontend/inspector work is a separate contribution.

## Verification

On 21 November 2026, 848 tests passed across the Codex adapter, chat-session,
conversation, session-events, turn-usage, context-snapshot-lifecycle and
context-measurement suites. Tests use the existing offline native RPC transport,
real SessionRegistry, SQLite EventStore, lifecycle and authenticated Express
router. They cover wrong thread/turn, pre-acknowledgment usage, duplicate/late
events, compaction, terminal completion, model/account/runtime replacement,
transport replacement/loss, detach/reattach, authority revocation and passive
recovery. Legacy latest-request display and cumulative accounting are asserted
separately from snapshots.

Focused adapter/event/lifecycle TypeScript checks and protocol/harness builds
passed. The broader conversation/chat-session typecheck exhausted the required
1 GiB Node heap; full server/UI builds remain unverified locally. Tests ran with
one worker and the 1 GiB heap. Dependencies were copied into this independent
checkout from the ordinary source contributor's matching-lockfile installation
after the registry install timed out with DNS failure; the workspace SQLite
addon was rebuilt locally. No release dependencies were borrowed.

No browser startup, live provider/token-count probe, CI babysitting, merge or
deployment was performed. Landing still requires dependent integration,
exact-head CI, trusted Centaur final LGTM and merge recommendation, and the valid
App gate. Source fingerprint validation is not independent review or four-route
qualification.
