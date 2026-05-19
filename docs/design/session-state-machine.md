# Session State Machine

**Status:** Proposed  
**Author:** Claude Sonnet 4.5 + Dimitri Saridakis  
**Created:** 2026-05-18  
**Related PRs:** TBD

## Problem Statement

### Symptom

Users experience hanging sessions on mobile reattach. Pattern:

1. User backgrounds app for >30 minutes
2. Returns, sends message
3. UI shows "thinking..." but no response
4. Repeated messages eventually trigger a response
5. Event log shows `session_end` with 0 tokens before recovery

### Root Cause

**Two sources of truth for session lifecycle with no explicit state machine:**

**SessionRegistry** (in-memory):

- `has(clientId)` → query loop is running
- `!has(clientId)` → no query loop

**EventStore** (SQLite):

- `isActive: true` → query was running last time we checked
- `isActive: false` → query ended last time we checked

These diverge because:

- `isActive` updated only on query **start** (first SDK event) and **end**
- Detach/reattach/suspend only touch SessionRegistry
- Rapid state changes create windows where in-memory and durable state disagree

### The Bug

`ws-handler-v2.ts:388-394`:

```typescript
const storeMeta = ctx.eventStore.getSession(sessionId);
const staleInMemory = storeMeta && !storeMeta.isActive;

if (staleInMemory) {
  log.info('removing stale session from registry (send)');
  ctx.sessionRegistry.remove(found.clientId); // ← kills query loop
}
```

On reattach after long idle:

1. Registry has session (from reconnect or lingering state)
2. EventStore shows `isActive: false` (from previous session end)
3. Code removes session from registry
4. Query loop sees `!currentSession` on next iteration → breaks → emits 0-token `session_end`
5. Fallthrough starts fresh query with `resume: sessionId` → works

This is one symptom. The architectural issue causes:

- Race conditions on rapid reconnect
- Impossible to distinguish legitimate stale vs. just-started vs. detached
- Crash recovery can't determine session state
- No metrics on state transitions or dwell times
- Debugging requires correlating logs across two systems

## Solution: Explicit State Machine

### States

```
CREATED    → session allocated in registry, no SDK call yet
STARTING   → query() called, waiting for first SDK event
ACTIVE     → SDK yielded events, query running, transport attached
DETACHED   → transport disconnected, query still running
SUSPENDED  → iOS backgrounded, buffering events
CLOSING    → closeout phase (10min timer)
ENDED      → query finished, cleaned up
```

### Transitions

```
CREATED → STARTING        startChat() calls query()
STARTING → ACTIVE         first SDK event received
STARTING → ENDED          query fails before first event (timeout/error)

ACTIVE → DETACHED         transport.close() without abort
ACTIVE → SUSPENDED        iOS background + suspend buffer active
ACTIVE → CLOSING          closeout handler fires
ACTIVE → ENDED            query completes normally or interrupt aborts query

DETACHED → ACTIVE         reattach()
DETACHED → SUSPENDED      iOS background while detached
DETACHED → CLOSING        detach TTL expires, closeout fires
DETACHED → ENDED          detach TTL expires without closeout, or query aborts

SUSPENDED → ACTIVE        resume from background, reattach
SUSPENDED → ENDED         suspend timeout expires, query aborts

CLOSING → ENDED           closeout completes or timeout expires

ENDED → STARTING          explicit resume with startChat(resume: sessionId)
```

### Interrupt Behavior

When the user interrupts (taps stop), the SDK query is aborted and the query loop exits.
This is a normal ACTIVE → ENDED transition with `reason: 'interrupt'`. The session can be
resumed via ENDED → STARTING on the next `startChat(resume: sessionId)`.

Interrupt during DETACHED/SUSPENDED: the abort signal fires on the query loop regardless of
transport state. Same transition — the state goes to ENDED via the query loop's `finally` block.

### Invalid Transitions (bugs if observed)

- Any state → CREATED (sessions don't un-create)
- ENDED → any except STARTING (can't revive without explicit resume)
- CLOSING → any except ENDED (closeout is terminal)
- SUSPENDED → DETACHED (if background resumes without transport, go straight to ENDED)
- SUSPENDED → CLOSING (suspend timeout goes to ENDED, not CLOSING)

### Invariants

1. **Registry ⇔ State consistency:**
   - `registry.has(clientId)` iff state ∈ {CREATED, STARTING, ACTIVE, DETACHED, SUSPENDED, CLOSING}
   - `!registry.has(clientId)` iff state = ENDED

2. **Query running:**
   - state ∈ {STARTING, ACTIVE, DETACHED, SUSPENDED, CLOSING} → query loop is running
   - state ∈ {CREATED, ENDED} → no query loop

3. **Transport attached:**
   - state ∈ {ACTIVE, CLOSING} → `registry.isAttached(clientId) === true`
   - state ∈ {DETACHED, SUSPENDED} → `registry.isAttached(clientId) === false`
   - state ∈ {CREATED, STARTING, ENDED} → transport may be attached (STARTING) or not exist (ENDED)

4. **Monotonic timestamp:**
   - `last_state_change` increases on every transition

## Implementation Plan

### Phase 1: Add State Column (No Behavior Change)

**Goal:** Write state everywhere, don't read it yet. Validate transitions in production.

#### Schema Migration

```sql
-- server/migrations/003_session_state.sql
-- `sessions` table already has: session_id, isActive, created_at, updated_at, ...
-- See 001_init.sql for full schema.
ALTER TABLE sessions ADD COLUMN state TEXT DEFAULT 'ENDED';
ALTER TABLE sessions ADD COLUMN last_state_change INTEGER;

CREATE INDEX idx_sessions_state ON sessions(session_id, state);
```

#### EventStore API

```typescript
// server/event-store.ts

export type SessionState =
  | 'CREATED'
  | 'STARTING'
  | 'ACTIVE'
  | 'DETACHED'
  | 'SUSPENDED'
  | 'CLOSING'
  | 'ENDED';

interface SessionStateTransition {
  fromState: SessionState | null;
  toState: SessionState;
  timestamp: number;
  clientId: string;
  reason?: string;
}

class EventStore {
  setState(
    sessionId: string,
    newState: SessionState,
    opts?: { clientId?: string; reason?: string },
  ): void {
    const current = this.getSession(sessionId);
    const fromState = current?.state ?? null;
    const now = Date.now();

    this.db.run(
      `UPDATE sessions 
       SET state = ?, last_state_change = ?
       WHERE session_id = ?`,
      [newState, now, sessionId],
    );

    // Emit state transition for tracing/metrics
    this.appendStateTransition(sessionId, {
      fromState,
      toState: newState,
      timestamp: now,
      clientId: opts?.clientId ?? 'unknown',
      reason: opts?.reason,
    });

    log.info('session state transition', {
      sessionId,
      fromState,
      toState: newState,
      clientId: opts?.clientId,
      reason: opts?.reason,
    });
  }

  getSessionState(sessionId: string): SessionState | null {
    const row = this.db.get('SELECT state FROM sessions WHERE session_id = ?', [sessionId]);
    return row?.state ?? null;
  }
}
```

#### Write State in All Lifecycle Operations

**startChat (chat.ts):**

```typescript
export function startChat(...) {
  registry.register(clientId, { ... });
  if (sessionId) {
    eventStore.setState(sessionId, 'CREATED', { clientId });
  }

  const q = query(...);
  if (sessionId) {
    eventStore.setState(sessionId, 'STARTING', { clientId });
  }

  runQueryLoop(q, clientId, ...);
}
```

**First SDK event (query-loop.ts):**

```typescript
if (!firstEventReceived) {
  firstEventReceived = true;
  if (resolvedSessionId) {
    store?.setState(resolvedSessionId, 'ACTIVE', {
      clientId,
      reason: 'first_sdk_event',
    });
  }
}
```

**detach (session-registry.ts):**

```typescript
detach(clientId: string, store?: EventStore): void {
  const session = this.sessions.get(clientId);
  if (!session) return;

  this.attached.delete(clientId);
  if (session.sessionId && store) {
    store.setState(session.sessionId, 'DETACHED', {
      clientId,
      reason: 'transport_close'
    });
  }
  // ... start TTL timer
}
```

**reattach (session-registry.ts):**

```typescript
reattach(clientId: string, transport: SessionTransport, store?: EventStore): boolean {
  const session = this.sessions.get(clientId);
  if (!session) return false;

  session.transport = transport;
  this.attached.add(clientId);

  if (session.sessionId && store) {
    store.setState(session.sessionId, 'ACTIVE', {
      clientId,
      reason: 'reattach'
    });
  }
  // ... clear timers
  return true;
}
```

**suspend (session-registry.ts):**

```typescript
suspend(clientId: string, store?: EventStore): boolean {
  const session = this.sessions.get(clientId);
  if (!session) return false;

  this.suspended.add(clientId);
  this.attached.delete(clientId);

  if (session.sessionId && store) {
    store.setState(session.sessionId, 'SUSPENDED', {
      clientId,
      reason: 'ios_background'
    });
  }
  // ... start suspend timer
  return true;
}
```

**closeout (chat.ts):**

```typescript
function closeoutSession(clientId: string): void {
  const session = registry.get(clientId);
  if (session?.sessionId) {
    eventStore.setState(session.sessionId, 'CLOSING', {
      clientId,
      reason: 'detach_ttl_closeout',
    });
  }
  // ... inject closeout prompt
}
```

**query end (query-loop.ts finally block):**

```typescript
finally {
  const sid = finalSession.sessionId ?? resolvedSessionId;
  if (store && sid) {
    store.setState(sid, 'ENDED', {
      clientId,
      reason: caughtError ? 'error' : 'completed'
    });
  }
  registry.remove(clientId);
}
```

#### Validation (No Enforcement Yet)

Add telemetry to catch impossible transitions:

```typescript
// event-store.ts
setState(sessionId: string, newState: SessionState, opts?: ...): void {
  const current = this.getSession(sessionId);
  const fromState = current?.state ?? null;

  // Warn on invalid transitions but don't block
  if (fromState && !isValidTransition(fromState, newState)) {
    log.warn('invalid session state transition', {
      sessionId,
      fromState,
      toState: newState,
      clientId: opts?.clientId,
      stack: new Error().stack,
    });
    // Record metric for monitoring
    invalidTransitionCounter.inc({ from: fromState, to: newState });
  }

  // Always proceed with state change in Phase 1
  this.db.run(...);
}
```

#### Acceptance Criteria (Phase 1)

- [ ] All lifecycle operations set state
- [ ] State transitions appear in logs
- [ ] No invalid transitions observed in production for 1 week
- [ ] Existing behavior unchanged (stale checks still run)
- [ ] Tests verify state is written on all paths

### Phase 2: Observability (Read State, Don't Enforce)

**Goal:** Surface state in debugging, detect mismatches, don't change routing logic yet.

#### Add State to All Relevant Logs

```typescript
// ws-handler-v2.ts handleSendV2
const found = ctx.sessionRegistry.findBySessionId(sessionId);
const state = ctx.eventStore.getSessionState(sessionId);

log.info('send routing decision', {
  sessionId,
  registryHas: !!found,
  storeState: state,
  isOwner,
  isDetached,
});
```

#### Detect State Mismatches

```typescript
// Add mismatch detector that runs on every send/interrupt
function detectStateMismatch(
  sessionId: string,
  registry: SessionRegistry,
  store: EventStore,
): { mismatch: boolean; details?: string } {
  const found = registry.findBySessionId(sessionId);
  const state = store.getSessionState(sessionId);

  const registryHas = !!found;
  const shouldHave = state && state !== 'ENDED';

  if (registryHas && !shouldHave) {
    return {
      mismatch: true,
      details: `registry has session but state=${state}`,
    };
  }

  if (!registryHas && shouldHave) {
    return {
      mismatch: true,
      details: `registry missing session but state=${state}`,
    };
  }

  if (found && state) {
    const attached = registry.isAttached(found.clientId);
    const shouldBeAttached = state === 'ACTIVE' || state === 'CLOSING';
    const shouldBeDetached = state === 'DETACHED' || state === 'SUSPENDED';

    if (attached && shouldBeDetached) {
      return {
        mismatch: true,
        details: `attached but state=${state}`,
      };
    }
    if (!attached && shouldBeAttached) {
      return {
        mismatch: true,
        details: `detached but state=${state}`,
      };
    }
  }

  return { mismatch: false };
}

// ws-handler-v2.ts handleSendV2
const mismatch = detectStateMismatch(sessionId, ctx.sessionRegistry, ctx.eventStore);
if (mismatch.mismatch) {
  log.error('session state mismatch detected', {
    sessionId,
    ...mismatch,
  });
  stateMismatchCounter.inc({ type: mismatch.details });
}
```

#### Dashboards and Alerts

- Grafana panel: state distribution (pie chart)
- Grafana panel: state transition rate (time series)
- Grafana panel: state dwell time (histogram)
- Alert: `state_mismatch_total > 0` → page on-call

#### Acceptance Criteria (Phase 2)

- [ ] State appears in all session-related logs
- [ ] Grafana dashboards show state metrics
- [ ] Zero state mismatches observed for 1 week
- [ ] If mismatches occur, root cause identified and fixed
- [ ] Still no behavior change to routing logic

### Phase 3: Replace Stale Checks with State-Based Routing

**Goal:** Use state as source of truth for routing decisions. Remove ad-hoc stale detection.

#### New Routing Logic

**ws-handler-v2.ts handleSendV2:**

```typescript
const sessionId = msg.sessionId;

if (sessionId) {
  const found = ctx.sessionRegistry.findBySessionId(sessionId);
  const state = ctx.eventStore.getSessionState(sessionId);

  // Detect impossible states and fail loudly
  if (found && state === 'ENDED') {
    // Registry has it but store says ended → bug in state management
    log.error('session state invariant violation', {
      sessionId,
      clientId: found.clientId,
      state,
      violation: 'registry_has_ended_session',
    });
    span.recordException(new Error('Registry has ENDED session'));
    transport.send({
      type: 'error',
      error: 'Session state error - please try again'
    });
    return;
  }

  if (!found && state && state !== 'ENDED') {
    // Store says running but registry doesn't have it → crash recovery or bug
    log.error('session state invariant violation', {
      sessionId,
      state,
      violation: 'registry_missing_active_session',
    });
    span.recordException(new Error(`Registry missing session in state ${state}`));
    // Force to ENDED then resume — query loop is gone, only option is restart
    ctx.eventStore.setState(sessionId, 'ENDED', {
      reason: 'registry_lost_session',
      force: true,
    });
    // Fall through to resume explicitly
    const sessionClientId = `${connectionId}:${sessionId}`;
    ctx.connRegistry.watch(connectionId, sessionId);
    ctx.connRegistry.setActive(connectionId, sessionId);
    span.setAttribute('routing.decision', 'resume_after_recovery');
    startChat(transport, sessionClientId, prompt, {
      resume: sessionId,
      ...msg,
    });
    applySkillPolicy(sessionClientId);
    return;
  }

  // Guard: duplicate startChat while session is still booting
  if (found && (state === 'CREATED' || state === 'STARTING')) {
    log.warn('message received while session still starting, ignoring duplicate', {
      sessionId,
      state,
      clientId: found.clientId,
    });
    span.setAttribute('routing.decision', 'deduplicated');
    // Don't start a second query — the first one will transition to ACTIVE
    // and pick up this message from the conversation history on next turn.
    transport.send({
      type: 'system',
      message: 'Session is starting, please wait...',
    });
    return;
  }

  // Normal routing based on state
  if (found && (state === 'ACTIVE' || state === 'DETACHED' || state === 'SUSPENDED')) {
    // Session exists and is running - route to it
    const ownerConnection = getOwnerConnection(found.clientId);
    const isOwner = ownerConnection === connectionId;
    const isDetached = !ctx.sessionRegistry.isAttached(found.clientId);

    let activeClientId = found.clientId;

    if (!isOwner) {
      // Takeover
      const oldTransport = found.session?.transport;
      if (oldTransport?.isOpen()) {
        oldTransport.send({ type: 'session_takeover', sessionId });
      }
      ctx.connRegistry.unwatch(ownerConnection, sessionId);
      denyPendingBySession(sessionId);

      reattachChat(found.clientId, transport, ctx.eventStore);
      const newClientId = `${connectionId}:${sessionId}`;
      if (found.clientId !== newClientId) {
        rekeyChat(found.clientId, newClientId);
        activeClientId = newClientId;
      }
      log.info('takeover on send', { connectionId, sessionId, newClientId: activeClientId });
    } else if (isDetached) {
      // Reattach own session
      reattachChat(found.clientId, transport, ctx.eventStore);
      log.info('reattached own detached session on send', { connectionId, sessionId });
    }

    applySkillPolicy(activeClientId);
    sendToChat(activeClientId, prompt, ...);
    ctx.connRegistry.watch(connectionId, sessionId);
    ctx.connRegistry.setActive(connectionId, sessionId);
    span.setAttribute('routing.decision', isOwner ? 'active' : 'takeover');
    return;
  }

  // Session doesn't exist or is ENDED - resume from history
  if (!found && state === 'ENDED') {
    const sessionClientId = `${connectionId}:${sessionId}`;
    ctx.connRegistry.watch(connectionId, sessionId);
    ctx.connRegistry.setActive(connectionId, sessionId);
    span.setAttribute('routing.decision', 'resume');
    startChat(transport, sessionClientId, prompt, {
      resume: sessionId,
      ...msg,
    });
    applySkillPolicy(sessionClientId);
    return;
  }

  // Fallback: no state or unknown state - treat as resume
  log.warn('session state unknown, treating as resume', { sessionId, state });
  const sessionClientId = `${connectionId}:${sessionId}`;
  ctx.connRegistry.watch(connectionId, sessionId);
  ctx.connRegistry.setActive(connectionId, sessionId);
  span.setAttribute('routing.decision', 'resume_unknown_state');
  startChat(transport, sessionClientId, prompt, {
    resume: sessionId,
    ...msg,
  });
  applySkillPolicy(sessionClientId);
  return;
}

// No sessionId - new session
// ... existing new session logic
```

#### Remove Stale Check

Delete lines 385-394 in ws-handler-v2.ts:

```diff
- const storeMeta = ctx.eventStore.getSession(sessionId);
- const staleInMemory = storeMeta && !storeMeta.isActive;
-
- if (staleInMemory) {
-   log.info('removing stale session from registry (send)', {
-     connectionId,
-     sessionId,
-     clientId: found.clientId,
-   });
-   ctx.sessionRegistry.remove(found.clientId);
- }
```

#### Update All Lifecycle Methods to Accept EventStore

SessionRegistry methods need EventStore to update state:

```typescript
// session-registry.ts
class SessionRegistry {
  detach(clientId: string, store?: EventStore): void {
    // ... update state via store
  }

  reattach(clientId: string, transport: SessionTransport, store?: EventStore): boolean {
    // ... update state via store
  }

  suspend(clientId: string, store?: EventStore): boolean {
    // ... update state via store
  }

  // ... etc
}

// chat.ts - pass eventStore to registry methods
export function detachChat(clientId: string): void {
  return withSpan('session.detach', { 'session.clientId': clientId }, () => {
    registry.detach(clientId, eventStore);
  });
}

export function reattachChat(clientId: string, transport: SessionTransport): boolean {
  return withSpan('session.reattach', { 'session.clientId': clientId }, () => {
    return registry.reattach(clientId, transport, eventStore);
  });
}
```

#### Acceptance Criteria (Phase 3)

- [ ] Stale check removed
- [ ] State-based routing handles all cases
- [ ] Reattach hang bug fixed (verified on mobile)
- [ ] State invariant violations logged but rare (<1/day)
- [ ] All integration tests pass
- [ ] Manual testing: background for 1hr, return, send message → immediate response

### Phase 4: Enforce State Transition Validation

**Goal:** Make invalid transitions hard errors. Any violation is a bug we must fix.

#### Transition Validation

```typescript
// event-store.ts
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  CREATED: ['STARTING'],
  STARTING: ['ACTIVE', 'ENDED'],
  ACTIVE: ['DETACHED', 'SUSPENDED', 'CLOSING', 'ENDED'],
  DETACHED: ['ACTIVE', 'SUSPENDED', 'CLOSING', 'ENDED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  CLOSING: ['ENDED'],
  ENDED: ['STARTING'],
};

class EventStore {
  setState(
    sessionId: string,
    newState: SessionState,
    opts?: { clientId?: string; reason?: string; force?: boolean },
  ): void {
    const current = this.getSession(sessionId);
    const fromState = current?.state ?? null;

    // Validate transition
    // force: true bypasses validation — ONLY for crash recovery paths
    // (server startup stale cleanup, registry-lost-session recovery).
    // Normal lifecycle code must never pass force.
    if (fromState && !opts?.force) {
      const allowed = VALID_TRANSITIONS[fromState];
      if (!allowed.includes(newState)) {
        const err = new Error(`Invalid session state transition: ${fromState} → ${newState}`);
        log.error('invalid state transition blocked', {
          sessionId,
          fromState,
          toState: newState,
          clientId: opts?.clientId,
          reason: opts?.reason,
          stack: err.stack,
        });
        throw err;
      }
    }

    if (opts?.force) {
      log.warn('forced state transition (recovery path)', {
        sessionId,
        fromState,
        toState: newState,
        reason: opts?.reason,
      });
    }

    // Proceed with update
    const now = Date.now();
    this.db.run(
      `UPDATE sessions 
       SET state = ?, last_state_change = ?
       WHERE session_id = ?`,
      [newState, now, sessionId],
    );

    log.info('session state transition', {
      sessionId,
      fromState,
      toState: newState,
      clientId: opts?.clientId,
      reason: opts?.reason,
    });
  }
}
```

#### Crash Recovery on Server Start

```typescript
// app.ts - on server start
async function recoverStaleSessions(store: EventStore) {
  // On startup the registry is empty — no query loops survived the restart.
  // Any session not in ENDED is orphaned. Force-end all of them so the
  // state machine is consistent when clients reconnect and trigger
  // ENDED → STARTING via resume.
  const stale = store.db.all(
    `SELECT session_id, state, last_state_change 
     FROM sessions 
     WHERE state != 'ENDED'`,
  );

  if (stale.length > 0) {
    log.info('recovering orphaned sessions on startup', { count: stale.length });
  }

  for (const { session_id, state, last_state_change } of stale) {
    const ageMs = Date.now() - last_state_change;
    log.warn('force-ending orphaned session', {
      sessionId: session_id,
      previousState: state,
      ageMs,
    });
    store.setState(session_id, 'ENDED', {
      reason: 'server_restart_recovery',
      force: true,
    });
  }
}

// Call on startup after DB init
initEventStore();
recoverStaleSessions(eventStore);
```

#### Acceptance Criteria (Phase 4)

- [ ] All state transitions validated
- [ ] Invalid transitions throw errors in tests
- [ ] Crash recovery marks stale sessions as ENDED on startup
- [ ] Zero invalid transition errors in production for 1 week
- [ ] If errors occur, they reveal bugs we fix (not suppressed)

## Testing Strategy

### Unit Tests

```typescript
describe('EventStore.setState', () => {
  it('allows valid ACTIVE → DETACHED transition', () => {
    store.setState(sid, 'ACTIVE');
    expect(() => store.setState(sid, 'DETACHED')).not.toThrow();
  });

  it('blocks invalid ENDED → ACTIVE transition', () => {
    store.setState(sid, 'ENDED');
    expect(() => store.setState(sid, 'ACTIVE')).toThrow(/Invalid.*transition/);
  });

  it('allows ENDED → STARTING for explicit resume', () => {
    store.setState(sid, 'ENDED');
    expect(() => store.setState(sid, 'STARTING')).not.toThrow();
  });
});

describe('session lifecycle', () => {
  it('transitions through states on normal flow', async () => {
    const states: SessionState[] = [];
    const originalSetState = store.setState.bind(store);
    store.setState = (sid, state) => {
      states.push(state);
      originalSetState(sid, state);
    };

    await startChat(...);
    // simulate SDK events
    await waitForQueryEnd();

    expect(states).toEqual(['CREATED', 'STARTING', 'ACTIVE', 'ENDED']);
  });

  it('transitions ACTIVE → DETACHED → ACTIVE on reattach', () => {
    const session = createSession();
    store.setState(session.id, 'ACTIVE');

    detachChat(session.clientId);
    expect(store.getSessionState(session.id)).toBe('DETACHED');

    reattachChat(session.clientId, mockTransport);
    expect(store.getSessionState(session.id)).toBe('ACTIVE');
  });
});
```

### Integration Tests

```typescript
describe('reattach hang bug fix', () => {
  it('does not kill session on reattach after long idle', async () => {
    // Start session
    const { clientId, sessionId } = await startSession('test prompt');
    await waitForResponse();

    // Simulate long idle: detach and mark ENDED in store
    detachChat(clientId);
    eventStore.setState(sessionId, 'ENDED', { force: true });

    // Reconnect and send message
    const transport = mockTransport();
    const result = await sendWithReattach(transport, sessionId, 'follow-up');

    // Should resume, not hang
    expect(result.routing).toBe('resume');
    expect(result.response).toBeDefined();

    // Should NOT see 0-token session_end
    const events = eventStore.getEvents(sessionId);
    const sessionEnds = events.filter((e) => e.type === 'session_end');
    expect(sessionEnds.every((e) => e.usage.outputTokens > 0)).toBe(true);
  });
});
```

### Manual Testing Checklist

- [ ] Start session on mobile
- [ ] Background app for 5 minutes
- [ ] Return, send message → immediate response
- [ ] Background for 1 hour
- [ ] Return, send message → immediate response
- [ ] Kill app, restart, resume session → immediate response
- [ ] Detach during query (pull down iOS Command Center) → query continues
- [ ] Reattach during query → query completes normally
- [ ] Start session on mobile, switch to desktop → takeover works
- [ ] Start on desktop, switch to mobile → takeover works
- [ ] Background on mobile, server restarts, return → recovers gracefully

## Rollout Plan

1. **Phase 1 to dev:** Deploy with state writes, monitor logs for invalid transitions
2. **Phase 1 to prod:** After 1 week clean on dev
3. **Phase 2 to dev:** Enable observability, check dashboards
4. **Phase 2 to prod:** After verified on dev
5. **Phase 3 to dev:** Replace stale checks, verify hang bug fixed
6. **Phase 3 to prod:** After extensive mobile testing on dev
7. **Phase 4 to dev:** Enable validation, monitor for errors
8. **Phase 4 to prod:** After 1 week clean on dev

Each phase ships via feature flag so it can be reverted quickly if issues arise.

## Metrics and Observability

> **Note:** Mitzo currently uses OTLP tracing (Jaeger). The Prometheus-style metric names
> below (`_total`, `_gauge`, `_seconds`) assume adding an OTLP metrics exporter alongside
> tracing. If that's out of scope, derive equivalent dashboards from span attributes
> on the `session.state_transition` span (filter by `from_state`, `to_state`, compute
> dwell times from span durations).

### State Transition Events

Emit structured event on every transition:

```typescript
{
  "event": "session_state_transition",
  "session_id": "...",
  "from_state": "ACTIVE",
  "to_state": "DETACHED",
  "client_id": "conn-...:sess-...",
  "reason": "transport_close",
  "timestamp": 1779106631582
}
```

### Grafana Dashboards

**Panel 1: State Distribution (Pie)**

- Query: `count by (state) session_state_gauge`
- Shows snapshot of how many sessions in each state

**Panel 2: State Transition Rate (Time Series)**

- Query: `rate(session_state_transitions_total[5m]) by (from_state, to_state)`
- Shows transitions/sec over time

**Panel 3: State Dwell Time (Histogram)**

- Query: `histogram_quantile(0.95, session_state_duration_seconds by (state))`
- Shows p50/p95/p99 time spent in each state

**Panel 4: Invalid Transitions (Counter)**

- Query: `session_invalid_transitions_total by (from_state, to_state)`
- Should be zero; alert if non-zero

**Panel 5: State Mismatches (Counter)**

- Query: `session_state_mismatches_total by (type)`
- Should go to zero after Phase 2 fixes

### Alerts

- `session_invalid_transitions_total > 0` for 5 minutes → page on-call
- `session_state_mismatches_total > 10` for 15 minutes → Slack notification
- `rate(session_state_transitions_total{to_state="ENDED",reason="error"}[5m]) > 1` → investigate

## Migration Risks

### Risk: Phase 3 Breaks Resume Flow

**Mitigation:** Extensive integration tests covering resume paths. Feature flag allows instant rollback.

### Risk: State Transition Validation Too Strict

**Mitigation:** Phase 4 only enabled after Phase 3 runs cleanly for 1 week. If legitimate flows trigger validation errors, adjust VALID_TRANSITIONS or add force flag escape hatch.

### Risk: Performance Impact of State Writes

**Mitigation:** State updates are single-row UPDATEs on indexed column. Benchmark shows <1ms impact. If issue arises, batch state writes or use async queue.

### Risk: Schema Migration Locks Table

**Mitigation:** `ALTER TABLE ADD COLUMN` is fast on SQLite (metadata-only). Run during low-traffic window. Test migration on prod-sized DB copy first.

## Future Work (Out of Scope)

- **State history table:** Log all transitions for post-hoc analysis
- **State-based session listing:** Filter Command Center by state (show only ACTIVE)
- **State persistence across server restart:** Serialize registry to disk, reload on boot
- **Distributed state:** Move to Redis for multi-server deployment

## Success Criteria

### Phase 1

- [ ] State column added to all sessions
- [ ] All lifecycle operations write state
- [ ] Zero invalid transitions observed for 1 week

### Phase 2

- [ ] State in all logs
- [ ] Grafana dashboards operational
- [ ] Zero state mismatches for 1 week

### Phase 3

- [ ] Reattach hang bug fixed (manual test: background 1hr → immediate response)
- [ ] Stale check removed
- [ ] State invariant violations <1/day

### Phase 4

- [ ] Invalid transitions throw errors in tests
- [ ] Zero invalid transition errors in production for 1 week
- [ ] Crash recovery working

### Overall

- User-reported hang issues reduced to zero
- Session state debuggable via logs/traces
- New session lifecycle features can be built on state machine foundation

## Related Work

- [session-isolation-overhaul.md](./session-isolation-overhaul.md) - Multi-device session ownership
- [message-protocol-v2.md](./message-protocol-v2.md) - Event versioning
- PR #325 - visibilitychange recovery (fixed SSE but not session state)
- PR #320 - duplicate message prevention (another symptom of state confusion)

---

**Next Steps:**

1. Review this doc with team
2. Create Phase 1 implementation PR
3. Deploy to dev environment
4. Monitor for 1 week
5. Iterate based on findings
