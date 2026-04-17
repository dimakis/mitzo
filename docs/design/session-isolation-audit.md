# Session Isolation Audit & Remediation — Design Document

> **Status:** Draft
> **Author:** Dimitri + Claude
> **Date:** 2026-04-17

## 1. Problem

Sessions bleed. Data, events, and state from one session appear in another. This manifests as:

- Task board status broadcasting to all connected clients, not just the owning session
- Frontend listeners surviving session switches, processing messages for the wrong session
- Token counters flashing to zero on session resume before async hydration catches up
- Global caches (repo config, skill registry, permissions) shared across sessions without scoping

Seven acute bugs were fixed this week (Apr 13–17):

| Fix                                                      | Commit    | Layer  |
| -------------------------------------------------------- | --------- | ------ |
| Unsubscribe old WS listener on session switch            | `0ee076a` | Client |
| Mark pool entry running on new session (iOS reattach)    | `506bbe3` | Client |
| Don't reassign handler clientId on subscribe-to-reattach | `0f10c47` | Server |
| Promote subscribe to reattach when driver is detached    | `c56d87f` | Server |
| Replay missed events on subscribe-to-reattach            | `6564784` | Server |
| Stop double-counting cumulative session tokens           | `1b59611` | Server |
| Accurate context window and session totals               | `adebabc` | Server |

But fixing these one by one is whack-a-mole. The root cause is architectural: the client manages per-session WebSocket connections, and every lifecycle transition (switch, resume, iOS backgrounding, reattach, subscribe-to-reattach promotion) is a chance for state to leak. The server already has the right abstractions — SessionTransport, SessionRegistry, event store with seq-based replay. The client should stop duplicating session routing logic.

## 2. Proposal: Single WebSocket, Server-Side Session Routing

### 2.1 Core Idea

One WebSocket per browser tab. The server owns all session routing. The client sends messages tagged with a `sessionId`; the server delivers responses tagged with the same `sessionId`. Session switching becomes a message, not a connection lifecycle event.

### 2.2 What This Eliminates

| Current problem                             | Why it exists                                                 | Why single-WS fixes it                                                   |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Listener leaks on session switch            | Client subscribes per pool entry, must manually unsub         | No pool entries. One listener, server tags every message.                |
| `wasRunning` / `prevClientId` state machine | Client decides reattach vs subscribe on reconnect             | Server knows session state. Client just reconnects.                      |
| Pool key aliasing (`new:ts` → `session:id`) | Client creates WS before session ID is known                  | Server assigns session ID and routes by it. Client doesn't care.         |
| iOS Safari reattach bugs                    | Pool entry reconnect logic must reconstruct session state     | One WS reconnects. Server replays all active sessions' missed events.    |
| Task board broadcasting to all clients      | Server iterates `wss.clients` — all same                      | Server tags task events with `sessionId`. Client filters.                |
| `onSessionAssigned` missing unsub           | Pool key changes but old listener stays                       | No pool keys. No listeners to leak.                                      |
| Token zero-flash on resume                  | `switchSession()` resets state before async hydration         | Server sends session metadata on `switch_session` response. Synchronous. |
| Dual WS pool implementations                | Legacy `frontend/src/lib/ws-pool.ts` + `@mitzo/client` WsPool | One connection class. No pool.                                           |

### 2.3 What This Doesn't Fix (Addressed Separately)

- TaskOrchestrator singleton (§5.1)
- Permission responses not session-scoped (§5.2)
- Global caches (§5.3)

These are server-side state issues unrelated to connection topology.

## 3. Architecture

### 3.1 Connection Model

```
┌─────────────────────────────────────────────────┐
│                   Browser Tab                    │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Session A │  │ Session B │  │ Task Board│      │
│  │   (chat)  │  │  (chat)  │  │ (global)  │      │
│  └────┬──┬──┘  └────┬──┬──┘  └────┬──┬──┘      │
│       │  ▲          │  ▲          │  ▲           │
│       │  │ filter    │  │ filter   │  │ filter    │
│       │  │ by sid    │  │ by sid   │  │ no sid    │
│       ▼  │          ▼  │          ▼  │           │
│  ┌──────────────────────────────────────────┐    │
│  │           Connection (single WS)         │    │
│  │  • multiplexes by sessionId              │    │
│  │  • one reconnect loop                    │    │
│  │  • one lastSeq per session               │    │
│  └─────────────────┬────────────────────────┘    │
└────────────────────┼─────────────────────────────┘
                     │ wss://
                     ▼
┌────────────────────────────────────────────────────┐
│                    Server                           │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │            Connection Handler                 │  │
│  │  • one connectionId per WS                    │  │
│  │  • routes by sessionId in message             │  │
│  │  • tracks which sessions this connection owns │  │
│  └────────┬──────────┬──────────┬───────────────┘  │
│           │          │          │                    │
│           ▼          ▼          ▼                    │
│    ┌──────────┐ ┌──────────┐ ┌─────────────┐      │
│    │ Session A │ │ Session B │ │ Global Bus  │      │
│    │ (query   │ │ (query   │ │ (task board, │      │
│    │  loop)   │ │  loop)   │ │  inbox, etc) │      │
│    └──────────┘ └──────────┘ └─────────────┘      │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │              Session Registry                 │  │
│  │  • sessions keyed by sessionId (not clientId) │  │
│  │  • each session tracks its driver connection  │  │
│  │  • each session tracks its observer set       │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### 3.2 Protocol Changes

#### Client → Server

**Current messages that change:**

```typescript
// BEFORE: 'send' with implicit session binding via WS connection
{ type: 'send', prompt, clientMsgId, resume?, ... }

// AFTER: every message carries sessionId explicitly
{ type: 'send', sessionId: string | null, prompt, clientMsgId, ... }
//                ↑ null = start new session
//                ↑ string = send to existing session

// BEFORE: 'reattach' with clientId (client remembers server's ID)
{ type: 'reattach', clientId, lastSeq? }

// AFTER: 'reconnect' with per-session seq tracking
{ type: 'reconnect', sessions: Array<{ sessionId: string; lastSeq: number }> }
//                    ↑ client tells server which sessions it was watching
//                      and the last seq received for each

// BEFORE: 'subscribe' with sessionId (open separate observer WS)
{ type: 'subscribe', sessionId, lastSeq? }

// AFTER: 'watch' / 'unwatch' (add/remove session from this connection's feed)
{ type: 'watch', sessionId }
{ type: 'unwatch', sessionId }

// BEFORE: 'permission_response' with permId only
{ type: 'permission_response', permId, decision }

// AFTER: same, but server validates against session's connection
{ type: 'permission_response', sessionId, permId, decision }

// These stay the same but gain sessionId:
{ type: 'interrupt', sessionId, prompt, clientMsgId }
{ type: 'stop', sessionId }
{ type: 'set_mode', sessionId, mode }
```

**New messages:**

```typescript
// Switch active session (server sends back metadata synchronously)
{
  type: ('switch_session', sessionId);
}
```

#### Server → Client

**Every session-scoped message gains a `sessionId` field:**

```typescript
// BEFORE:
{ v: 2, type: 'block_delta', messageId, blockId, delta }

// AFTER:
{ v: 2, type: 'block_delta', sessionId, messageId, blockId, delta }
```

**Global messages stay unchanged (no sessionId):**

```typescript
{
  type: 'update_available';
}
{
  type: 'inbox_updated';
}
```

**New messages:**

```typescript
// Response to 'switch_session' — delivers metadata synchronously
{ type: 'session_switched', sessionId, tokens: { ... }, mode, cwd, branch, ... }

// Response to 'reconnect' — per-session replay status
{ type: 'reconnected', sessions: Array<{ sessionId, replayed: number, running: boolean }> }

// Session created (replaces current 'session_id' message)
{ type: 'session_created', sessionId, cwd, branch, wtId? }
```

### 3.3 Server-Side Connection Registry

New concept: **ConnectionRegistry** — tracks which WebSocket connections exist and which sessions each is watching.

```typescript
interface Connection {
  id: string; // stable for WS lifetime
  transport: SessionTransport; // WsTransport wrapper
  watchedSessions: Set<string>; // sessionIds this connection receives
  activeSession: string | null; // the session this connection is "driving"
}

class ConnectionRegistry {
  private connections = new Map<string, Connection>();

  register(id: string, transport: SessionTransport): void;
  remove(id: string): void;
  getBySessionId(sessionId: string): Connection[]; // all connections watching this session
  setActive(connectionId: string, sessionId: string): void;
  watch(connectionId: string, sessionId: string): void;
  unwatch(connectionId: string, sessionId: string): void;
}
```

The existing **SessionRegistry** stays but becomes simpler:

- Sessions keyed by `sessionId` (not `clientId`)
- No more `attached` / `detached` state per session — connections come and go independently
- No more detach timers per session — a session is alive as long as its query loop is running or it has unsaved state
- Transport field removed — sessions don't own transports; connections do

### 3.4 Message Routing

**Inbound (client → server):**

```
WS message received
  → parse JSON, extract sessionId
  → if sessionId is null: create new session, return sessionId
  → if sessionId exists: look up session in SessionRegistry
    → validate connection is watching this session
    → route to session's query loop / input queue
```

**Outbound (session → client):**

```
Query loop emits event for sessionId
  → persist to event store (get seq)
  → tag with sessionId
  → ConnectionRegistry.getBySessionId(sessionId)
    → for each connection watching this session: send
```

**Global events:**

```
Task board / inbox / update events
  → ConnectionRegistry.all()
    → for each connection: send (no sessionId tag)
```

### 3.5 Client-Side Demultiplexing

The client replaces `WsPool` with a `Connection` class:

```typescript
class MitzoConnection {
  private ws: WebSocket;
  private listeners = new Map<string | null, Set<MsgListener>>();
  //                       ↑ sessionId, null = global
  private seqs = new Map<string, number>(); // per-session lastSeq

  subscribe(sessionId: string | null, listener: MsgListener): () => void;
  send(msg: Record<string, unknown>): void;

  // Internal: route incoming messages to correct listeners
  private onMessage(raw: string): void {
    const msg = JSON.parse(raw);
    const sid = msg.sessionId ?? null;

    // Update seq tracking
    if (sid && msg.seq != null) {
      this.seqs.set(sid, msg.seq);
    }

    // Deliver to matching listeners
    const listeners = this.listeners.get(sid);
    if (listeners) {
      for (const fn of listeners) fn(msg);
    }
  }

  // On reconnect: send reconnect message with all tracked seqs
  private onReconnect(): void {
    this.send({
      type: 'reconnect',
      sessions: [...this.seqs].map(([sessionId, lastSeq]) => ({ sessionId, lastSeq })),
    });
  }
}
```

**Store integration:**

```typescript
// switchSession becomes trivial:
switchSession(sessionId: string) {
  // Unsubscribe old
  activeUnsub?.();

  // Subscribe new — just a listener filter, no WS work
  activeUnsub = connection.subscribe(sessionId, sessionListener);

  // Tell server to send metadata
  connection.send({ type: 'switch_session', sessionId });
  // Server responds with session_switched (tokens, mode, etc.)
  // Protocol parser handles it synchronously — no zero-flash
}

// newSession:
newSession() {
  activeUnsub?.();
  // Send with null sessionId — server creates and returns sessionId
  connection.send({ type: 'send', sessionId: null, prompt, ... });
  // Server responds with session_created → sessionListener picks it up
}
```

### 3.6 Reconnection

**Current model:** Each pool entry independently reconnects, decides reattach vs subscribe, tracks its own `wasRunning` and `prevClientId`. Six state transitions, multiple edge cases.

**New model:** One WebSocket reconnects. On open, client sends `reconnect` with all tracked session seqs. Server replays missed events for each. Done.

```
WS drops (iOS Safari, network, etc.)
  → client auto-reconnects (single connection, single retry loop)
  → on open: send { type: 'reconnect', sessions: [{sessionId, lastSeq}, ...] }
  → server replays missed events per session (tagged with sessionId)
  → client demuxes to correct listeners
  → UI resumes seamlessly
```

No `wasRunning`. No `prevClientId`. No subscribe-to-reattach promotion. No pool key aliasing. The server knows which sessions exist and what state they're in.

### 3.7 Session Lifecycle Changes

**Detach/reattach disappears** as a concept for the connection layer. Sessions don't "detach" when a WS drops — they keep running. The query loop's `AbortController` and the session's TTL determine lifetime, not connection state.

**What replaces detach timers:** A session with no watching connections starts a TTL timer. If a connection watches it again (via `reconnect` or `watch`), timer clears. Same behavior, but decoupled from transport.

**Observer model simplifies:** A connection can `watch` multiple sessions. The server delivers events for all watched sessions on the single WS. No separate observer transports.

## 4. Worktree Implications

Worktrees are per-session, not per-connection. This doesn't change:

- Session start creates worktrees (server-side, `createSessionWorktrees`)
- Session cleanup removes worktree directories (branches persist)
- `wtId` is session state, lives in SessionRegistry

What changes: the `worktree_opened` event gets a `sessionId` field so the client knows which session it belongs to. Currently it's sent on the session's dedicated WS — with single-WS it needs the tag.

## 5. Remaining Server-Side Fixes

These are orthogonal to the connection topology change but should ship alongside or shortly after.

### 5.1 TaskOrchestrator Scoping

The TaskOrchestrator singleton must become per-session. Its broadcast helpers currently iterate `wss.clients` — with single-WS this would still hit all connections. Fix: broadcast through `ConnectionRegistry.getBySessionId()` instead.

Per-session orchestrator instances stored on the session in SessionRegistry. `clearTaskContext()` scoped to owning session only.

### 5.2 Permission Scoping

Extend `PendingEntry` with `sessionId`. Validate on `resolvePending()` that the responding connection is watching the session that owns the permission request.

### 5.3 Global Caches

No changes needed. Repo config (5s TTL), skill registry, MCP servers, and hidden sessions are server-side concerns unaffected by connection topology. Hidden sessions should move to per-connection state (stored on `Connection` in the ConnectionRegistry).

## 6. Migration Strategy

### Phase 0: Protocol Versioning

Add protocol version negotiation. Client sends `{ type: 'hello', protocolVersion: 2 }` on connect. Server responds with version confirmation. This allows running both models during transition.

Old clients (protocol v1): routed through existing per-WS handler.
New clients (protocol v2): routed through new connection handler.

### Phase 1: Server-Side Routing (backend only)

| Task                                             | File                                             | Complexity |
| ------------------------------------------------ | ------------------------------------------------ | ---------- |
| Add `ConnectionRegistry`                         | `packages/harness/src/connection-registry.ts`    | Medium     |
| Add `sessionId` to all outbound session events   | `server/query-loop.ts`                           | Small      |
| New message handler for v2 protocol              | `server/index.ts`                                | Large      |
| `switch_session` handler with sync metadata      | `server/chat.ts`                                 | Medium     |
| `reconnect` handler with multi-session replay    | `server/index.ts`                                | Medium     |
| `watch` / `unwatch` handlers                     | `server/index.ts`                                | Small      |
| Scope task broadcasts through ConnectionRegistry | `server/index.ts`                                | Medium     |
| Per-session orchestrator                         | `server/task-orchestrator.ts`, `server/index.ts` | Medium     |
| Permission scoping                               | `packages/harness/src/permissions.ts`            | Small      |

### Phase 2: Client-Side Migration

| Task                                                | File                                      | Complexity |
| --------------------------------------------------- | ----------------------------------------- | ---------- |
| Replace `WsPool` with `MitzoConnection`             | `packages/client/src/connection.ts` (new) | Large      |
| Update store to use `MitzoConnection`               | `packages/client/src/store.ts`            | Large      |
| Update protocol parser for sessionId demux          | `packages/client/src/protocol-parser.ts`  | Medium     |
| Remove legacy `ws-pool.ts`                          | `frontend/src/lib/ws-pool.ts`             | Delete     |
| Update `useTaskBoard` — subscribe to global channel | `frontend/src/hooks/useTaskBoard.ts`      | Small      |
| Update `InboxView` — subscribe to global channel    | `frontend/src/pages/InboxView.tsx`        | Small      |
| Token hydration via `session_switched` response     | `packages/client/src/slices/tokens.ts`    | Small      |
| Update store tests                                  | `packages/client/__tests__/store.test.ts` | Large      |

### Phase 3: Cleanup

| Task                                                | File                                   | Complexity |
| --------------------------------------------------- | -------------------------------------- | ---------- |
| Remove v1 protocol handler                          | `server/index.ts`                      | Medium     |
| Remove `WsPool` class                               | `packages/client/src/ws-connection.ts` | Delete     |
| Remove `wasRunning`, `prevClientId`, pool key logic | Various                                | Delete     |
| Remove `reattach` / `subscribe` message schemas     | `packages/protocol/src/ws-schemas.ts`  | Small      |
| Update `ws-schemas.ts` with v2 schemas              | `packages/protocol/src/ws-schemas.ts`  | Medium     |

## 7. Testing Strategy

### Key Scenarios

| Test                                                             | What it validates    |
| ---------------------------------------------------------------- | -------------------- |
| Two sessions on one WS, messages routed correctly                | Core multiplexing    |
| Session switch delivers metadata synchronously (no zero-flash)   | Token hydration      |
| WS reconnect replays missed events for all watched sessions      | Multi-session replay |
| Task board events only reach sessions that own the task          | Orchestrator scoping |
| Permission response rejected if connection doesn't watch session | Permission scoping   |
| iOS Safari background/foreground — no data loss                  | Mobile reconnect     |
| New session created while old session is streaming               | Concurrent sessions  |
| Observer watches session via `watch`, receives events            | Multi-client         |
| `unwatch` stops event delivery immediately                       | Cleanup              |
| v1 client still works during migration (Phase 0)                 | Backwards compat     |

### Existing Tests to Update

- `server/__tests__/session-registry.test.ts` — adapt for sessionId-keyed registry
- `server/__tests__/multi-client-sessions.test.ts` — rewrite for connection model
- `server/__tests__/reattach-isolation.test.ts` — rewrite as reconnect tests
- `packages/client/__tests__/store.test.ts` — rewrite for MitzoConnection

## 8. Decisions

1. **Single WS per tab, not per app.** Multiple browser tabs each get their own WS and their own set of watched sessions. Tabs are independent — we don't try to coordinate across them. This matches how the app works today (each tab is a separate "client").

2. **Server-side session routing, not client-side multiplexing.** The server tags every outbound message with `sessionId`. The client demultiplexes on receive. This is simpler and more reliable than having the client track which WS corresponds to which session.

3. **Protocol versioning for migration.** v1 (current) and v2 (new) coexist during transition. The server detects protocol version from the `hello` handshake. This avoids a big-bang cutover and lets us test incrementally.

4. **`reconnect` replaces `reattach` + `subscribe`.** One message type, sent once on reconnect, covers all active sessions. The server replays per-session. This eliminates the reattach-vs-subscribe decision tree entirely.

5. **Sessions keyed by `sessionId`, not `clientId`.** The current `clientId` (ephemeral, generated per WS connection) conflates connection identity with session identity. The new model separates them: connections have `connectionId`, sessions have `sessionId`. A connection can drive or watch multiple sessions.

6. **Synchronous metadata on session switch.** `switch_session` → `session_switched` delivers tokens, mode, CWD, branch in the response. No async `fetchSessionMeta()`. No zero-flash. The event store read is local SQLite — sub-millisecond.

7. **Keep TaskOrchestrator scoping as a separate concern.** The single-WS change fixes message routing. The orchestrator singleton is a separate state-management problem. Both ship together but are designed independently.
