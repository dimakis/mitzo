# Message Protocol v2: Server-Owned Message Lifecycle

**Status:** Proposal
**Date:** 2026-04-02
**Author:** Claude (with Dimitri)

## Problem

Over the last ~100 commits, 39 have been fixes. At least 21 target the same cluster: streaming state, message dedup, thinking block visibility, tool pill ordering, and WebSocket reliability. Each fix addresses a symptom; the root cause persists.

### The Root Cause

The server is a passthrough. It forwards raw SDK events (`content_block_start`, `content_block_delta`, `content_block_stop`, `assistant`, `result`) with minimal transformation. The frontend reducer must then reverse-engineer:

1. **Message boundaries** — when does one assistant message end and another begin?
2. **Block ownership** — does this `text_delta` belong to the current streaming message or a new one?
3. **Streaming state** — is the assistant still generating, or done? (Inferred from absence of events)
4. **Block finalization** — when is a thinking block "done"? (No explicit signal; finalized on `DONE` or next `TEXT_DELTA`)
5. **Interleaving** — when tool calls appear between text blocks, the reducer has to decide: same message or new message?

Every new feature (thinking blocks, tool pills, tool grouping, reasoning vs response distinction) adds more implicit state the reducer must infer from event timing. The result is a whack-a-mole: fixing one timing edge case breaks another.

### The Fix Chain (Evidence)

| Commit    | What it fixed                        | What it was really about                            |
| --------- | ------------------------------------ | --------------------------------------------------- |
| `67d9d35` | Added thinking + tool pills          | Introduced new event types into fragile pipeline    |
| `0fc3c4d` | Reasoning vs response text           | Tried to infer intent from position in event stream |
| `db9210f` | Tool pills vanishing mid-stream      | Grouping triggered during streaming                 |
| `0014e76` | Expand/collapse broken               | UI couldn't track identity across re-renders        |
| `88291ee` | Thinking blocks invisible; orphaned  | No finalization signal; had to bust SW cache        |
| `57588bf` | Cross-session response mixing        | Server-side identity leak on WS reattach            |
| `712d629` | Duplicate text + thinking as text    | `assistant` event re-sent already-streamed content  |
| `d047c32` | Service worker disconnect loop       | Stale frontend cache served old reducer code        |
| `af9849f` | SW network strategy                  | Cache-first serving stale JS with old bugs          |
| `7692376` | iOS WS reliability, message recovery | Transport dropping events, no way to recover state  |
| `d6ea69a` | Session dedup, stabilization         | Messages doubling up with no dedup mechanism        |

The pattern: each fix is correct in isolation but doesn't address why the problem keeps recurring.

## Design Principles

1. **The server owns message state.** The frontend is a renderer, not a state machine.
2. **Every event is explicit.** No inferring state from timing or absence of events.
3. **Every block has a lifecycle.** `start` → `delta*` → `end`. No exceptions.
4. **Messages have boundaries.** `message_start` → blocks → `message_end`. Always.
5. **The protocol is the contract.** If it's not in an event, the frontend doesn't know about it.

## Current Protocol (v1)

### Server → Client Events

```
client_id         — WS connection identity
session_info      — branch, cwd, worktree flag
session_id        — SDK session assigned

text_delta        — streaming text chunk (no start/end signals)
thinking_start    — thinking block begins (no ID, no way to track)
thinking_delta    — thinking text chunk
tool_call         — tool invoked (emitted on content_block_stop)
tool_result       — tool returned result (emitted from user event)

permission_request / permission_timeout
mode_changed

done              — query finished (also used as finalization for everything)
error             — query failed
reattached / reattach_failed
```

### Problems with v1

| Issue                                  | Why                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No `text_start` / `text_end`           | Frontend guesses when text starts/stops based on message role                                            |
| No `thinking_end`                      | Thinking finalized on `DONE` or when `TEXT_DELTA` arrives — fragile                                      |
| No `message_start` / `message_end`     | Can't distinguish "new message" from "continuation of current"                                           |
| `done` overloaded                      | Means "query complete" AND "finalize all open blocks"                                                    |
| No block IDs                           | Can't correlate start/delta/end for the same block                                                       |
| No message IDs                         | Can't correlate blocks to their parent message                                                           |
| `text` and `text_delta` both exist     | Server removed `text` sends but frontend still has a `TEXT` action — dead code confusion                 |
| Tool results arrive via different path | Tool calls come from `stream_event`, results from `user` event — different message types for paired data |

## Proposed Protocol (v2)

### Event Schema

Every v2 event has a common envelope:

```typescript
interface V2Event {
  v: 2; // Protocol version — allows gradual migration
  type: string; // Event type
  ts: number; // Server timestamp (ms) — monotonic within session
}
```

### Message Lifecycle Events

```typescript
// A new assistant turn begins. One per API call.
{ v: 2, type: 'message_start', ts, messageId: string }

// A content block begins within the current message.
{ v: 2, type: 'block_start', ts, messageId: string, blockId: string,
  blockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use' }

// Incremental content for a block.
{ v: 2, type: 'block_delta', ts, messageId: string, blockId: string,
  blockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use',
  delta: string }  // text chunk, thinking chunk, or JSON input chunk

// A content block is complete. No more deltas for this blockId.
{ v: 2, type: 'block_end', ts, messageId: string, blockId: string,
  blockType: 'text' | 'thinking' | 'tool_use',
  // For tool_use only:
  toolName?: string, toolId?: string, input?: string, rawInput?: RawToolInput }

// Tool result (paired with a prior tool_use block_end via toolId).
{ v: 2, type: 'tool_result', ts, messageId: string,
  toolId: string, result: string }

// The assistant turn is complete. All blocks finalized.
{ v: 2, type: 'message_end', ts, messageId: string }
```

### Session Lifecycle Events (unchanged, just versioned)

```typescript
{ v: 2, type: 'session_start', ts, sessionId?: string, branch: string,
  cwd: string, worktree: boolean }
{ v: 2, type: 'session_id', ts, sessionId: string }
{ v: 2, type: 'session_end', ts, sessionId?: string }
{ v: 2, type: 'error', ts, error: string }
```

### Permission Events (unchanged, just versioned)

```typescript
{ v: 2, type: 'permission_request', ts, permId, toolName, toolInput,
  title?, description?, displayName?, tier? }
{ v: 2, type: 'permission_timeout', ts, permId }
{ v: 2, type: 'mode_changed', ts, mode }
```

### Connection Events (unchanged)

```typescript
{ type: 'client_id', clientId }
{ type: 'reattached', clientId, sessionId?, running }
{ type: 'reattach_failed', clientId, reason }
```

## Server Changes

### query-loop.ts

The query loop becomes a **translator** from SDK events to v2 events. It maintains a small amount of state:

```typescript
interface LoopState {
  messageId: string | null; // Current assistant message
  blockIndex: number; // Auto-incrementing block counter
  toolBuffers: Map<
    number,
    {
      // Existing tool input buffering
      name: string;
      id: string;
      inputBuf: string;
      blockId: string;
    }
  >;
}
```

**SDK event → v2 event mapping:**

| SDK Event                                                 | v2 Event(s)                                     |
| --------------------------------------------------------- | ----------------------------------------------- |
| `stream_event` / `message_start`                          | `message_start` (generate messageId)            |
| `stream_event` / `content_block_start` (text)             | `block_start` (blockType: 'text')               |
| `stream_event` / `content_block_start` (thinking)         | `block_start` (blockType: 'thinking')           |
| `stream_event` / `content_block_start` (tool_use)         | `block_start` (blockType: 'tool_use')           |
| `stream_event` / `content_block_delta` (text_delta)       | `block_delta` (blockType: 'text')               |
| `stream_event` / `content_block_delta` (thinking_delta)   | `block_delta` (blockType: 'thinking')           |
| `stream_event` / `content_block_delta` (input_json_delta) | _(buffered — no emit)_                          |
| `stream_event` / `content_block_stop`                     | `block_end` (with tool data if tool_use)        |
| `user` / tool_result                                      | `tool_result`                                   |
| `assistant`                                               | `session_id` (if new) — no content re-send      |
| `result`                                                  | `message_end` (if message open) + `session_end` |

Key: the server **always emits `block_start` before any `block_delta`**, and **always emits `block_end` after the last delta**. The frontend never has to guess.

### Size of change

The query loop is 156 lines. The v2 translation adds ~30 lines (block_start for text blocks, block_end for all blocks, message_start/end wrappers). The existing tool buffering logic stays. The deleted code (the old `assistant` event text re-send) is already removed.

## Frontend Changes

### New Reducer State

```typescript
interface MessageState {
  messages: FinishedMessage[]; // Completed messages
  current: StreamingMessage | null; // In-flight message (at most one)
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
}

interface StreamingMessage {
  messageId: string;
  blocks: Map<string, StreamingBlock>; // blockId → block
  blockOrder: string[]; // Insertion order
}

interface StreamingBlock {
  blockId: string;
  blockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use';
  content: string; // Accumulated deltas
  done: boolean; // block_end received
  // tool_use specific:
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
  toolResult?: string;
}

interface FinishedMessage {
  messageId: string;
  blocks: FinishedBlock[];
}

interface FinishedBlock {
  blockId: string;
  blockType: 'text' | 'thinking' | 'tool_use';
  content: string;
  toolName?: string;
  toolId?: string;
  toolInput?: string;
  rawInput?: RawToolInput;
  toolResult?: string;
}
```

### New Reducer Actions

```typescript
type Action =
  | { type: 'MESSAGE_START'; messageId: string }
  | { type: 'BLOCK_START'; messageId: string; blockId: string; blockType: string }
  | { type: 'BLOCK_DELTA'; messageId: string; blockId: string; delta: string }
  | {
      type: 'BLOCK_END';
      messageId: string;
      blockId: string;
      toolName?: string;
      toolId?: string;
      input?: string;
      rawInput?: RawToolInput;
    }
  | { type: 'TOOL_RESULT'; toolId: string; result: string }
  | { type: 'MESSAGE_END'; messageId: string }
  | { type: 'SESSION_END' }
  | { type: 'ERROR'; error: string };
// ...permission, session_info, user_send, restore, connection_lost (unchanged)
```

### Reducer Logic (Simplified)

Each action does exactly one thing:

- **MESSAGE_START** → set `current = { messageId, blocks: new Map(), blockOrder: [] }`
- **BLOCK_START** → add block to `current.blocks` and `current.blockOrder`
- **BLOCK_DELTA** → append `delta` to `current.blocks.get(blockId).content`
- **BLOCK_END** → set `current.blocks.get(blockId).done = true`, attach tool metadata
- **TOOL_RESULT** → find block by `toolId` in `current` or `messages`, set `toolResult`
- **MESSAGE_END** → move `current` to `messages[]`, set `current = null`
- **SESSION_END** → set `running = false`, force-finalize `current` if still open

No guessing. No "if last message is thinking and streaming, finalize it." No "if last message is assistant and streaming, append." The block ID tells you where the delta goes. The block_end tells you it's done.

### What Gets Deleted

| Current Code                            | Why It Can Go                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `finalizeThinking()` helper             | `block_end` explicitly finalizes                                                        |
| `TEXT` action (non-delta)               | Dead code from removed `assistant` text re-send                                         |
| Thinking finalization in `DONE` handler | `message_end` handles this                                                              |
| `streaming` flag on Message type        | Derived from `current !== null`                                                         |
| Tool grouping `streaming` parameter     | Groups always applied to finished messages (in `messages[]`); `current` rendered inline |
| SW cache busting                        | Not needed — protocol change, not cache timing                                          |

### Rendering Model

```
messages[]  → FinishedMessage[] → groupMessages() → ToolGroup / MessageBubble / ThinkingBlock
current     → StreamingMessage  → render blocks in order, no grouping → individual components
```

Current (streaming) message always renders at the bottom, with blocks in `blockOrder`. No grouping applied during streaming — that was already the intent (see `db9210f`) but was enforced with a boolean flag. Now it's structural: `current` is a different type.

## Migration Strategy

### Phase 1: Atomic v2 cutover

The server emits v2 only, and the frontend migration lands in the same PR. The protocol is internal (no third-party consumers), and the frontend + server deploy atomically (same repo, same `pm2 restart`). No dual-emit needed.

**Rollback:** If something breaks post-deploy, revert the PR and `pm2 restart`. Active sessions at the moment of restart are terminated (acceptable — sessions are short-lived and the user can re-send).

### Phase 2: Frontend reducer rewrite

Replace `chatMessagesReducer` and `useChatMessages` with the new state model. This is the bulk of the work but it's a **simplification** — the new reducer has fewer branches, no inference logic, and each action is a trivial state update.

### Phase 3: Delete dead code

- Remove `TEXT` action and `text` WS message type
- Remove `finalizeThinking()`
- Remove `streaming` flag from `Message` type
- Remove the `streaming` parameter from `groupMessages()`
- Clean up `BUFFERABLE_TYPES` in ws-pool

### Estimated Scope

| File                                    | Change                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `server/query-loop.ts`                  | ~40 lines added (block_start/end wrappers), ~10 deleted |
| `frontend/src/hooks/useChatMessages.ts` | Rewrite reducer (~200 → ~150 lines)                     |
| `frontend/src/types/chat.ts`            | New types, deprecate old `Message.streaming`            |
| `frontend/src/lib/groupMessages.ts`     | Remove `streaming` param                                |
| `frontend/src/pages/ChatView.tsx`       | Render `current` separately from `messages`             |
| `frontend/src/lib/ws-pool.ts`           | Update `BUFFERABLE_TYPES`                               |
| `server/__tests__/query-loop.test.ts`   | Update expected events                                  |
| Tests                                   | New reducer tests with explicit lifecycle               |

Total: ~300 lines changed across 8 files. Net line count likely decreases.

## What This Fixes (Permanently)

| Bug class                                  | Why it can't recur                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Duplicate text messages                    | Text only arrives via `block_delta`; `assistant` event never re-sends content                |
| Thinking blocks invisible/orphaned         | `block_start` creates them, `block_end` finalizes them — explicit lifecycle                  |
| Tool pills vanishing mid-stream            | `current` renders blocks individually; grouping only on finished messages                    |
| Thinking content appearing as regular text | Block type is in every delta — can't misroute                                                |
| Expand/collapse identity issues            | `blockId` is stable across renders — natural React key                                       |
| "DONE as finalization" fragility           | `message_end` finalizes the message; `session_end` finalizes the session — separate concerns |
| Streaming state inference                  | `current !== null` means streaming. Period.                                                  |

## What This Doesn't Fix

- WebSocket transport reliability (reconnect, heartbeat, buffer) — already solid
- Service worker caching — orthogonal, already handled
- Cross-session mixing — already fixed server-side (`57588bf`)
- Reattach flow — already working, protocol-independent

## Resolved Questions

**Q1: Does `tool_result` need a `messageId`?**
No. Verified from SDK types and test sequences. The `user` event (tool results) always arrives _after_ `assistant` for the same turn, _before_ the next `message_start`. By then the turn's blocks are in `messages[]`. `toolId` matching is sufficient and unambiguous.

**Q2: What triggers `message_end`?**
The `assistant` SDK event — not `result`. `result` fires exactly once at session end across all turns. `assistant` fires once per turn. Mapping: `assistant` → `message_end`, `result` → `session_end`. In streaming-input mode the query loop must NOT break on `result` — emit `session_end` and let the finally block clean up.

**Q3: Should `block_delta` carry `blockType`?**
Yes. Makes events self-describing, simplifies snapshot reconstruction. Negligible bandwidth cost.

**Q4: Where does `messageId` come from?**
`BetaRawMessageStartEvent.message.id` — the API's own message ID, available in the `message_start` stream event. One stable ID per turn, no server-side generation needed.

---

## Follow-on: Session Control & Streaming Input

The client→server control model (interrupt, queue, stop, streaming input via `AsyncIterable`) is specified separately in [streaming-input-session-control.md](streaming-input-session-control.md). Ships after v2 is validated.

---

## Visibility / Silent Drop Problem

### The Bug

When iOS backgrounds the app the WS drops **silently** — no close event. Server `ws.readyState` still shows `OPEN`. The query loop keeps calling `send(currentWs, ...)`, which passes the check. Events go into the OS send buffer and are accepted — but never reach the client. When the app returns, the pool reconnects and reattaches, but in-flight events from the gap are **permanently lost**.

v2's explicit block IDs make events safe to replay, but don't eliminate the loss — they're still sent to a dead socket with no server-side buffer.

### The Fix: Message Snapshot on Reattach

The streaming-input query loop already tracks current block state (it must, to emit `block_start`/`delta`/`end`). On reattach it sends one **message snapshot** instead of replaying individual events:

```json
{
  "v": 2,
  "type": "message_snapshot",
  "messageId": "msg_...",
  "blocks": [
    { "blockId": "b0", "blockType": "text", "content": "all text so far", "done": false },
    {
      "blockId": "b1",
      "blockType": "tool_use",
      "done": true,
      "toolName": "Bash",
      "toolId": "tu_..."
    }
  ]
}
```

Client receives snapshot → reducer reconstructs `current` → stream continues with subsequent deltas. No ring buffer of hundreds of events.

Server: query loop maintains `currentSnapshot: StreamingMessage | null`, updated as blocks arrive. Cleared on `message_end`. Sent on reattach if non-null.

### Updated Reattach Flow

```
1. iOS silent drop — server sends events to void
2. App returns — pool reconnects, sends { type: 'reattach', clientId }
3. Server: registry.reattach(clientId, newWs)
4. If currentSnapshot → send message_snapshot
5. Stream resumes — subsequent block_delta/block_end flow normally
```

### New Reducer Action

```typescript
| { type: 'MESSAGE_SNAPSHOT'; messageId: string; blocks: SnapshotBlock[] }
```

Sets `current` to snapshot state. In-progress blocks (done: false) resume receiving deltas.

---

## Updated SDK → v2 Event Mapping

| SDK Event                                                  | v2 Output                                         | Notes                    |
| ---------------------------------------------------------- | ------------------------------------------------- | ------------------------ |
| `stream_event` / `message_start`                           | `message_start` (messageId from `evt.message.id`) | Clear tool buffers       |
| `stream_event` / `content_block_start` (text)              | `block_start` blockType: 'text'                   |                          |
| `stream_event` / `content_block_start` (thinking)          | `block_start` blockType: 'thinking'               |                          |
| `stream_event` / `content_block_start` (redacted_thinking) | `block_start` blockType: 'redacted_thinking'      | Render as placeholder    |
| `stream_event` / `content_block_start` (tool_use)          | `block_start` blockType: 'tool_use'               |                          |
| `stream_event` / `content_block_delta` (text_delta)        | `block_delta` blockType: 'text'                   | Update snapshot          |
| `stream_event` / `content_block_delta` (thinking_delta)    | `block_delta` blockType: 'thinking'               | Update snapshot          |
| `stream_event` / `content_block_delta` (input_json_delta)  | _(buffered)_                                      |                          |
| `stream_event` / `content_block_stop`                      | `block_end` (with tool data if tool_use)          | Mark snapshot block done |
| `user` (tool results)                                      | one `tool_result` per block, with `isError` flag  |                          |
| `assistant`                                                | `message_end` + `session_id` if new               | Clear snapshot           |
| `result`                                                   | `session_end`                                     | Session terminated       |

### Edge Cases

| Case                         | Handling                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Redacted thinking            | `block_start` blockType: 'redacted_thinking' — frontend renders "Reasoning redacted" |
| Tool result `is_error`       | Carried on `tool_result` — frontend can style failures                               |
| Abort mid-stream             | `session_end` in finally block — `SESSION_END` force-finalizes `current`             |
| iOS silent WS drop           | `message_snapshot` on reattach — frontend reconstructs in-flight state               |
| Tool-only response (no text) | `message_start` → `block_start` (tool) → `block_end` → `message_end` — clean         |
| Multiple tool calls          | One `block_end` + one `tool_result` per call — matched by `toolId`                   |
| Interrupt mid-generation     | `q.interrupt()` + new message — model receives context of what it was doing          |

---

## Review Notes (2026-04-02)

**Verify `toolId` global uniqueness.** Q1 assumes `toolId` matching is unambiguous, but if a session has the same tool called across multiple turns and a reattach happens mid-stream, a late-arriving `tool_result` could theoretically match the wrong turn's block. Confirm that the SDK's `toolId` is globally unique per session, not just per turn.

**`redacted_thinking` added to type unions.** Was present in the mapping table and edge cases but missing from the `blockType` unions in the protocol types and `StreamingBlock` interface. Fixed.
