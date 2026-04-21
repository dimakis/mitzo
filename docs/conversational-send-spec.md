# Conversational Send During Active Turns

## Status: Draft (captured 2026-04-19)

## Problem

When Claude spawns sub-agents (Task tool) during a turn, the session stays in `running` state until `session_end`. Claude often sends text messages to the user mid-turn — asking questions, giving updates, or requesting input — while sub-agents continue working in the background.

The current UI only offers two options during `running`:

- **Queue**: stages the message, auto-fires when the turn ends (could be minutes later)
- **Interrupt**: fires immediately, which may disrupt the agent's flow

Neither is correct. The user wants to **reply normally** to Claude's mid-turn messages. The SDK's `inputQueue` accepts new user messages at any point during a turn — the limitation is purely in the frontend UX.

## Root Cause

The frontend uses a single boolean `running` (derived from `session_end` not having fired) to decide between normal send and queue/interrupt mode. It doesn't track whether Claude has "yielded" to the user by completing a text message.

## Key Signal: `message_end` + last block type

The SDK emits this event sequence when Claude sends text and then spawns sub-agents:

```
message_start (messageId: "msg-1")
  block_start (type: text)
  block_delta (text chunks...)
  block_end
  block_start (type: tool_use, name: "Task")
  block_delta (input chunks...)
  block_end
assistant → message_end (messageId: "msg-1")
  tool_result (tool execution proceeds in background)
message_start (messageId: "msg-2", parent_tool_use_id: "tool-xyz")
  ... sub-agent blocks ...
```

After `message_end` for "msg-1", the model has finished its response. If the last content block before any tool_use blocks was text, the agent effectively "said something" — that's the yield point.

## Proposed Solution: `awaitingReply` state

### Protocol Parser (`packages/client/src/protocol-parser.ts`)

Add a new state field `awaitingReply: boolean` to the messages slice:

- Set `true` when `message_end` fires and the message contained at least one `text` block
- Set `false` when a new `message_start` fires (agent is responding again)
- Set `false` on `session_end`

### Client Store

Expose `awaitingReply` alongside `running` in the messages state.

### ChatInput

The send button logic becomes:

```
if (!running) → normal send
if (running && awaitingReply) → normal send (treat as conversational reply)
if (running && !awaitingReply) → queue/interrupt mode
```

When `awaitingReply` is true:

- Show the normal send button (↑), not queue/interrupt
- Placeholder text: "Reply to Mitzo..." instead of "Type to queue or interrupt..."
- No queue staging — send fires immediately via `onSend()`
- The interrupt button (↯) is still available if the user wants to force a message through

### Edge Cases

1. **Claude sends text, then immediately starts tool calls in the same message**: `awaitingReply` should be set based on whether the message _ended_ with text visible to the user, not just whether it contained text. If the last block is `tool_use`, the agent didn't really yield.

2. **Multiple rapid messages**: `awaitingReply` resets on each `message_start`. If Claude fires a quick follow-up, the flag flips false→true quickly.

3. **Permission requests**: Already handled separately (`permission` state). `awaitingReply` is orthogonal.

4. **Sub-agent messages**: These have `parent_tool_use_id` set. The parent agent isn't waiting for user input during sub-agent execution — only set `awaitingReply` for parent messages (`parent_tool_use_id === null`).

## Implementation Plan

### Files to modify

| File                                     | Change                                                             |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `packages/client/src/messages-slice.ts`  | Add `awaitingReply` to state, handle in reducer                    |
| `packages/client/src/protocol-parser.ts` | Dispatch `SET_AWAITING_REPLY` on `message_end` with text heuristic |
| `packages/client/src/index.ts`           | Export the new state field                                         |
| `frontend/src/components/ChatInput.tsx`  | Use `awaitingReply` to switch between normal send and queue mode   |
| `frontend/src/pages/ChatView.tsx`        | Pass `awaitingReply` to ChatInput                                  |

### Detection heuristic

On `message_end`:

1. Look at the blocks for that `messageId`
2. If `parent_tool_use_id` is set (sub-agent message), don't set `awaitingReply`
3. Find the last block that is `text` or `tool_use`
4. If it's `text` (or there are no tool_use blocks), set `awaitingReply = true`
5. Otherwise (message ended with only tool calls), leave `awaitingReply = false`

### Testing

- Agent sends text only → `awaitingReply = true`, normal send available
- Agent sends text + tool calls → `awaitingReply = false` (agent is working)
- Agent sends text, tool finishes, agent sends more text → `awaitingReply` toggles correctly
- Sub-agent messages → don't trigger `awaitingReply`
- `session_end` → `awaitingReply = false`, `running = false`

## Dependencies

- `@mitzo/client` package (messages slice, protocol parser)
- `@mitzo/protocol` package (may need a new action type)
- No server changes required — all signals already exist in the event stream

## Notes

The SDK's `inputQueue` is an `AsyncIterable<SDKUserMessage>` that stays open for the session lifetime. Pushing a new user message onto it at any point is valid — the SDK handles interleaving. The current "queue then fire on session_end" behavior is a frontend-imposed limitation, not an SDK one.
