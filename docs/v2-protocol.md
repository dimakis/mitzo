# v2 Streaming Protocol

Mitzo uses a custom WebSocket protocol (v2) to stream Claude Code session events between server and client. This document covers the message lifecycle, reconnection semantics, subagent nesting, and transport alternatives.

For the internal design rationale, see `docs/design/message-protocol-v2.md`.

## Connection Lifecycle

### Handshake

```
Client                           Server
  |                                |
  |--- hello {protocolVersion: 2} -->
  |                                |
  |<-- welcome {connectionId} ---- |
  |                                |
```

The client sends a `hello` message immediately after the WebSocket opens. The server responds with a `welcome` containing a `connectionId` that identifies this connection for the session's lifetime.

```json
// Client -> Server
{ "type": "hello", "protocolVersion": 2 }

// Server -> Client
{ "type": "welcome", "protocolVersion": 2, "connectionId": "conn-abc123" }
```

### Reconnection

When a WebSocket drops and reconnects, the client sends a `reconnect` message with the sessions it was watching and the last sequence number received for each:

```json
// Client -> Server
{
  "type": "reconnect",
  "sessions": [
    { "sessionId": "sess-1", "lastSeq": 42 },
    { "sessionId": "sess-2", "lastSeq": 17 }
  ]
}

// Server -> Client
{
  "type": "reconnected",
  "sessions": [
    { "sessionId": "sess-1", "replayed": 5, "running": true },
    { "sessionId": "sess-2", "replayed": 0, "running": false }
  ]
}
```

The server replays all events after each session's `lastSeq` from the event store. The client processes replayed events through the same reducer as live events, so the UI catches up seamlessly.

## Session Management

### Watching Sessions

A connection can watch multiple sessions simultaneously. Watched sessions receive event broadcasts.

```json
// Subscribe
{ "type": "watch", "sessionId": "sess-1" }
// Confirm
{ "type": "watched", "sessionId": "sess-1" }

// Unsubscribe
{ "type": "unwatch", "sessionId": "sess-1" }
// Confirm
{ "type": "unwatched", "sessionId": "sess-1" }
```

### Switching Active Session

The active session is the one the client is currently interacting with. Only one session can be active per connection.

```json
// Switch to session
{ "type": "switch_session", "sessionId": "sess-1" }
// Server confirms with session metadata
{
  "type": "session_switched",
  "sessionId": "sess-1",
  "mode": "agent",
  "cwd": "/path/to/worktree",
  "branch": "session/sess-1",
  "wtId": "wt-123",
  "running": true,
  "tokens": {
    "input": 10000,
    "output": 5000,
    "cacheRead": 3000,
    "cacheCreation": 1000,
    "costUsd": 0.45
  }
}

// Clear active session
{ "type": "switch_session", "sessionId": null }
// Confirm
{ "type": "session_cleared" }
```

### Suspend (iOS Background)

```json
// Client -> Server (via WS or sendBeacon fallback)
{
  "type": "session_suspend",
  "sessions": [{ "sessionId": "sess-1", "lastSeq": 42 }]
}
```

### Close Session

```json
{ "type": "session_close", "sessionId": "sess-1" }
// Confirm
{ "type": "session_close_ack", "sessionId": "sess-1" }
```

### Session Takeover

If another connection takes over an active session, the original connection receives:

```json
{ "type": "session_takeover", "sessionId": "sess-1" }
```

## Chat Messages

### Sending a Message

```json
{
  "type": "send",
  "sessionId": null,
  "prompt": "Fix the login bug",
  "clientMsgId": "msg-uuid-1",
  "mode": "agent",
  "images": [{ "data": "base64...", "mediaType": "image/png" }],
  "contextBlocks": ["Architecture"],
  "extraTools": "Bash",
  "isolation": true,
  "telosTaskId": "telos-123",
  "agentName": "workspace-assistant"
}
```

| Field           | Type             | Required | Description                                                |
| --------------- | ---------------- | -------- | ---------------------------------------------------------- |
| `sessionId`     | `string \| null` | Yes      | `null` to start a new session, or existing session ID      |
| `prompt`        | `string`         | Yes      | User message (min 1 char)                                  |
| `clientMsgId`   | `string`         | Yes      | Client-generated message ID for dedup                      |
| `model`         | `string`         | No       | Model override                                             |
| `mode`          | `string`         | No       | Permission mode: `ask`, `agent`, `auto`                    |
| `cwd`           | `string`         | No       | Working directory override                                 |
| `extraTools`    | `string`         | No       | Additional tools to allow                                  |
| `isolation`     | `boolean`        | No       | Enable worktree isolation                                  |
| `images`        | `array`          | No       | Image attachments (base64 + mediaType)                     |
| `contextBlocks` | `string[]`       | No       | Context block IDs to inject                                |
| `telosTaskId`   | `string`         | No       | Link session to a Telos task                               |
| `agentName`     | `string`         | No       | Agent definition name (alphanumeric, hyphens, underscores) |

When `sessionId` is `null`, the server creates a new session and responds with:

```json
{ "type": "session_id", "sessionId": "sess-new-123" }
```

### Interrupting

Send a follow-up message while Claude is still responding:

```json
{
  "type": "interrupt",
  "sessionId": "sess-1",
  "prompt": "Actually, also fix the logout",
  "clientMsgId": "msg-uuid-2"
}
```

### Stopping

Abort the current query:

```json
{ "type": "stop", "sessionId": "sess-1" }
```

### Permission Response

Respond to a tool permission prompt:

```json
{
  "type": "permission_response",
  "sessionId": "sess-1",
  "permId": "perm-123",
  "decision": "once"
}
```

Decisions: `once` (allow this invocation), `always` (add to session allow-list), `deny`.

### Setting Mode

```json
{ "type": "set_mode", "sessionId": "sess-1", "mode": "auto" }
// Confirm
{ "type": "mode_changed", "sessionId": "sess-1", "mode": "auto" }
```

## Message Lifecycle

The core of the v2 protocol is the block lifecycle. Every assistant response follows this pattern:

```
message_start
  +-- block_start (text)
  |     +-- block_delta (streaming text chunks)
  |     +-- block_delta
  |     +-- block_end
  +-- block_start (tool_use)
  |     +-- block_delta (tool input JSON)
  |     +-- block_end
  |     +-- tool_result
  +-- block_start (text)
  |     +-- block_delta
  |     +-- block_end
message_end
```

### message_start

Marks the beginning of an assistant turn.

```json
{
  "v": 2,
  "type": "message_start",
  "ts": 1720000001000,
  "messageId": "msg-server-1",
  "sessionId": "sess-1"
}
```

### block_start

A content block begins. Block types: `text`, `tool_use`.

```json
// Text block
{
  "v": 2,
  "type": "block_start",
  "ts": 1720000002000,
  "blockId": "block-1",
  "blockIndex": 0,
  "blockType": "text",
  "sessionId": "sess-1"
}

// Tool use block
{
  "v": 2,
  "type": "block_start",
  "ts": 1720000003000,
  "blockId": "block-2",
  "blockIndex": 1,
  "blockType": "tool_use",
  "toolName": "Edit",
  "toolUseId": "tool-use-123",
  "sessionId": "sess-1"
}
```

### block_delta

Streaming content for an open block. For text blocks, `delta` is a string. For tool use blocks, `delta` may be a partial JSON object.

```json
{
  "v": 2,
  "type": "block_delta",
  "ts": 1720000003500,
  "blockId": "block-1",
  "blockIndex": 0,
  "delta": "Here's the fix for the",
  "sessionId": "sess-1"
}
```

### block_end

A content block is complete.

```json
{
  "v": 2,
  "type": "block_end",
  "ts": 1720000004000,
  "blockId": "block-1",
  "blockIndex": 0,
  "sessionId": "sess-1"
}
```

### tool_result

The result of a tool execution, delivered after the tool's `block_end`.

```json
{
  "v": 2,
  "type": "tool_result",
  "ts": 1720000005000,
  "blockId": "block-2",
  "blockIndex": 1,
  "sessionId": "sess-1",
  "result": "File updated successfully"
}
```

### message_end

Marks the end of an assistant turn with usage statistics.

```json
{
  "v": 2,
  "type": "message_end",
  "ts": 1720000006000,
  "messageId": "msg-server-1",
  "sessionId": "sess-1",
  "stopReason": "end_turn",
  "usage": {
    "inputTokens": 5000,
    "outputTokens": 2000,
    "cacheReadTokens": 1500,
    "cacheCreationTokens": 500
  }
}
```

### session_end

Marks the end of a query (SDK query complete).

```json
{
  "v": 2,
  "type": "session_end",
  "ts": 1720000007000,
  "sessionId": "sess-1",
  "usage": {
    "inputTokens": 15000,
    "outputTokens": 8000
  }
}
```

## Deferred message_end

The server uses an `openBlockCount` to defer `message_end` until all blocks are closed. This handles the case where the SDK emits `message_end` before the last tool result is delivered:

```
SDK order:                v2 order (deferred):
  text                      text
  tool_use                  tool_use
  message_end  <-- early    tool_result  <-- delivered first
  tool_result               message_end  <-- deferred until here
```

The `forceFlushPendingMessage()` function force-closes any open blocks at turn boundaries and session end, preventing orphaned streaming state.

## Subagent Messages

When Claude spawns a subagent (via the Agent tool), Mitzo tracks it as a nested message stream within the parent tool use block.

```
message_start
  +-- block_start (tool_use: "Agent")
  |     +-- block_delta (tool input)
  |     +-- block_end
  |     +-- subagent_start
  |     |     +-- subagent_block_start (text)
  |     |     |     +-- subagent_block_delta
  |     |     |     +-- subagent_block_end
  |     |     +-- subagent_block_start (tool_use)
  |     |     |     +-- subagent_block_delta
  |     |     |     +-- subagent_block_end
  |     |     |     +-- subagent_tool_result
  |     |     +-- subagent_end
  |     +-- tool_result
message_end
```

### subagent_start

```json
{
  "v": 2,
  "type": "subagent_start",
  "ts": 1720000010000,
  "parentToolId": "tool-use-123",
  "parentBlockId": "block-2",
  "parentToolName": "Agent",
  "sessionId": "sess-1"
}
```

### subagent_block_start / subagent_block_delta / subagent_block_end

Same structure as top-level blocks, but prefixed with `subagent_` and carrying `parentToolId`:

```json
{
  "v": 2,
  "type": "subagent_block_start",
  "ts": 1720000011000,
  "parentToolId": "tool-use-123",
  "blockId": "sub-block-1",
  "blockIndex": 0,
  "blockType": "text",
  "sessionId": "sess-1"
}
```

### subagent_tool_result

```json
{
  "v": 2,
  "type": "subagent_tool_result",
  "ts": 1720000012000,
  "parentToolId": "tool-use-123",
  "blockId": "sub-block-2",
  "blockIndex": 1,
  "result": "File created",
  "sessionId": "sess-1"
}
```

### subagent_end

```json
{
  "v": 2,
  "type": "subagent_end",
  "ts": 1720000013000,
  "parentToolId": "tool-use-123",
  "sessionId": "sess-1",
  "usage": {
    "inputTokens": 3000,
    "outputTokens": 1500
  }
}
```

### subagent_cancelled

If a subagent is interrupted or fails:

```json
{
  "v": 2,
  "type": "subagent_cancelled",
  "ts": 1720000014000,
  "parentToolId": "tool-use-123",
  "sessionId": "sess-1"
}
```

## Other Server Messages

### user_message

Echoed back after the server receives a `send` message:

```json
{
  "type": "user_message",
  "sessionId": "sess-1",
  "id": "msg-uuid",
  "prompt": "Fix the bug",
  "clientMsgId": "msg-uuid-1"
}
```

### boot_context

Session context metadata sent on connect or session switch:

```json
{
  "type": "boot_context",
  "sessionId": "sess-1",
  "source": "contexgin",
  "tokenCount": 8000,
  "tokenBudget": 12000,
  "sourceCount": 6
}
```

### session_resumed

Sent when a suspended session is resumed:

```json
{
  "type": "session_resumed",
  "sessionId": "sess-1",
  "replayed": 3
}
```

### skill_invoked

Notification that a skill was resolved and invoked:

```json
{
  "v": 2,
  "type": "skill_invoked",
  "name": "pr-review",
  "source": "bundled",
  "arguments": { "pr": "42" }
}
```

### native_command_result

Result of a native command (like `/skills`):

```json
{
  "v": 2,
  "type": "native_command_result",
  "command": "skills",
  "content": "Available skills:\n- /simplify ..."
}
```

### error

```json
{
  "type": "error",
  "error": "Session not found: sess-999"
}
```

## Message Versioning

All v2 protocol messages include a `v: 2` field. This allows the client to distinguish v2 messages from any legacy formats during migration periods.

## Sequence Numbers

Every event stored in the event store gets a monotonic sequence number per session. Clients track the last received `seq` per session and use it for reconnection replay. The `MitzoConnection` class handles this automatically via `trackSeq()` and `getLastSeq()`.

## SSE Alternative

For environments where WebSocket is unavailable, the same protocol semantics are available over Server-Sent Events:

1. `GET /api/chat/events` opens an SSE stream
2. Server sends `welcome` event with `connectionId`
3. Client uses POST endpoints (`/api/chat/send`, `/api/chat/stop`, etc.) with `X-Connection-ID` header
4. Server pushes v2 events over the SSE stream

The message format is identical; only the transport differs.

## Client Implementation

The `@mitzo/client` package provides a complete client implementation:

- **`MitzoConnection`** -- manages the WebSocket lifecycle, hello/welcome handshake, reconnection with seq replay, and pending message queue (up to 100 messages during reconnect)
- **Protocol parser** -- `parseServerMessage()` converts raw JSON into typed actions
- **Zustand store** -- dispatches parsed messages through a reducer that maintains streaming state, finished messages, permissions, and session metadata
- **React hooks** -- `useChatMessages`, `useConnection`, `useSessions`, etc.

See [docs/packages.md](packages.md) for the full client API.
