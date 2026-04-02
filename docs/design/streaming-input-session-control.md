# Streaming Input & Session Control

**Status:** Proposal (follow-on to message-protocol-v2)
**Date:** 2026-04-02
**Depends on:** Message Protocol v2 (must ship first)
**Author:** Claude (with Dimitri)

## Context

Message Protocol v2 fixes the server→client event model. This doc addresses the other half: the client→server control model. Today the server starts a new `query()` per user message with `resume: sessionId`. This prevents mid-generation interruption, message queuing, and clean session lifecycle management.

These were sketched in the v2 doc's "Session Control Architecture" section but are intentionally separated — the protocol change is self-contained and should ship independently.

## Problem

The current `stop` button collapses three distinct operations:

| What the user wants          | What actually happens                              |
| ---------------------------- | -------------------------------------------------- |
| Redirect mid-generation      | Stop query, wait for done, re-send with new prompt |
| Send follow-up while running | Blocked — must wait or stop first                  |
| Hard terminate               | `q.close()` — correct, but same button as above    |

The `pendingSend` frontend hack (stop + re-send) exists because the architecture can't express "inject a message into a running session."

## Streaming Input Architecture

### Current Flow

```
User sends message → server starts query({ prompt, resume: sessionId })
                   → query completes (result event)
                   → next message starts a new query()
```

Each turn is a separate SDK call. `resume` provides continuity but the query is still ephemeral.

### Proposed Flow

```
User sends first message → server starts query({ prompt: asyncIterable })
                         → query stays alive
                         → subsequent messages pushed into iterable
                         → result fires once at session end
```

`query({ prompt: AsyncIterable<SDKUserMessage> })` keeps the query alive across turns. The server pushes new messages into the iterable. `result` fires once at session end, not per turn.

### Server Changes

**Registry** stores a pushable async queue alongside `Query`:

```typescript
interface SessionEntry {
  query: Query;
  queue: AsyncPushQueue<SDKUserMessage>; // pushable async iterable
  ws: WebSocket;
  snapshot: StreamingMessage | null; // from v2
}
```

**`handleSend`** changes from "start new query" to "push to queue":

```typescript
// Before
async function handleSend(ws, msg) {
  const q = sdk.query({ prompt: msg.prompt, resume: sessionId });
  registry.set(clientId, { query: q, ws });
  runQueryLoop(q, ws);
}

// After
async function handleSend(ws, msg) {
  const entry = registry.get(clientId);
  if (entry) {
    // Session alive — push into existing query
    entry.queue.push({ role: 'user', content: msg.prompt });
  } else {
    // First message — start query with async iterable
    const queue = new AsyncPushQueue<SDKUserMessage>();
    queue.push({ role: 'user', content: msg.prompt });
    const q = sdk.query({ prompt: queue });
    registry.set(clientId, { query: q, queue, ws, snapshot: null });
    runQueryLoop(q, ws);
  }
}
```

## Three Operations

### 1. Interrupt + Inject

Redirect the model mid-generation. The model receives context of what it was doing (partial response included in conversation history by the SDK).

```typescript
// Client → Server
{ type: 'interrupt', prompt: string }

// Server handling
async function handleInterrupt(ws, msg) {
  const entry = registry.get(clientId);
  entry.query.interrupt();
  entry.queue.push({ role: 'user', content: msg.prompt, priority: 'now' });
}
```

**Open question:** Does `interrupt()` drain pending queued items? If a user queued a message then interrupts before it's processed, the queued message should probably be dropped. Needs SDK verification.

### 2. Queue Message

Send a follow-up while the model is still generating. Processed after the current turn completes.

```typescript
// Client → Server
{ type: 'queue', prompt: string }

// Server handling
async function handleQueue(ws, msg) {
  const entry = registry.get(clientId);
  entry.queue.push({ role: 'user', content: msg.prompt, priority: 'next' });
}
```

The `send` message type can implicitly queue when a session is running — `queue` is the explicit variant.

### 3. Stop

Hard terminate. Session ends.

```typescript
// Client → Server
{
  type: 'stop';
}

// Server handling
async function handleStop(ws, msg) {
  const entry = registry.get(clientId);
  entry.query.close();
  // query loop's finally block emits session_end, cleans up registry
}
```

## Client → Server Message Types

```typescript
// Existing (updated semantics)
{ type: 'send', prompt, model?, mode?, systemPrompt?, customInstructions? }
// If no active session → start new query
// If active session → push priority: 'next'

// New
{ type: 'interrupt', prompt: string }   // q.interrupt() + push priority: 'now'
{ type: 'queue', prompt: string }       // push priority: 'next' explicitly
{ type: 'stop' }                        // q.close() — hard terminate
```

## Frontend Changes

### Delete `pendingSend`

The `pendingSend` pattern (stop → wait for done → re-send) is replaced by `interrupt`. The frontend sends `{ type: 'interrupt', prompt }` and the server handles the rest.

### Input Bar States

| Session state        | Send button                     | Stop button   | Input enabled |
| -------------------- | ------------------------------- | ------------- | ------------- |
| Idle                 | Send (`send`)                   | Hidden        | Yes           |
| Running              | Queue (`queue`)                 | Stop (`stop`) | Yes           |
| Running + user typed | Send as interrupt (`interrupt`) | Stop (`stop`) | Yes           |

**UX decision needed:** Should the send button during generation be "queue" (non-disruptive) or "interrupt" (redirects)? Could be both — tap to queue, long-press to interrupt. Or a toggle. This needs design input.

## Open Questions

### Q1: AsyncPushQueue implementation

Does the Claude SDK support `AsyncIterable` as the prompt input? Need to verify the exact API surface. If not natively supported, the queue pattern may need to work through `resume` with fast reconnection — functionally similar but architecturally different.

### Q2: Backpressure

What happens if the user queues multiple messages faster than the model processes them? Options:

- **No limit** — queue grows unbounded (unlikely to be a real problem given human typing speed)
- **Queue depth limit** — reject or warn after N pending messages
- **Replace** — newest queued message replaces previous (last-writer-wins)

Recommend: no limit initially, add depth limit if needed.

### Q3: Interrupt semantics with pending queue

If the queue has `[msg_A, msg_B]` pending and the user sends `interrupt(msg_C)`:

- Does `interrupt` drain the queue? (msg_A and msg_B dropped)
- Does `interrupt` jump the queue? (msg_C processed, then msg_A, msg_B)

Recommend: drain the queue. An interrupt signals "forget what I said, do this instead."

### Q4: `result` event handling

In streaming-input mode, `result` fires once at session end across all turns. The query loop must NOT break on `result` per-turn — only on session close. This is a behavioral change from the current per-query model.

### Q5: Error recovery

If the async iterable errors (e.g., malformed message pushed), does the entire session die? Should the queue validate messages before pushing?

## Scope Estimate

| File                                    | Change                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| `server/query-loop.ts`                  | AsyncPushQueue integration, interrupt/queue/stop handlers |
| `server/ws-handlers.ts`                 | New message type routing                                  |
| `server/registry.ts`                    | Store queue alongside query                               |
| `frontend/src/hooks/useChatMessages.ts` | Remove `pendingSend`, add queue/interrupt actions         |
| `frontend/src/components/InputBar.tsx`  | State-dependent button behavior                           |
| `frontend/src/lib/ws-pool.ts`           | New outbound message types                                |
| Tests                                   | Queue semantics, interrupt behavior, stop cleanup         |

## Relationship to Protocol v2

This builds on v2 but doesn't change it. The v2 event schema is stable regardless of whether messages arrive via `resume` or `AsyncIterable`. The only coupling point is `message_end` — in streaming-input mode, `assistant` events still trigger `message_end`, and `result` triggers `session_end`. The mapping table in the v2 doc already accounts for this.

Ship v2 first. Validate. Then layer this on top.
