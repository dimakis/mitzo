# Delivery Guarantee: Disposable Connections, Session-Scoped Cursors

**Status:** Proposed
**Date:** 2026-06-27
**Author:** Claude (with Dimitri)
**Triggered by:** PR #401 revert (dimakis/mitzo#403) — stable connectionId caused browser hangs + session bleed

## Context

PR #401 introduced stable client-generated connectionIds to preserve delivery cursors across SSE reconnects. This caused two critical bugs:

1. **Browser hang**: Race condition in `SessionSseRegistry` — old SSE close handler fires after new stream registers, deletes the new stream. Periodic sync retries endlessly (missedCount up to 48).
2. **Session bleed**: One connectionId accumulates `watchedSessions` across reconnects, routing events for multiple sessions through a single transport.

The bug was intermittent and self-healing (60s `INACTIVE_TTL_MS` circuit breaker cleaned poisoned state), making it worse than a hard crash — silent corruption that resolves before you can diagnose it.

## Key Finding: The Architecture Was Already Right

Post-revert analysis revealed that the existing (pre-#401) code already implements the correct pattern. PR #401 was solving a problem that didn't exist:

| Concern                             | Already handled by                                      | PR #401 added                                          |
| ----------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Cursor persistence across reconnect | Client-side `seqBySession` sent in reconnect POST       | Server-side cursor persistence via stable connectionId |
| Missed event replay                 | `handleReconnect()` fetches from EventStore immediately | 60s inactive TTL + periodic sync as backup             |
| Connection identity                 | Ephemeral server-generated ID per SSE stream            | Client-generated stable UUID per tab                   |
| Transport swap                      | New connection registers, old one cleans up             | In-place transport swap with race-prone cleanup        |

The reconnect handler (`ws-handler-v2.ts:223`) already:

1. Accepts client-provided `lastSeq` per session
2. Fetches missed events from EventStore
3. Replays them immediately over the new transport
4. Resets server cursor to last replayed seq

This is the correct pattern. PR #401's connection identity layer was redundant infrastructure that introduced the race.

## Production Reference Architecture

Every production real-time system converges on the same pattern:

### Discord Gateway (RESUME)

- Connection gets a session_id + sequence number on IDENTIFY
- On disconnect, client sends RESUME with `{session_id, last_sequence}`
- Server replays missed events from its buffer
- Connection identity is ephemeral — RESUME is keyed by session, not connection
- If buffer is exhausted: full re-IDENTIFY (fresh state)

### Slack Real-Time Messaging

- Connection gets a `connection_id` — but it's for debugging, not delivery
- Reconnect uses `?recover=true` with last event timestamp
- Server replays from its event buffer keyed by workspace/channel
- Connection is disposable; recovery state is per-subscription

### Firebase Realtime Database

- Uses native SSE `Last-Event-Id` header
- Server replays from that point on reconnect
- No connection identity at all — the protocol handles it

### Server-Sent Events Spec (W3C)

- `id:` field in SSE frames → browser stores as `lastEventId`
- On reconnect, browser sends `Last-Event-Id` header automatically
- Server uses it to replay — zero client code needed for basic case

### Common Pattern

```
Connection = disposable transport pipe
Session = durable subscription with cursor state
Reconnect = "resume my session from cursor X"
Server = replay from durable store, not from connection state
```

## Current Architecture (Post-Revert Baseline)

```
┌─────────────────────────────────────────────────┐
│ Client (SseConnection)                          │
│                                                 │
│  seqBySession: Map<sessionId, lastSeq>          │
│  ← tracks delivery client-side                  │
│                                                 │
│  connect() → GET /api/chat/events               │
│  on welcome → POST /api/chat/reconnect          │
│    sends: [{sessionId, lastSeq}, ...]           │
│  on message → update seqBySession               │
└──────────────────┬──────────────────────────────┘
                   │
        SSE stream │  POST requests
                   │
┌──────────────────▼──────────────────────────────┐
│ Server                                          │
│                                                 │
│  GET /events → new connectionId, register,      │
│                send welcome                     │
│                                                 │
│  POST /reconnect → for each {sessionId, lastSeq}│
│    1. watch(connectionId, sessionId)            │
│    2. resetCursor(connectionId, sessionId, seq) │
│    3. getEventsAfter(sessionId, lastSeq)        │
│    4. replay immediately over transport         │
│    5. resetCursor to last replayed seq          │
│                                                 │
│  ConnectionRegistry:                            │
│    cursors: Map<connectionId, Map<sessionId,    │
│             seq>>                               │
│    periodic sync: 5s safety net                 │
│                                                 │
│  EventStore: durable SQLite (source of truth)   │
└─────────────────────────────────────────────────┘
```

This is already the Discord/Slack/Firebase pattern:

- Connections are disposable (new ID per SSE stream)
- Client provides cursors on reconnect
- Server replays from durable store
- Periodic sync is a safety net, not primary delivery

## What's Actually Missing (Refinements, Not Redesign)

### 1. SSE `Last-Event-Id` for Single-Session Fast Path

The SSE spec gives us free reconnect for the common case (one active session). Currently unused.

**Change**: Include session-scoped seq as the SSE `id:` field. On auto-reconnect, browser sends `Last-Event-Id` header. Server can replay without waiting for the reconnect POST.

**Limitation**: Only works for the active session. Multi-session watching still needs the POST path. Use `Last-Event-Id` as a fast path, POST as the full path.

```
SSE frame today:     data: {"type":"text_delta",...}\n\n
SSE frame proposed:  id: session:abc123:seq:4507\ndata: {"type":"text_delta",...}\n\n
```

Server parses `Last-Event-Id` on new connection:

- If present: replay from that seq for that session immediately (before welcome)
- If absent: wait for reconnect POST (current behavior)

### 2. Reconnect POST Deduplication

Events arriving between SSE stream open and reconnect POST completion are delivered twice — once live, once via replay. Currently harmless (client-side seq tracking skips duplicates in `seqBySession`), but wasteful.

**Change**: Server skips replay of events with seq ≤ the connection's current cursor (set by live delivery during the gap). The `resetCursor` call already advances forward-only, so this is mostly handled. Verify with a test.

### 3. Periodic Sync Interval Tuning

5s is aggressive for a safety net. Production systems use 15-30s for background sync.

**Change**: Increase `SYNC_INTERVAL_MS` from 5000 to 15000. The reconnect POST handles immediate recovery; periodic sync only catches edge cases where the POST itself failed.

### 4. Stale Worktree Polling Suppression

The logs show the periodic sync hammering EventStore for deleted worktree sessions every 5s. This is the noise that made the real bug harder to spot.

**Change**: `isSessionActive` callback should also check whether the session's worktree still exists. Skip sync for sessions with missing worktrees. (Or: unwatch sessions when their worktree is cleaned up.)

### 5. Connection Health Metric

No observability on connection lifecycle health. The #401 bug was only visible in logs.

**Change**: Emit OTel gauge for `mitzo.connections.active` (count), `mitzo.connections.reconnects` (counter), `mitzo.connections.replay_events` (histogram of events replayed per reconnect). Surface in Grafana dashboard.

## What NOT To Do

These are approaches that seem reasonable but lead back to the #401 failure mode:

| Tempting approach                                        | Why it fails                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stable connectionId across reconnects                    | Creates race between old close handler and new stream registration                     |
| Server-side cursor persistence independent of connection | Requires connection identity to key the cursor — back to stable IDs                    |
| In-place transport swap                                  | The SSE Response object lifecycle is managed by Express/Node HTTP stack, not by us     |
| Inactive TTL with deferred cleanup                       | Adds a time-bomb circuit breaker that masks bugs instead of preventing them            |
| Client-generated connection identity                     | Client can't guarantee uniqueness across tabs, and server can't validate without state |

## Implementation Plan

| Phase | Change                                                          | Risk                                | Effort |
| ----- | --------------------------------------------------------------- | ----------------------------------- | ------ |
| 1     | Increase periodic sync to 15s + suppress stale worktree polling | None                                | Small  |
| 2     | Add connection health OTel metrics                              | None                                | Small  |
| 3     | SSE `Last-Event-Id` fast path for active session                | Low — additive, POST path unchanged | Medium |
| 4     | Reconnect POST dedup verification + test                        | None                                | Small  |

Phase 1-2 are safe to ship together. Phase 3 is the only architectural change and should be its own PR with thorough testing.

## Decision

The post-revert architecture is already correct. The system implements disposable connections with client-provided cursors and immediate server-side replay — the same pattern used by Discord, Slack, and Firebase.

PR #401's mistake was adding a connection identity layer on top of an architecture that deliberately doesn't need one. The fix is not to redesign the delivery system, but to refine what's already working: tune the safety net, add observability, and optionally adopt the SSE `Last-Event-Id` fast path that the protocol was designed for.

Don't fight the transport. Connections are disposable. Sessions are durable. The EventStore is the source of truth.
