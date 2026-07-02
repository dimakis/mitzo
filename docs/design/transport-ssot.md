# Transport Single Source of Truth

**Status:** Proposed
**Author:** Claude Opus 4.6 + Dimitri Saridakis
**Created:** 2026-07-02
**Telos:** TBD
**Supersedes:** Parts of `session-state-machine.md`, `streaming-input-session-control.md`
**Related PRs:** #396 (never merged), #401 (merged, reverted via #403), #407

## Problem Statement

### The Symptom

User sends a prompt. Agent doesn't respond. User sends a second prompt. Agent wakes up and responds to both. This has been the single most persistent bug in Mitzo's history.

### The History

**45+ commits** across 3 transport architectures (raw WS, v2 multiplexed WS, SSE) have attempted to fix variants of this bug. 3 fixes were reverted after causing regressions. Every transport migration re-introduced the problem. The most recent attempt (PR #401, stable client connectionId) was merged and reverted within 16 hours because the connectionId was scoped per-tab instead of per-session, causing cross-session event routing.

### The Root Causes (Taxonomy)

| #   | Root Cause                                           | Fix Attempts                       | Current Status                 |
| --- | ---------------------------------------------------- | ---------------------------------- | ------------------------------ |
| 1   | Dead transport, messages silently dropped            | #53, #288 (proactive suspend)      | Mostly fixed                   |
| 2   | Dual source of truth (SessionRegistry vs EventStore) | #257, #362 (state machine routing) | Fixed for send/interrupt paths |
| 3   | iOS kills WS without readyState update               | heartbeat, #368 (force reconnect)  | Fixed for iOS                  |
| 4   | Ownership race on reconnect (connectionId changes)   | #401 (stable cid) -- **reverted**  | **Open**                       |
| 5   | Running state not synced on foreground               | #353, #407 (query meta)            | Fixed                          |
| 6   | Stale `running` in `newSession()` (never reset)      | Never attempted                    | **Open**                       |

### The Architectural Deficiency

There is no single, authoritative model of "is this session alive and accepting input?" Instead there are four overlapping, sometimes-stale signals:

| Location                        | Signal              | Updated By                         |
| ------------------------------- | ------------------- | ---------------------------------- |
| `EventStore.state` (SQLite)     | `SessionState` enum | `setSessionState()` callers        |
| `EventStore.is_active` (SQLite) | boolean             | `markSessionInactive()`            |
| `SessionRegistry` (in-memory)   | Map presence        | `register()`/`remove()`            |
| Client `messages.running`       | boolean             | Protocol events (sometimes missed) |

Each fix patches one signal without reconciling the others. Each transport migration creates new divergence paths between them. This is why the bug keeps coming back.

### Why This Is a Solved Problem

This is a chat application transport layer. Thousands of production systems have solved it. The industry has converged on a clear architecture:

| Platform               | Transport               | Generation Model                                 | State Authority                                             |
| ---------------------- | ----------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Anthropic (Claude.ai)  | SSE + HTTP POST         | Server-side with worker epochs                   | Explicit state machine (`idle`/`running`/`requires_action`) |
| OpenAI (Responses API) | SSE or WebSocket        | Server-side, chained via `previous_response_id`  | Connection-scoped, explicit events                          |
| LibreChat              | SSE + HTTP POST         | `GenerationJobManager` with persisted job status | Server job store (Redis/memory)                             |
| LobeChat               | SSE via tRPC            | Operation-based tracking                         | Server pushes canonical message snapshots                   |
| Vercel AI SDK          | Pluggable (SSE default) | Server-side stream                               | `activeStreamId` with resume                                |

**Common pattern across all:**

1. SSE for reads, HTTP POST for writes (with acknowledgment)
2. Generation is a server-side job that survives connection drops
3. Client "running" state is derived from server events, never used for routing
4. Sequence-based resumption on reconnect
5. Heartbeat-based liveness detection

## Solution: Server-Authoritative Transport

### Design Principles

1. **Server is the single source of truth.** The server owns session state. The client is a cache with explicit invalidation. Period.
2. **Client never queues based on local state.** `sendMessage()` always sends. The server decides what to do.
3. **Generation survives connection.** A generation is a server-side job. If the client disconnects, the generation continues. When the client reconnects, it re-subscribes.
4. **Explicit state transitions, not derived state.** The server emits authoritative state events. The client renders them. No guessing from event absence.
5. **Write acknowledgment, not fire-and-forget.** HTTP POST returns success or error. The message is not "sent" until acknowledged.

### Architecture

```
CLIENT                          SERVER
------                          ------

  |--- POST /send ----------------->|
  |<-- 202 { accepted, jobId } -----|    (write acknowledged)
  |                                 |
  |<-- SSE: state=running ----------|    (authoritative state)
  |<-- SSE: message_start ----------|
  |<-- SSE: block_delta ------------|
  |<-- SSE: block_delta ------------|
  |<-- SSE: state=idle -------------|    (turn complete)
  |                                 |
  |--- POST /send ----------------->|    (next turn, always immediate)
  |<-- 202 { accepted } ------------|
  |                                 |
  |  [SSE drops]                    |
  |                                 |    (generation continues)
  |--- GET /events?from=seq42 ----->|    (reconnect with cursor)
  |<-- SSE: replayed events --------|    (resume from seq 42)
  |<-- SSE: block_delta ------------|    (live events continue)
```

### Key Changes

#### 1. Remove Client-Side Routing on `running`

**Current:** `sendMessage()` checks `wasRunning`. If true, queues locally in `pendingSend[]`. Drains on `session_end` or after 5s timeout.

**Target:** `sendMessage()` always sends via HTTP POST. Server returns acknowledgment. No local queuing. No `pendingSend`. No safety-net timer.

The server already handles send-while-running correctly: `handleSendV2()` routes to `sendToChat()` which pushes onto the `AsyncQueue`. The SDK processes it on the next turn. This path is well-tested (used for takeover/reattach scenarios). The client-side queue is redundant and is the primary source of the current bug.

**Remove:**

- `wasRunning` branch in `store.sendMessage()` (~50 lines)
- `pendingSend[]` array in `ProtocolParserState`
- `PENDING_SEND_TIMEOUT_MS` constant and timer logic
- `pendingSend` drain in `session_end` handler
- `onSendQueued` callback
- `clearPendingSendTimer()` helper
- `pendingSend = []` in `switchSession`/`newSession`/error handler

**Keep:**

- `useQueuedMessages` in ChatInput (user-facing explicit queue feature, separate concern)
- `interruptMessage()` guard on `!running` (interrupt only makes sense when running)

#### 2. Explicit Server State Events

**Current:** Client derives `running` from:

- `SET_RUNNING` actions dispatched in various handlers
- `session_end` events (set `running: false`)
- `reconnected` message (carries `running: boolean`)
- `syncRunningState()` REST polling on foreground

**Target:** Server emits `session_state_changed` events with the authoritative state machine value:

```typescript
type SessionStateEvent = {
  type: 'session_state_changed';
  sessionId: string;
  state: 'idle' | 'running' | 'requires_action';
  // Maps from the 7-state internal machine:
  // CREATED/ENDED           -> 'idle'
  // STARTING/ACTIVE         -> 'running'
  // DETACHED/SUSPENDED      -> preserve last emitted (server buffers)
  // permission_request      -> 'requires_action'
};
```

The client binds UI to these events. No deriving, no guessing, no `SET_RUNNING` scattered across handlers.

**Why 3 states, not 7:** The 7-state machine (CREATED/STARTING/ACTIVE/DETACHED/SUSPENDED/CLOSING/ENDED) is the server's internal lifecycle. The client doesn't need to know about DETACHED vs SUSPENDED -- those are transport concerns, not UI concerns. The client needs exactly: "am I waiting?" / "is it thinking?" / "does it need my input?". This mirrors Anthropic's SDK (`idle | running | requires_action`).

#### 3. Unify Server-Side State

**Current:** Three independent state holders on the server:

```
EventStore.state (SQLite)     -- lifecycle enum, written by callers
EventStore.is_active (SQLite) -- boolean, written by markSessionInactive()
SessionRegistry (in-memory)   -- Map presence, runtime truth
```

Callers must remember to update all three. They diverge.

**Target:** One authority per concern:

| Concern         | Authority                              | Consumers                          |
| --------------- | -------------------------------------- | ---------------------------------- |
| Lifecycle phase | `EventStore.state` (the state machine) | Routing, reconnect, crash recovery |
| Process alive?  | `SessionRegistry.has()`                | Query loop management only         |
| Client display  | `session_state_changed` events         | UI rendering only                  |

**Changes:**

- Remove `is_active` boolean column from EventStore (redundant with `state`)
- Replace `handleReconnect`'s `storeMeta.isActive` check with state-based logic
- Add `recoverStaleSessions()` on startup: any session in ACTIVE/STARTING/DETACHED → ENDED
- Expose `state` in `/api/sessions/:id/meta` response
- Emit `session_state_changed` on every `setSessionState()` call

#### 4. Write Acknowledgment

**Current:** WS/SSE `send` is fire-and-forget. Client calls `connection.send()`, gets `true/false` for local buffer acceptance. No server acknowledgment.

**Target:** HTTP POST `/api/chat/send` returns a response:

```typescript
// Success
{ status: 202, body: { accepted: true, sessionId: string, seq: number } }

// Session ended / not found
{ status: 404, body: { error: 'session_not_found' } }

// Server overloaded
{ status: 429, body: { error: 'rate_limited', retryAfter: number } }
```

The client marks the message as "sent" only after receiving 202. On failure, it shows an error with retry. No ambiguity about whether the server received the message.

**Note:** This is already partially implemented -- the SSE transport uses HTTP POST for sends. The gap is that the client doesn't wait for or act on the response.

#### 5. Sequence-Based Resumption

**Current:** EventStore already assigns monotonic sequence numbers to events. The periodic sync mechanism uses cursors. But reconnect still attempts full state reconstruction via `handleReconnect`.

**Target:** SSE reconnect sends `?from=<lastSeq>`. Server replays events from that sequence number. No full state reconstruction, no `handleReconnect` ownership dance.

Combined with the state event, reconnect is trivial:

1. Client opens SSE with `?from=lastSeq`
2. Server replays missed events (including any `session_state_changed`)
3. Client is caught up. Done.

#### 6. Heartbeat Liveness

**Current:** Various heartbeat mechanisms across transports, inconsistent.

**Target:** Server sends SSE `ping` every 20 seconds. Client tracks `lastHeartbeatAt`. If no heartbeat for 40 seconds, client tears down SSE and reconnects (with cursor). This is proactive failure detection -- the client knows the connection is dead before the user tries to send.

## Migration Plan

### Phase 0: Foundation (no behavior change)

1. Add `session_state_changed` event to the protocol
2. Emit it from `setSessionState()` alongside existing events
3. Add `state` field to `/api/sessions/:id/meta` response
4. Client receives and logs `session_state_changed` but doesn't act on it yet
5. Add crash recovery: `recoverStaleSessions()` on server startup

**Tests:** Verify state events are emitted on every transition. Verify crash recovery marks stale sessions as ENDED.

**Dead code removal:** None yet. Additive only.

### Phase 1: Server-authoritative state (client reads from SSOT)

1. Client replaces all `SET_RUNNING` dispatch sites with `session_state_changed` handler
2. `running` in messages reducer derived from `session_state_changed.state === 'running'`
3. Remove `syncRunningState()` REST polling (state events make it unnecessary)
4. Remove `running` field from `reconnected` and `session_switched` messages (replaced by replayed state events)
5. Remove `is_active` boolean column from EventStore
6. Replace `handleReconnect`'s `storeMeta.isActive` check with `storeState`-based logic

**Tests:** Verify `running` state transitions match server state in all scenarios (new session, reconnect, iOS foreground, session switch). Verify reconnect works with state-based check.

**Dead code removal:** `markSessionInactive()`, `syncRunningState()`, `SET_RUNNING` action type, `running` field in reconnect/switch messages.

### Phase 2: Always-send (remove client routing)

1. Remove `wasRunning` branch from `sendMessage()`
2. Remove `pendingSend[]`, `PENDING_SEND_TIMEOUT_MS`, drain logic, timer, callbacks
3. Client awaits POST response before marking message as sent
4. Add retry with exponential backoff on POST failure (max 3 attempts)
5. Add `sendError` UI state for permanent failures
6. Heartbeat liveness: 20s ping, 40s timeout, auto-reconnect

**Tests:** Verify send-while-running works (server queues via AsyncQueue). Verify POST failure shows error UI. Verify heartbeat timeout triggers reconnect. Verify no message loss on reconnect during generation.

**Dead code removal:** `pendingSend`, `onSendQueued`, `clearPendingSendTimer`, `PENDING_SEND_TIMEOUT_MS`, `drainOne`, safety-net timer in `sendMessage`, `pendingSend` drain in `session_end` handler, `pendingSend = []` in switch/new/error handlers.

### Phase 3: Clean reconnect (sequence-based)

1. SSE reconnect uses `?from=<lastSeq>` parameter
2. Server replays events from cursor (already supported by EventStore)
3. Remove `handleReconnect` ownership dance
4. Remove `doReconnectPost` and associated state management
5. Remove periodic sync polling (cursor-based replay replaces it)

**Tests:** Verify reconnect replays missed events correctly. Verify no duplicate events. Verify generation continues during disconnect and events are available on reconnect.

**Dead code removal:** `handleReconnect` (ws-handler-v2.ts), `doReconnectPost` (sse-connection.ts), periodic sync timer and `shouldSync` logic (connection-registry.ts), `reconnect` message type.

### Phase 4: Cleanup

1. Remove WS transport code (if SSE migration is complete by this point)
2. Remove `SessionSseRegistry` if consolidated into `ConnectionRegistry`
3. Remove stale connectionId/ownership management code from PR #401 revert residue
4. Update all design docs to reflect new architecture
5. Archive `session-state-machine.md` Phase 4 (crash recovery is now Phase 0)

## Files Involved

### Server

| File                                   | Changes                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `server/query-loop.ts`                 | Emit `session_state_changed` on state transitions                          |
| `server/chat.ts`                       | Emit state events from `startChat`/`sendToChat`; crash recovery on startup |
| `server/ws-handler-v2.ts`              | Remove `handleReconnect`; replace `is_active` checks with state-based      |
| `server/index.ts`                      | Call `recoverStaleSessions()` on startup                                   |
| `server/app.ts`                        | Add `state` to meta endpoint response                                      |
| `packages/protocol/src/event-store.ts` | Remove `is_active` column; emit events from `setSessionState()`            |
| `packages/protocol/src/types.ts`       | Add `SessionStateEvent` type                                               |
| `server/connection-registry.ts`        | Remove periodic sync; simplify to cursor-based replay                      |

### Client

| File                                     | Changes                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/client/src/store.ts`           | Remove `wasRunning` queuing; await POST ack; remove `syncRunningState`           |
| `packages/client/src/protocol-parser.ts` | Handle `session_state_changed`; remove `pendingSend` drain; remove `SET_RUNNING` |
| `packages/client/src/sse-connection.ts`  | Reconnect with `?from=lastSeq`; remove `doReconnectPost`; add heartbeat timeout  |
| `packages/client/src/connection.ts`      | Same cursor-based reconnect if WS still active                                   |
| `frontend/src/components/ChatInput.tsx`  | No changes (useQueuedMessages is a separate user-facing feature)                 |

### Dead Code Candidates (cumulative removal)

```
// Client
- PENDING_SEND_TIMEOUT_MS constant
- pendingSend[] array and all drain logic
- wasRunning queuing branch in sendMessage()
- clearPendingSendTimer()
- onSendQueued callback
- SET_RUNNING action type (replaced by session_state_changed)
- syncRunningState() REST polling
- doReconnectPost() and associated state
- periodic sync timer

// Server
- markSessionInactive() (replaced by setSessionState(ENDED))
- is_active column in EventStore sessions table
- handleReconnect() ownership dance
- running field in reconnected/session_switched messages
- shouldSync() / periodic sync replay logic
```

## Open Questions

1. **WS removal timeline:** Phase 3 assumes SSE is the primary transport. If WS is still active, cursor-based reconnect needs to work for both. Should we complete the SSE migration first?

2. **Multi-device fan-out:** The current architecture assumes one client per session. If we want multi-device (phone + laptop viewing same session), the job-based model enables it naturally. Worth designing for now or deferring?

3. **EventStore migration:** Removing `is_active` requires a SQLite migration. Should we add a backwards-compatible `state`-only path first, or migrate in one step?

4. **Heartbeat interval:** 20s matches Anthropic's SDK. Should we make it configurable for development (faster detection during testing)?
