# Proactive Session Suspend — Design Doc

**Status:** Draft
**Date:** 2026-04-24
**Author:** Claude Opus 4.6 + Dimitri
**Prior art:** `docs/design/session-isolation-overhaul.md` (Phase 1 shipped PR #278), `session-isolation-phase2-handoff.md`, PR #239 (mobile WS reconnect fix)

---

## Motivation

On 2026-04-23 at ~23:28 UTC, a PR triage session (id `07ff2e20`) was lost. The user was mid-conversation (3rd turn in-flight) when:

1. A `switch_session` fired to a different session (`32d6c549`)
2. The WebSocket disconnected 10 seconds later (code 1001, client close)
3. The client reconnected as a **new session** instead of resuming
4. The 3rd turn result arrived 5 seconds after disconnect — nobody listening

The session data is intact in the database. The worktree is intact on disk. But from the user's perspective, the session vanished.

This is the **fourth documented instance** of iOS-related session loss. Prior fixes (PR #239, Phase 1 overhaul) addressed the return-from-background path. None address the **departure path** — the moment when iOS decides to kill things.

---

## Problem Statement

Every fix we've built is **reactive**: detect WS death after the fact, then try to recover. The recovery path has gotten good — `defuseOldWs()`, `fetchAndRestoreMessages()`, Capacitor `appStateChange`, `sendBeacon` for REST fallback. But we keep losing sessions because:

1. **No departure signal.** iOS kills the WS silently. By the time we detect it, the client has already lost context on which session was active.

2. **Server can't distinguish "temporarily gone" from "actually dead".** A WS close could mean: iOS backgrounded the app (back in 5 seconds), the user switched apps (back in 30 seconds), the user closed the app (maybe never coming back), or a network glitch (reconnecting now). The server treats all of these identically — detach after TTL.

3. **In-flight responses are lost.** If the Claude agent is mid-response when the WS dies, the response completes on the server but has nowhere to go. On reconnect, the client re-fetches messages from REST, but the REST endpoint may not have the response yet (race window), or the client started a new session instead of resuming.

4. **Reconnect creates new session.** When the client reconnects after a cold start (iOS page eviction), it has no in-memory state about which session was active. It starts a fresh session instead of resuming.

---

## Design: Stop Fighting iOS

### Core Insight

Instead of trying to recover after iOS kills the WebSocket, **signal the server before iOS gets the chance.** Use every available lifecycle hook to say "I'm going away" while the connection is still alive. The server can then transition the session to a known state (SUSPENDED) and buffer responses for instant replay on return.

### Principle: Belt and Suspenders

iOS has at least three ways to kill a session, and no single event fires reliably across all of them. The strategy is to fire **multiple redundant signals** through **multiple transports**:

| iOS scenario | `visibilitychange:hidden` | Capacitor `appStateChange:false` | `pagehide` | `freeze` | WS still alive? |
|---|---|---|---|---|---|
| App switch (multitasking) | Yes | Yes | No | No | Briefly (~5s) |
| Home button | Yes | Yes | Yes | Maybe | Briefly |
| Screen lock | Yes | Yes | No | No | ~30s |
| Page eviction (memory pressure) | No | No | No | Maybe | No |
| Swipe kill | No | Maybe | Maybe | No | No |

The first three scenarios cover ~95% of cases. Page eviction and swipe kill are the hard ones — but for those, the existing reactive recovery (Phase 1) is the fallback.

---

## Architecture

### New Message Type: `session_suspend`

Client → Server. Sent proactively when the app is about to lose focus.

```typescript
// Client sends:
{
  type: 'session_suspend',
  sessions: [
    { sessionId: 'abc-123', lastSeq: 42 },
    { sessionId: 'def-456', lastSeq: 18 }
  ]
}
```

Includes ALL tracked sessions with their last-seen sequence numbers. This tells the server: "I'm going away. Buffer everything after these sequence numbers. I'll be back."

### New Session State: SUSPENDED

```
           session_suspend           grace expires
ACTIVE ──────────────────► SUSPENDED ─────────────► DETACHED ──► EXPIRED
  ▲                            │                        │
  │   reconnect (resume)       │    reconnect           │
  └────────────────────────────┘    (passive reattach)  │
  ▲                                                     │
  └─────────────── send/interrupt (takeover) ───────────┘
```

**ACTIVE:** WS open, events flowing, user engaged.
**SUSPENDED:** User left voluntarily (we *know* they left — they told us). Events buffered. Grace timer running.
**DETACHED:** WS gone, no suspend signal received (unexpected death). Existing behavior.
**EXPIRED:** TTL elapsed, cleanup pending.

The critical distinction: SUSPENDED means "I'll be right back." The server keeps the Claude process alive and buffers responses. DETACHED means "I might be dead" — existing wind-down behavior applies.

### Event Buffer

When a session transitions to SUSPENDED, the server buffers all outgoing events for that session:

```typescript
// session-registry.ts
interface SuspendedState {
  suspendedAt: number;
  lastClientSeq: number;           // from the suspend message
  bufferedEvents: BufferedEvent[];  // events since suspend
  graceTimer: ReturnType<typeof setTimeout>;
}

interface BufferedEvent {
  event: Record<string, unknown>;
  seq: number;
  timestamp: number;
}
```

Buffer is bounded: max 1000 events or 5MB (whichever comes first). If exceeded, the session transitions to DETACHED and the client will need REST fallback on reconnect. In practice, even a long agent response is well under these limits.

### Grace Period

Configurable, default 120 seconds. Covers the common iOS lifecycle:

- App switch and back: 2-10 seconds
- Quick phone call: 30-60 seconds
- Screen lock and unlock: 5-30 seconds
- Long interruption: 60-120 seconds

After grace expires, SUSPENDED → DETACHED. The buffer is discarded and the session follows existing detach/TTL behavior.

---

## Implementation

### Layer 1: Client-Side Departure Signals

**File:** `packages/client/src/connection.ts`

Add a `sendSuspend()` method and wire it to lifecycle events:

```typescript
// ─── Proactive suspend (departure path) ────────────────────────────────
// iOS kills WebSocket connections unpredictably. Instead of trying to
// recover after the fact, we signal the server BEFORE iOS gets the chance.
// Multiple signals through multiple transports — belt and suspenders.

private sendSuspend(): void {
  const sessions = Array.from(this.seqBySession.entries()).map(
    ([sessionId, lastSeq]) => ({ sessionId, lastSeq })
  );
  if (sessions.length === 0) return;

  const payload = { type: 'session_suspend', sessions };

  // 1. Try WS — still OPEN at this point in most iOS scenarios
  if (this.ws?.readyState === WS_READY_STATE.OPEN) {
    this.ws.send(JSON.stringify(payload));
  }

  // 2. ALSO fire sendBeacon — survives page unload even if WS dies mid-send
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(
      this.config.suspendUrl ?? '/api/sessions/suspend',
      JSON.stringify({
        connectionId: this._connectionId,
        ...payload,
      })
    );
  }
}
```

Wire to browser lifecycle:

```typescript
private addBrowserListeners(): void {
  if (typeof globalThis.document === 'undefined') return;

  // EXISTING: visible → reconnect + foreground recovery
  this.boundOnVisibility = () => {
    if (document.visibilityState === 'visible') {
      this.checkAndReconnect();
      this.listener?.({ type: '_foreground' });
    } else if (document.visibilityState === 'hidden') {
      // NEW: going away → signal server before iOS kills WS
      this.sendSuspend();
    }
  };

  // NEW: pagehide — backup signal for hard navigation / tab close
  this.boundOnPageHide = () => {
    this.sendSuspend();
  };

  // EXISTING: pageshow with persisted → reconnect on bfcache restore
  this.boundOnPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) this.checkAndReconnect();
  };

  document.addEventListener('visibilitychange', this.boundOnVisibility);
  globalThis.addEventListener('pagehide', this.boundOnPageHide);
  globalThis.addEventListener('pageshow', this.boundOnPageShow);
}
```

**File:** `packages/client/src/connection.ts` — config extension:

```typescript
export interface MitzoConnectionConfig {
  buildUrl(): string;
  createWebSocket(url: string): WebSocketLike;
  reconnectDelayMs?: number;
  suspendUrl?: string;  // NEW: REST endpoint for sendBeacon fallback
}
```

**File:** `frontend/src/lib/capacitor.ts` — add pause handler:

```typescript
export function registerCapacitorLifecycle(
  onResume: () => void,
  onPause: () => void,  // NEW
): void {
  if (!isCapacitor()) return;

  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) onResume();
    else onPause();  // NEW: signal suspend before iOS kills WS
  });
}
```

**File:** `frontend/src/client-store.ts` — wire pause:

```typescript
registerCapacitorLifecycle(
  () => clientStore.getState().forceReconnect(),   // resume (existing)
  () => clientStore.getState().sendSuspend(),       // pause (NEW)
);
```

### Layer 2: Store-Level Suspend on Session Switch

**File:** `packages/client/src/store.ts`

When the user explicitly navigates away from a session (home button, tap another session), send a suspend signal for the departing session. This covers the "user is still in the app but leaving a running session" case.

```typescript
async switchSession(id: string) {
  const oldId = parserState.currentSessionId;
  if (oldId) {
    connection.clearSession(oldId);
    // NEW: tell server the old session is suspended, not abandoned.
    // If its agent finishes while we're looking at another session,
    // buffer the response for when we come back.
    connection.send({
      type: 'session_suspend',
      sessions: [{ sessionId: oldId, lastSeq: connection.getLastSeq(oldId) }],
    });
  }
  parserState.currentSessionId = id;
  // ... rest unchanged
}
```

New store action:

```typescript
sendSuspend() {
  connection.sendSuspend();
}
```

### Layer 3: Server-Side Suspend Handler

**File:** `server/ws-handler-v2.ts` — new handler:

```typescript
export async function handleSessionSuspend(
  connectionId: string,
  msg: SessionSuspendMsg,
  ctx: V2HandlerContext,
): Promise<void> {
  const span = tracer.startSpan('ws.session_suspend');
  span.setAttribute('ws.connectionId', connectionId);
  span.setAttribute('ws.sessionCount', msg.sessions.length);

  try {
    for (const { sessionId, lastSeq } of msg.sessions) {
      const found = ctx.sessionRegistry.getBySessionId(sessionId);
      if (!found) continue;

      // Only suspend if this connection owns the session
      const ownerConnection = getOwnerConnection(found.clientId);
      if (ownerConnection !== connectionId) continue;

      ctx.sessionRegistry.suspend(found.clientId, lastSeq);
      log.info('session suspended', { connectionId, sessionId, lastSeq });
      span.addEvent('session_suspended', { 'session.id': sessionId });
    }

    span.setStatus({ code: SpanStatusCode.OK });
  } finally {
    span.end();
  }
}
```

**File:** `server/ws-handler-v2.ts` — dispatch routing:

```typescript
// In dispatchV2Message():
case 'session_suspend':
  return handleSessionSuspend(connectionId, msg as SessionSuspendMsg, ctx);
```

### Layer 4: REST Endpoint for `sendBeacon`

**File:** `server/index.ts` — new route:

```typescript
app.post('/api/sessions/suspend', express.json(), (req, res) => {
  const { connectionId, sessions } = req.body;
  if (!connectionId || !Array.isArray(sessions)) {
    return res.status(400).end();
  }

  // Dispatch to the same handler — unified code path
  handleSessionSuspend(connectionId, { type: 'session_suspend', sessions }, v2Context)
    .then(() => res.status(204).end())
    .catch(() => res.status(500).end());
});
```

This is the `sendBeacon` target. Fire-and-forget from the client, but the server processes it identically to the WS message.

### Layer 5: Session Registry — Suspend State Machine

**File:** `server/session-registry.ts` (or `packages/harness/src/session-registry.ts` if it's been extracted)

Add SUSPENDED state and event buffer:

```typescript
interface SessionEntry {
  // ... existing fields
  state: 'active' | 'suspended' | 'detached';
  suspendedState?: {
    suspendedAt: number;
    lastClientSeq: number;
    buffer: Array<{ event: Record<string, unknown>; seq: number }>;
    graceTimer: ReturnType<typeof setTimeout>;
  };
}

const SUSPEND_GRACE_MS = 120_000;  // 2 minutes
const SUSPEND_BUFFER_MAX = 1000;

suspend(clientId: string, lastClientSeq: number): void {
  const entry = this.sessions.get(clientId);
  if (!entry) return;

  entry.state = 'suspended';
  entry.suspendedState = {
    suspendedAt: Date.now(),
    lastClientSeq,
    buffer: [],
    graceTimer: setTimeout(() => {
      // Grace expired — transition to detached
      entry.state = 'detached';
      entry.suspendedState = undefined;
      log.info('suspend grace expired, transitioning to detached', { clientId });
    }, SUSPEND_GRACE_MS),
  };
}

bufferEvent(clientId: string, event: Record<string, unknown>, seq: number): boolean {
  const entry = this.sessions.get(clientId);
  if (!entry?.suspendedState) return false;
  if (entry.suspendedState.buffer.length >= SUSPEND_BUFFER_MAX) return false;

  entry.suspendedState.buffer.push({ event, seq });
  return true;
}

resume(clientId: string): Array<{ event: Record<string, unknown>; seq: number }> {
  const entry = this.sessions.get(clientId);
  if (!entry?.suspendedState) return [];

  clearTimeout(entry.suspendedState.graceTimer);
  const buffer = entry.suspendedState.buffer;
  entry.state = 'active';
  entry.suspendedState = undefined;
  return buffer;
}
```

### Layer 6: Event Buffering in Query Loop

**File:** `server/query-loop.ts`

When `sendOrBuffer()` tries to send an event for a SUSPENDED session, buffer it instead of dropping it:

```typescript
function sendOrBuffer(event: Record<string, unknown>, sessionId: string): void {
  // Check if session is suspended — buffer instead of sending
  const entry = sessionRegistry.getBySessionId(sessionId);
  if (entry && entry.state === 'suspended') {
    const seq = nextSeq();
    sessionRegistry.bufferEvent(entry.clientId, { ...event, seq, sessionId }, seq);
    return;
  }

  // ... existing send logic (hasOpenWatchers, broadcast, etc.)
}
```

### Layer 7: Reconnect — Replay Suspended Buffer

**File:** `server/ws-handler-v2.ts` — modify `handleReconnect`:

```typescript
// In handleReconnect(), for each session in the reconnect message:
for (const { sessionId, lastSeq } of msg.sessions) {
  const found = sessionRegistry.getBySessionId(sessionId);
  if (!found) continue;

  if (found.state === 'suspended') {
    // Instant resume — replay buffered events
    const buffer = sessionRegistry.resume(found.clientId);
    for (const { event } of buffer) {
      transport.send(event);
    }
    // Reattach transport
    reattachChat(found.clientId, transport);
    log.info('resumed suspended session', {
      connectionId, sessionId, bufferedEvents: buffer.length,
    });
    transport.send({ type: 'session_resumed', sessionId, replayed: buffer.length });
    continue;
  }

  // ... existing DETACHED handling (passive reattach)
}
```

### Layer 8: WS Close — Respect Suspend State

**File:** `server/index.ts` — WS close handler:

Currently on WS close, sessions are detached. With suspend state, a recently-suspended session should stay SUSPENDED (the WS close is expected):

```typescript
// In the v2 WS close handler:
for (const { sessionId } of watchedSessions) {
  const entry = sessionRegistry.getBySessionId(sessionId);
  if (entry?.state === 'suspended') {
    // Expected — the suspend signal came before the WS died.
    // Session stays SUSPENDED with its buffer. Grace timer is running.
    log.info('WS closed for suspended session (expected)', { connectionId, sessionId });
    continue;
  }
  // Unexpected close — transition to DETACHED (existing behavior)
  detachSession(entry);
}
```

---

## Protocol Changes

**File:** `packages/protocol/src/messages.ts`

```typescript
// Client → Server
export const SessionSuspendMessage = z.object({
  type: z.literal('session_suspend'),
  sessions: z.array(z.object({
    sessionId: z.string(),
    lastSeq: z.number(),
  })),
});

// Server → Client
export const SessionResumedMessage = z.object({
  type: z.session_resumed',
  sessionId: z.string(),
  replayed: z.number(),  // number of buffered events replayed
});
```

Add both to the respective union types (`IncomingWsMessageV2`, `OutgoingWsMessageV2`).

---

## What This Fixes

### Tonight's scenario (PR triage session loss)

**Before:**
1. Session running, 3rd turn in-flight
2. iOS kills WS → server detects close → detaches session
3. 3rd turn finishes → nowhere to send → lost
4. Client reconnects → no memory of old session → new session

**After:**
1. Session running, 3rd turn in-flight
2. `visibilitychange:hidden` fires → `sendSuspend()` → server marks SUSPENDED
3. iOS kills WS → server sees close for SUSPENDED session → expected, keeps buffer
4. 3rd turn finishes → server buffers the response events
5. Client reconnects → `handleReconnect` finds SUSPENDED session → instant resume
6. Buffered events replayed → user sees the 3rd turn response

### In-app session switching

**Before:**
1. User in session A, switches to session B
2. Session A's agent finishes → response sent to WS
3. Client drops it (session filter: `eventSessionId !== currentSessionId`)

**After:**
1. User in session A, switches to session B
2. `switchSession()` sends `session_suspend` for session A
3. Session A's agent finishes → server buffers response
4. User switches back to session A → reconnect replays buffer → sees response

### iOS backgrounding during active session

**Before:**
1. Agent is mid-response
2. iOS backgrounds app → WS dies → response lost in transit
3. User returns → `_foreground` recovery fetches messages from REST
4. Race: REST API may not have the response yet (write lag)

**After:**
1. Agent is mid-response
2. `visibilitychange:hidden` fires → suspend signal sent while WS still alive
3. iOS backgrounds app → WS dies → server expected it (SUSPENDED)
4. Agent finishes → response buffered
5. User returns → reconnect → buffer replayed instantly (no REST race)

---

## Interaction with Existing Systems

### Phase 1 fixes (all preserved)

| Fix | Interaction with suspend |
|---|---|
| `defuseOldWs()` | Still needed — prevents old WS onclose from trashing new connection |
| `fetchAndRestoreMessages()` | Still needed as fallback — if buffer overflows or grace expires |
| Session bleed fix (unwatch on switch) | Compatible — suspend is per-session, switch unwatches correctly |
| Auto-takeover on send/interrupt | Compatible — takeover to a SUSPENDED session clears the buffer |
| Stale registry cleanup | Compatible — stale check runs after suspend grace expires |
| Resume validation | Compatible — validateResumable runs on reconnect regardless of suspend state |

### Phase 2 (worktree isolation)

No interaction. Suspend is a transport-layer concern; worktrees are a filesystem concern.

### Multi-device

Suspend is per-connection. If device A suspends session X and device B sends to session X, the takeover logic clears device A's suspend state (the buffer is no longer needed — device B has the session now).

---

## Test Plan (TDD)

### Server tests (`server/__tests__/ws-handler-v2.test.ts`)

| Test | Description |
|---|---|
| suspend: marks session SUSPENDED | `handleSessionSuspend` → `registry.get(clientId).state === 'suspended'` |
| suspend: only owner can suspend | Non-owner connectionId → session state unchanged |
| suspend: grace timer transitions to DETACHED | After `SUSPEND_GRACE_MS` → `state === 'detached'` |
| reconnect: replays buffer for SUSPENDED session | Buffer has 3 events → transport receives all 3 + `session_resumed` |
| reconnect: clears suspend state after resume | After resume → `state === 'active'`, `suspendedState === undefined` |
| WS close: respects SUSPENDED state | Close for SUSPENDED session → stays SUSPENDED (not DETACHED) |
| WS close: ACTIVE session still detaches | Close for ACTIVE session → DETACHED (existing behavior preserved) |
| buffer: events buffered during SUSPENDED | `sendOrBuffer` for SUSPENDED session → event in buffer |
| buffer: overflow transitions to DETACHED | Buffer exceeds max → session transitions to DETACHED |
| takeover: clears suspend state | Send from device B to SUSPENDED session → state becomes ACTIVE, buffer cleared |

### Server tests (`server/__tests__/index.test.ts`)

| Test | Description |
|---|---|
| REST suspend endpoint: accepts valid payload | POST `/api/sessions/suspend` with connectionId + sessions → 204 |
| REST suspend endpoint: rejects invalid payload | Missing connectionId → 400 |

### Client tests (`packages/client/src/__tests__/connection.test.ts`)

| Test | Description |
|---|---|
| sendSuspend: sends WS message when connected | WS OPEN → `ws.send` called with `session_suspend` |
| sendSuspend: fires sendBeacon as backup | `navigator.sendBeacon` called with `/api/sessions/suspend` |
| sendSuspend: no-op when no tracked sessions | Empty `seqBySession` → neither WS nor beacon fired |
| visibilitychange hidden: triggers sendSuspend | Dispatch `visibilitychange` with `hidden` → `sendSuspend` called |
| pagehide: triggers sendSuspend | Dispatch `pagehide` → `sendSuspend` called |

### Client tests (`packages/client/src/__tests__/store.test.ts`)

| Test | Description |
|---|---|
| switchSession: sends suspend for old session | Switch from A to B → `session_suspend` sent with session A |
| session_resumed: logged but no store mutation | Server sends `session_resumed` → no error, no state change |

### Capacitor tests (`frontend/src/lib/__tests__/capacitor.test.ts`)

| Test | Description |
|---|---|
| appStateChange false: calls onPause | `isActive: false` → `onPause` callback invoked |
| appStateChange true: calls onResume (existing) | `isActive: true` → `onResume` callback invoked |

---

## Verification Checklist

- [ ] iPhone: background app mid-response → return → see the response (no loss)
- [ ] iPhone: switch to another app for 30s → return → session intact
- [ ] iPhone: lock screen while agent running → unlock → response visible
- [ ] iPhone: switch sessions in-app while agent running → switch back → see response
- [ ] Desktop: close tab with running session → reopen → session resumable
- [ ] Multi-device: phone suspends, laptop sends → laptop takes over cleanly
- [ ] Grace expiry: background app for 3+ minutes → return → falls back to REST recovery (Phase 1 path)
- [ ] Buffer overflow: extreme case (1000+ events) → falls back to DETACHED behavior
- [ ] sendBeacon: disable WS before visibilitychange → beacon still reaches server
- [ ] No regression: existing reconnect, takeover, session bleed tests still pass

---

## Implementation Order

1. **Protocol** — add `session_suspend` and `session_resumed` message types
2. **Session registry** — add SUSPENDED state, buffer, grace timer, `suspend()` / `resume()` / `bufferEvent()`
3. **Server handler** — `handleSessionSuspend()` + dispatch routing
4. **REST endpoint** — `POST /api/sessions/suspend` for sendBeacon
5. **Query loop** — buffer events for SUSPENDED sessions in `sendOrBuffer()`
6. **Reconnect handler** — replay buffer for SUSPENDED sessions
7. **WS close handler** — respect SUSPENDED state
8. **Client connection** — `sendSuspend()`, lifecycle listeners, config
9. **Client store** — suspend on `switchSession()`, `sendSuspend()` action
10. **Capacitor** — add `onPause` callback

---

## Deferred

- **`freeze` event handling** — Safari-specific, fires before page freeze. Low coverage in practice; the `visibilitychange:hidden` + `pagehide` combo catches most cases. Add if testing reveals a gap.
- **Persistent suspend state across server restarts** — currently the buffer lives in memory. If the server restarts during a suspend window, the buffer is lost. Could persist to EventStore, but the 120s grace window makes server restarts during suspend rare. REST fallback covers it.
- **Configurable grace period per session** — long-running agent tasks might want longer grace. Default 120s is sufficient for now.
- **Client-side suspend indicator** — show "Session paused" in the session list for suspended sessions. Nice UX but not blocking.
