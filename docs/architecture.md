# Architecture

Deep dive into Mitzo's module structure, data flow, and design decisions.

## System Overview

Mitzo is a Node.js + TypeScript server and React 19 frontend that provides a mobile-first web UI for Claude Code sessions via the Anthropic Agent SDK. It runs as a long-lived HTTPS server, translating raw SDK stream events into a v2 block lifecycle protocol delivered over WebSocket (or SSE fallback).

```
+-------------------------------------------------------------------+
|                         Mitzo Server                               |
|                                                                    |
|  +----------+   +----------+   +----------+   +--------------+    |
|  | Query    |   | Session  |   | Connect  |   | Worktree     |    |
|  | Loop     |   | Registry |   | Registry |   | Manager      |    |
|  |          |   |          |   |          |   |              |    |
|  | SDK ->   |   | detach/  |   | single   |   | create/      |    |
|  | v2 proto |   | reattach |   | mux WS   |   | cleanup/     |    |
|  | snapshot |   | snapshot |   | watch/   |   | guard        |    |
|  +----------+   +----------+   | sync     |   +--------------+    |
|       |              |         +----------+         |              |
|       v              v              |               v              |
|  +---------------------------------------------------------+      |
|  |                  Express + WebSocket                     |      |
|  |  REST API    SSE stream    WS v2 handler                |      |
|  +---------------------------------------------------------+      |
|       |              |              |               |              |
|  +---------+  +----------+  +----------+  +---------------+       |
|  | Event   |  | Task     |  | Skill    |  | Permission    |       |
|  | Store   |  | Board    |  | Registry |  | Handler       |       |
|  | (SQLite)|  | (SQLite) |  |          |  |               |       |
|  +---------+  +----------+  +----------+  +---------------+       |
+-------------------------------------------------------------------+
```

## Module Dependency Graph

```
                    +----------+
                    |  index   |
                    | (server) |
                    +----+-----+
                         |
              +----------+----------+
              v          v          v
        +--------+  +--------+  +--------+
        |  app   |  |  WS    |  |  Chat  |
        |(routes)|  |handler |  |  REST  |
        +---+----+  +---+----+  +---+----+
            |            |          |
     +------+------+     v          v
     v      v      v  +--------+ +--------+
+------+ +------+ +--| query  | | chat   |
|files | |tasks | |  | loop   | |        |
|inbox | |loop  | |  +---+----+ +---+----+
|auth  | |      | |      |         |
+------+ +------+ |      v         v
                   |  +--------+ +--------+
                   |  |session | |perm.   |
                   |  |registry| |handler |
                   |  +---+----+ +---+----+
                   |      |         |
                   |      v         v
                   |  +--------+ +--------+
                   +->|event   | |tool    |
                      |store   | |tiers   |
                      +--------+ +--------+
```

Arrows indicate "depends on" relationships. Most modules are independently testable via dependency injection and the `app.ts` factory.

## Request Flow: Chat Message

A single user message flows through the system as follows:

```
1. Client sends        2. WS handler          3. Chat module         4. Query loop
   v2 "send" msg          routes msg              starts SDK query       translates events
+-------------+       +-------------+        +-------------+        +-------------+
| prompt:     |       | validate    |        | assemble    |        | SDK event:  |
| "fix bug"   |------>| schema      |------->| system      |------->| text delta  |
| sessionId:  |       | find/create |        | prompt +    |        | tool_use    |
| null (new)  |       | session     |        | query()     |        | tool_result |
+-------------+       +-------------+        +-------------+        +-------------+
                                                                          |
5. v2 protocol         6. Transport            7. Connection              |
   events                 layer                   registry                |
+-------------+       +-------------+        +-------------+             |
| block_start |<------| session     |<-------| broadcast   |<------------+
| block_delta |       | transport   |        | to watchers |
| block_end   |       | adapter     |        |             |
| message_end |       +-------------+        +-------------+
+-------------+
        |
        v
8. Client store
+-------------+
| Zustand     |
| reducer     |
| dispatches  |
| React re-   |
| renders     |
+-------------+
```

### Step by Step

1. **Client sends `send` message** via WebSocket. `sessionId: null` starts a new session; a non-null ID continues an existing one.

2. **WS handler** (`ws-handler-v2.ts`) validates the message against Zod schemas. For new sessions, it calls `startChat()` which creates a `SessionRegistry` entry, allocates worktrees, and builds the system prompt.

3. **Chat module** (`chat.ts`) assembles the full system prompt (base + worktree paths + task context + context blocks), creates an `AsyncQueue` for streaming input, and calls the Agent SDK's `query()` with the user's prompt.

4. **Query loop** (`query-loop.ts`) receives raw SDK events and translates them into v2 protocol messages. It maintains an `openBlockCount` to defer `message_end` until all blocks are closed. It tracks snapshot state for reconnection recovery.

5. **v2 protocol events** (`block_start`, `block_delta`, `block_end`, `message_end`) are emitted as JSON strings.

6. **Session transport** (`ws-transport.ts`) wraps the WebSocket connection and handles send operations. The transport is swappable for testing via `NullTransport`.

7. **Connection registry** broadcasts events to all connections watching the session. Multiple connections can watch a session simultaneously (e.g., phone + laptop).

8. **Client store** (`@mitzo/client`) parses the v2 protocol messages via the protocol parser, dispatches actions to the Zustand store, and React components re-render.

## Session Lifecycle

Sessions have a well-defined state machine:

```
                  +--------+
                  |CREATED |
                  +---+----+
                      |
                      v
                  +--------+
          +------>|STARTING|
          |       +---+----+
          |           |
          |           v
          |       +--------+
          |  +--->|ACTIVE  |<----+
          |  |    +---+----+     |
          |  |        |         |
          |  |   +----+----+   |
          |  |   |         |   |
          |  |   v         v   |
          |  | +------+ +------+
          |  | |DETACH| |SUSP. |
          |  | +--+---+ +--+---+
          |  |    |        |
          |  +----+   +----+
          |           |
          |           v
          |       +--------+
          |       |CLOSING |
          |       +---+----+
          |           |
          |           v
          |       +--------+
          +-------|ENDED   |
                  +--------+
```

| State       | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `CREATED`   | Session allocated, worktrees not yet created                    |
| `STARTING`  | SDK `query()` call in progress, worktrees being set up          |
| `ACTIVE`    | Session is running, connected to a transport                    |
| `DETACHED`  | WebSocket disconnected but session still alive (48h TTL)        |
| `SUSPENDED` | Client explicitly suspended (iOS background, sendBeacon)        |
| `CLOSING`   | Graceful closeout in progress (agent asked to commit/summarize) |
| `ENDED`     | Session terminated, resources cleaned up                        |

### Detach and Reattach

When a WebSocket connection drops (phone locks, network change), the session enters `DETACHED` state with a 48-hour TTL. If the client reconnects within that window:

1. Client sends `reconnect` message with `sessions[]` and `lastSeq` per session
2. Server replays missed events from the event store (starting from `lastSeq + 1`)
3. Session transitions back to `ACTIVE`
4. If the SDK query was still running, streaming continues seamlessly

If TTL expires, the session enters a two-phase closeout: the agent is asked to commit work and summarize, then the session is aborted.

### Suspend (iOS Background)

iOS kills WebSocket connections when the app enters background. Mitzo handles this with a proactive suspend signal:

1. Client calls `sendSuspend()` which uses `sendBeacon()` (survives page unload) to `POST /api/sessions/suspend`
2. Server marks sessions as `SUSPENDED` (distinct from `DETACHED`)
3. On foreground return, client reconnects and resumes from last sequence number

## Event Store

The event store (`event-store.ts`) is a SQLite database (`.mitzo/events.db`) that provides crash-safe persistence for session events. Every v2 protocol message is appended with a monotonic sequence number per session.

```
events table
+-----+------------+--------+---------+------------+
| seq | session_id | type   | payload | created_at |
+-----+------------+--------+---------+------------+
| 1   | abc123     | send   | {...}   | 1720000001 |
| 2   | abc123     | m_start| {...}   | 1720000002 |
| 3   | abc123     | b_start| {...}   | 1720000003 |
| ...                                              |
+-----+------------+--------+---------+------------+

sessions table
+------------+---------+--------+-----+------+------+-------+
| session_id | summary | branch | cwd | mode | ... | state |
+------------+---------+--------+-----+------+------+-------+
```

Key capabilities:

- **Replay**: `getEventsAfter(sessionId, afterSeq)` replays missed events for reconnection
- **Search**: Full-text search across session summaries and user messages
- **Session metadata**: Tracks tokens, cost, mode, branch, worktree, state, timestamps
- **Attention tracking**: Identifies sessions that need user attention (permissions pending, errors)
- **Prompt counting**: Tracks prompts per session for auto-rename scheduling

## Permission System

The permission handler implements a multi-layer check for every tool invocation:

```
Tool invocation
    |
    v
1. Skill policy check
   (allowed-tools ceiling)
    |
    v
2. Worktree guard
   (write path enforcement)
    |
    v
3. Auto-allow check
   (mode x tier matrix)
    |
    v
4. Session allow-list
   (permanent approvals)
    |
    v
5. User prompt
   (WS + push notification)
    |
    v
Decision: allow / deny
```

### Tool Tiers

Every tool is classified into a risk tier:

| Tier       | Examples         | Ask    | Agent  | Auto   |
| ---------- | ---------------- | ------ | ------ | ------ |
| `safe`     | Read, Glob, Grep | allow  | allow  | allow  |
| `standard` | Edit, Write      | prompt | allow  | allow  |
| `elevated` | Bash             | prompt | allow  | allow  |
| `unknown`  | MCP tools        | prompt | prompt | prompt |

Tiers can be overridden per-tool in `.mitzo.json` via `toolTierOverrides`.

### Worktree Guard

When worktree isolation is enabled, `checkWorktreePolicy()` inspects Write, Edit, and Bash tool inputs. If the target path falls outside the session's worktree directories, the tool call is denied with a redirect message (the agent self-corrects). Read operations are unrestricted.

## Skill System

Skills are reusable prompt packages invoked via `/slash-command` in chat.

```
Discovery pipeline:
  1. Native commands (TypeScript)    -> highest precedence
  2. Repo-local (.mitzo/skills/)     -> per-project
  3. User (~/.mitzo/skills/)         -> global
  4. Bundled (./skills/)             -> fallback
```

Each skill is a markdown file with YAML frontmatter. The frontmatter can declare `allowed-tools` which acts as a ceiling on tool permissions during the skill's execution (never expands permissions, only restricts).

See [docs/skills.md](skills.md) for the full guide.

## Task Board

The task board provides multi-session goal decomposition and autonomous execution.

```
Goal (root task)
    |
    +-- Subtask 1 (pending)
    +-- Subtask 2 (active -> assigned to session)
    |       |
    |       +-- Sub-subtask 2a (done)
    |       +-- Sub-subtask 2b (pending)
    +-- Subtask 3 (pending)
```

**Orchestration flow:**

1. User creates a goal via the UI
2. `startLoop()` assigns the goal to a session
3. The agent decomposes the goal into subtasks via `TaskSet`
4. In spec mode, decomposition pauses for human approval
5. The orchestrator picks tasks in DFS order, one at a time
6. Each task is assigned to a session, executed, and marked complete
7. Status cascades up the tree (failed child -> failed parent)

The task store uses SQLite (`.mitzo/tasks.db`) with WAL mode. The orchestrator is a stateless tick-based state machine -- it re-reads from SQLite on every tick, making it resilient to crashes.

See [docs/task-board.md](task-board.md) for the full guide.

## Observability

### Logging

Pino structured JSON logger with three transport targets:

| Target      | Purpose                             | Configuration           |
| ----------- | ----------------------------------- | ----------------------- |
| `pino-roll` | Daily-rotated JSON files in `logs/` | Always active           |
| stdout      | JSON (or `pino-pretty` in dev)      | Always active           |
| `pino-loki` | Pushes to Grafana Loki              | When `LOKI_HOST` is set |

Every log line includes `module`, `msg`, `level`, `time`. When an OTel span is active, `trace_id` and `span_id` are injected via the Pino mixin for log-to-trace correlation.

### Tracing

OpenTelemetry via `BatchSpanProcessor` with OTLP HTTP exporter to Jaeger. Opt-in when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

Instrumented operations: `ws.switch_session`, `ws.send`, `ws.reconnect`.

### Infrastructure

Four containers via `docker-compose.yml` (podman):

| Service | Port                    | Purpose                                     |
| ------- | ----------------------- | ------------------------------------------- |
| Jaeger  | 16686 (UI), 4318 (OTLP) | Distributed trace viewer                    |
| Grafana | 3002                    | Log viewer + dashboards (no login required) |
| Loki    | 3200                    | Log aggregation backend                     |
| MLflow  | 5050                    | Experiment tracking                         |

## Reasoning Harness

Mitzo includes two multi-model reasoning orchestrators for complex decision-making:

### Deliberation

Multiple agents with defined roles engage in structured debate rounds. Each role has a model assignment. A judge evaluates arguments and declares a winner.

```
Role A (model-1) --+
                   |
Role B (model-2) --+--> Judge --> Winner + Transcript
                   |
Role C (model-3) --+
```

### Fusion

A panel of models independently responds to a prompt. A judge model synthesizes the responses into a single output, analyzing agreement and disagreement.

```
Panel Member 1 --+
Panel Member 2 --+--> Judge --> Synthesized Output
Panel Member 3 --+
```

Both orchestrators are configurable via agent definitions and can be loaded from YAML configs.

## Transport Layer

Mitzo supports two transport mechanisms for the v2 protocol:

### WebSocket (Primary)

Single multiplexed WebSocket per client. All sessions share one connection. Messages carry explicit `sessionId` for demuxing. The `ConnectionRegistry` manages watch subscriptions and broadcasts.

### SSE + REST (Fallback)

For environments where WebSocket is unavailable:

- `GET /api/chat/events` opens a Server-Sent Events stream
- Client receives a `welcome` event with a `connectionId`
- Subsequent interactions use POST endpoints (`/api/chat/send`, `/api/chat/stop`, etc.) with `X-Connection-ID` header
- Same v2 protocol semantics, different transport

## Design Decisions

### SDK as the Engine

Mitzo uses the Anthropic Agent SDK's `query()` function directly rather than implementing its own conversation loop. This means Claude sessions in Mitzo have identical capabilities to the Claude Code CLI -- same tools, same MCP support, same hook system. The SDK is the single source of truth for tool definitions and execution.

### Single Multiplexed WebSocket

v2 of the protocol moved from per-session WebSocket connections to a single multiplexed connection per client. Every message carries a `sessionId`. This eliminates connection storms when switching sessions, simplifies reconnection (one reconnect, all sessions resume), and matches how mobile browsers actually work (one WS is more reliable than many).

### Event Store for Replay, Not Cache

The event store is the canonical record of session events, not a cache. Reconnection replays from the store, not from in-memory buffers. This makes crash recovery straightforward -- restart the server, sessions pick up where they left off.

### SQLite for Persistence

Both the event store and task store use SQLite with WAL mode. This provides crash-safe persistence, concurrent read access, and zero-config deployment. WAL mode allows reads during writes without blocking.

### Worktree Isolation by Default

Every session gets its own git worktree on a dedicated branch. This prevents cross-session contamination -- two concurrent sessions can't step on each other's changes. The guard is enforced at the tool level (not advisory), so the agent can't accidentally write outside its sandbox.

### Mobile-First, Desktop-Capable

The UI is designed for phone-sized screens first. Desktop gets a side-by-side layout with chat + file viewer, but the phone experience is the primary design target. Touch interactions, swipe gestures, and push notifications are first-class features.

### Stateless Orchestrator

The task orchestrator (`TaskOrchestrator`) is deliberately stateless. Every `tick()` re-reads the full task tree from SQLite. This makes it resilient to crashes (no in-memory state to lose) and simplifies reasoning about behavior (the current state is always what's in the database).

### Provider-Agnostic Core

The `@mitzo/harness` package includes a `ModelProvider` abstraction that supports Anthropic (via Vertex) and Google (Gemini) models. The reasoning orchestrators use this abstraction, allowing deliberation and fusion across different model providers.
