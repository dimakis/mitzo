# API Reference

Complete REST API and WebSocket protocol reference for the Mitzo server. Default endpoint: `https://localhost:3100`.

All endpoints require authentication via session cookie unless otherwise noted. Login via `POST /api/auth/login` to obtain a cookie.

## Authentication

### POST /api/auth/login

Login with passphrase.

**Request:**

```json
{ "passphrase": "your-passphrase" }
```

**Response:**

```json
{ "ok": true, "token": "jwt-token-string" }
```

Sets `HttpOnly` cookie for subsequent requests.

### POST /api/auth/logout

Clear authentication cookie.

**Response:** `{ "ok": true }`

### GET /api/auth/check

Verify current authentication status.

**Response:** `{ "ok": true }` or `401 Unauthorized`

## Sessions

### POST /api/sessions

Create a new session with optional worktree isolation. Used by external hooks (Claude Code, Cursor) to get worktree paths.

**Auth:** Internal token (`X-Internal-Token` header)

**Request:**

```json
{
  "source": "claude-code",
  "initialPrompt": "Fix the login bug",
  "summary": "Session summary",
  "mode": "agent",
  "model": "claude-opus-4"
}
```

| Field           | Type     | Required | Description                                                |
| --------------- | -------- | -------- | ---------------------------------------------------------- |
| `source`        | `string` | Yes      | Source identifier (e.g., `claude-code`, `cursor`, `mitzo`) |
| `initialPrompt` | `string` | No       | Initial prompt for the session                             |
| `summary`       | `string` | No       | Session summary/title                                      |
| `mode`          | `string` | No       | Permission mode: `ask`, `agent`, `auto`                    |
| `model`         | `string` | No       | Model override                                             |

**Response:**

```json
{
  "sessionId": "2026-07-01-abc123",
  "worktrees": {
    "primary": "/path/to/repo/.claude/worktrees/2026-07-01-abc123",
    "sibling": "/path/to/sibling/.claude/worktrees/2026-07-01-abc123"
  },
  "isolation": true
}
```

### GET /api/sessions

List sessions with pagination.

**Query parameters:**

| Parameter | Type      | Default | Description             |
| --------- | --------- | ------- | ----------------------- |
| `offset`  | `number`  | `0`     | Pagination offset       |
| `limit`   | `number`  | `20`    | Page size               |
| `full`    | `boolean` | `false` | Include filesystem scan |

**Response:**

```json
{
  "sessions": [
    {
      "id": "abc123",
      "summary": "Fix login bug",
      "lastModified": 1720000000,
      "isActive": true,
      "totalTokens": 15000,
      "numTurns": 5
    }
  ],
  "hasMore": true
}
```

### GET /api/sessions/:id/messages

Get all messages for a session.

**Response:** Array of `FinishedMessage` objects.

### GET /api/sessions/:id/meta

Get session metadata including token usage, branch, working directory, and mode.

**Response:**

```json
{
  "sessionId": "abc123",
  "summary": "Fix login bug",
  "branch": "session/abc123",
  "cwd": "/path/to/worktree",
  "mode": "agent",
  "state": "ACTIVE",
  "inputTokens": 10000,
  "outputTokens": 5000,
  "cacheReadTokens": 3000,
  "cacheCreationTokens": 1000,
  "costUsd": 0.45,
  "promptCount": 5,
  "createdAt": 1720000000,
  "updatedAt": 1720001000
}
```

### GET /api/sessions/:id/events

Get events since a sequence number (for reconnection replay).

**Query parameters:**

| Parameter | Type     | Description                    |
| --------- | -------- | ------------------------------ |
| `after`   | `number` | Sequence number to resume from |

**Response:** Array of stored events with sequence numbers.

### GET /api/sessions/active

Get currently active (attached) sessions.

### GET /api/sessions/search

Search sessions by query string.

**Query parameters:**

| Parameter | Type     | Default  | Description  |
| --------- | -------- | -------- | ------------ |
| `q`       | `string` | required | Search query |
| `limit`   | `number` | `50`     | Max results  |

### DELETE /api/sessions/:id

Hide/delete a session from the list.

### DELETE /api/sessions

Hide all sessions.

### PUT /api/sessions/:id/rename

Rename a session.

**Request:** `{ "title": "New name" }`

### POST /api/sessions/suspend

Suspend sessions (used by iOS background handler via `sendBeacon()`).

**Request:**

```json
{
  "connectionId": "conn-123",
  "sessions": [{ "sessionId": "abc123", "lastSeq": 42 }]
}
```

**Response:** `204 No Content`

## Chat (REST Alternative)

HTTP alternative to the WebSocket protocol. All endpoints require the `X-Connection-ID` header obtained from the SSE welcome event.

### GET /api/chat/events

Open a Server-Sent Events stream. Returns a `welcome` event containing the `connectionId`.

**SSE Events:**

```
event: welcome
data: {"connectionId": "conn-abc123"}

event: message
data: {"v": 2, "type": "block_start", ...}
```

### POST /api/chat/send

Send a chat message. Same payload as the WebSocket `send` message.

### POST /api/chat/interrupt

Interrupt the current query with a follow-up message.

### POST /api/chat/stop

Stop the current query.

### POST /api/chat/permission

Respond to a permission request.

### POST /api/chat/mode

Set chat mode (`ask`, `agent`, `auto`).

### POST /api/chat/watch

Subscribe to session events.

### POST /api/chat/unwatch

Unsubscribe from session events.

### POST /api/chat/switch

Switch active session.

### POST /api/chat/suspend

Suspend session.

### POST /api/chat/close

Close session.

### POST /api/chat/reconnect

Reconnect to sessions with event replay.

## Configuration

### GET /api/config

Get server configuration including repo path, MCP servers, quick actions, and context blocks.

**Response:**

```json
{
  "repoPath": "/path/to/repo",
  "mcpServers": ["jira", "gitlab"],
  "quickActions": [
    {
      "label": "Run Tests",
      "desc": "Full suite",
      "prompt": "Run tests and report."
    }
  ],
  "contextBlocks": {
    "Architecture": { "title": "Architecture", "path": "/path/to/arch.md" }
  },
  "fileViewerRoots": [{ "label": "Main", "path": "/path/to/repo" }]
}
```

### GET /api/models

Get available LLM models.

### GET /api/version

Get server build info.

**Response:**

```json
{
  "hash": "abc1234",
  "commit": "feat: add dark mode",
  "updateAvailable": false
}
```

### POST /api/version/check

Check for available updates by comparing local and remote git commits.

### GET /api/service-health

Get health status of dependent services (Yapper, ContexGin).

**Response:**

```json
{
  "services": [
    { "name": "yapper", "ok": true, "detail": "healthy" },
    { "name": "contexgin", "ok": false, "detail": "connection refused" }
  ],
  "checkedAt": 1720000000
}
```

## Skills

### GET /api/skills

Get available skills (merged from all scopes with collision info).

**Query parameters:**

| Parameter | Type     | Description                                       |
| --------- | -------- | ------------------------------------------------- |
| `cwd`     | `string` | Working directory for repo-scoped skill discovery |

**Response:** Array of skill definitions with name, description, source scope, and collision metadata.

## Files

### GET /api/files/roots

Get configured file browser roots.

**Response:**

```json
[
  { "label": "Main", "path": "/path/to/repo" },
  { "label": "Tooling", "path": "/path/to/tools" }
]
```

### GET /api/files/list

List directory contents.

**Query parameters:**

| Parameter | Type     | Description                |
| --------- | -------- | -------------------------- |
| `root`    | `string` | Root path                  |
| `dir`     | `string` | Directory relative to root |

**Response:**

```json
{
  "currentDir": "/path/to/repo/src",
  "entries": [
    { "name": "index.ts", "isDir": false },
    { "name": "components", "isDir": true }
  ]
}
```

### GET /api/files/read

Read file contents.

**Query parameters:**

| Parameter | Type     | Description        |
| --------- | -------- | ------------------ |
| `path`    | `string` | Absolute file path |

**Response:**

```json
{
  "path": "/path/to/file.ts",
  "content": "const x = 1;\n...",
  "ext": "ts"
}
```

### GET /api/files/download

Download file as binary attachment.

### PUT /api/files/write

Write file contents.

**Request:**

```json
{
  "path": "/path/to/file.ts",
  "content": "const x = 2;\n...",
  "createIfMissing": true
}
```

**Response:** `{ "ok": true }`

### GET /api/images/:imageId

Get a tool result image by ID. Returns binary image data with appropriate Content-Type header.

## Git

### GET /api/git/info

Get current branch and worktree information.

**Response:**

```json
{
  "branch": "main",
  "worktrees": [
    {
      "id": "session-abc123",
      "branch": "session/abc123",
      "repo": "primary",
      "path": "/path/to/worktree"
    }
  ]
}
```

### GET /api/worktrees

List all git worktrees.

## Task Board

### GET /api/tasks

Get all tasks as a tree.

**Response:** `{ "tasks": [...] }`

### POST /api/tasks

Create a task.

**Request:**

```json
{
  "title": "Add dark mode support",
  "parentId": "goal-123",
  "description": "Implement theme switching",
  "priority": 1,
  "sessionPolicy": "reuse",
  "stageType": "agent",
  "maxRetries": 3
}
```

| Field           | Type     | Required | Description                              |
| --------------- | -------- | -------- | ---------------------------------------- |
| `title`         | `string` | Yes      | Task title                               |
| `parentId`      | `string` | No       | Parent task ID (for subtasks)            |
| `description`   | `string` | No       | Task description                         |
| `priority`      | `number` | No       | Priority (lower = higher priority)       |
| `sessionPolicy` | `string` | No       | `reuse` (Phase 2 only)                   |
| `stageType`     | `string` | No       | Stage type: `agent`, `wait_for_signal`   |
| `gateConfig`    | `object` | No       | Gate configuration for signal stages     |
| `maxRetries`    | `number` | No       | Max retry attempts on failure            |
| `templateId`    | `string` | No       | Template this task was instantiated from |

### GET /api/tasks/:id

Get a specific task.

### PATCH /api/tasks/:id

Update a task.

### DELETE /api/tasks/:id

Delete a task.

### POST /api/tasks/:id/approve

Approve a task in `pending_review` status.

### POST /api/tasks/:id/reject

Reject a task. Optional `feedback` in body.

### POST /api/tasks/:id/signal

Send a signal to a `wait_for_signal` stage task.

**Request:**

```json
{
  "status": "success",
  "artifacts": { "pr_url": "https://github.com/..." }
}
```

## Loop Orchestration

### GET /api/loop/status

Get orchestration loop status.

**Response:**

```json
{
  "state": "running",
  "goalId": "goal-123",
  "activeTaskId": "task-456",
  "progress": { "done": 3, "total": 5 },
  "specMode": false,
  "awaitingApproval": false
}
```

### POST /api/loop/start

Start the orchestration loop.

**Request:**

```json
{
  "goalId": "goal-123",
  "specMode": true
}
```

### POST /api/loop/pause

Pause execution.

### POST /api/loop/resume

Resume execution.

### POST /api/loop/stop

Stop the loop.

### POST /api/loop/spec/approve

Approve spec-mode decomposition.

### POST /api/loop/spec/reject

Reject spec-mode decomposition (re-plan).

## Workflows and Templates

### GET /api/templates

List available workflow templates.

### GET /api/templates/:id

Get a specific template.

### POST /api/templates

Create a workflow template.

**Request:**

```json
{
  "name": "PR Review Pipeline",
  "description": "Standard PR review workflow",
  "stages": [
    { "title": "Run tests", "stageType": "agent" },
    { "title": "Wait for CI", "stageType": "wait_for_signal", "gateConfig": { "type": "gh_ci" } },
    { "title": "Review", "stageType": "agent" }
  ]
}
```

### DELETE /api/templates/:id

Delete a template.

### POST /api/workflows/instantiate

Instantiate a template as a goal.

**Request:**

```json
{
  "templateId": "tmpl-123",
  "title": "Review PR #42",
  "variables": { "pr_number": 42 }
}
```

**Response:** `{ "task": {...} }`

## Signals

### POST /api/signals/resolve

Resolve a signal by gate metadata (for external agents like Centaur).

**Auth:** Internal token

**Request:**

```json
{
  "type": "gh_ci",
  "repo": "dimakis/mitzo",
  "pr": 42,
  "status": "success",
  "artifacts": { "run_url": "https://..." }
}
```

**Response:** `{ "ok": true, "matched": ["task-456"] }`

Signal types: `gh_ci`, `gh_review`, `centaur_review`, `human_approval`.

## Inbox

### GET /api/inbox

List inbox items.

### POST /api/inbox

Create an inbox item.

**Request:**

```json
{
  "source": "troubadour",
  "title": "Cross-spoke connection found",
  "body": "Found a connection between...",
  "tags": ["proposal"]
}
```

### GET /api/inbox/:filename

Get inbox item content.

### POST /api/inbox/:filename/approve

Approve an inbox item.

### DELETE /api/inbox/:filename

Delete an inbox item.

## Calendar

### GET /api/calendar

Get calendar events and sprint information.

**Query parameters:**

| Parameter | Type     | Default | Description             |
| --------- | -------- | ------- | ----------------------- |
| `date`    | `string` | today   | Start date (YYYY-MM-DD) |
| `days`    | `number` | `7`     | Number of days (1-31)   |

**Response:**

```json
{
  "startDate": "2026-07-01",
  "endDate": "2026-07-07",
  "events": [...],
  "sprints": [...]
}
```

## Todos

### GET /api/todos

Get todo items (Telos integration).

**Query parameters:**

| Parameter | Type      | Description               |
| --------- | --------- | ------------------------- |
| `profile` | `string`  | Filter by profile         |
| `refresh` | `boolean` | Force refresh from source |

### POST /api/todos

Create a todo item.

**Request:**

```json
{
  "summary": "Implement dark mode",
  "profile": "work",
  "parentId": "parent-id"
}
```

### POST /api/todos/:id/action

Perform an action on a todo.

**Request:**

```json
{
  "action": "done",
  "days": 7
}
```

Actions: `done`, `snooze`, `archive`, `delete`.

## Workload

### GET /api/workload/items

List workload items.

**Query parameters:**

| Parameter | Type      | Description          |
| --------- | --------- | -------------------- |
| `profile` | `string`  | Filter by profile    |
| `status`  | `string`  | Filter by status     |
| `starred` | `boolean` | Filter starred items |

### GET /api/workload/items/:id

Get a specific workload item.

### PATCH /api/workload/items/:id

Update a workload item.

### DELETE /api/workload/items/:id

Delete a workload item.

### POST /api/workload/items/:id/promote

Promote a workload item to a task board task.

### POST /api/workload/signals

Ingest a workload signal.

### POST /api/workload/signals/batch

Batch ingest workload signals.

## Push Notifications

### POST /api/push/register

Register a device token for APNs push notifications.

**Request:** `{ "token": "device-token-string" }`

### DELETE /api/push/register

Unregister a device token.

### POST /api/push/notification-action

Handle iOS notification actions.

**Request:**

```json
{
  "sessionId": "abc123",
  "actionId": "VIEW_ACTION",
  "userText": "optional reply text"
}
```

Action IDs: `VIEW_ACTION`, `LATER_ACTION`, `REPLY_ACTION`.

## Events (SSE)

### GET /api/events

Server-Sent Events stream for live updates. Used by the frontend for real-time session activity, health status, and task state changes.

**Event types:**

| Event                    | Description                     |
| ------------------------ | ------------------------------- |
| `connected`              | Connection established          |
| `session_activity`       | Session overview snapshot       |
| `health`                 | Service health update           |
| `sessions_changed`       | Session list changed            |
| `task_state`             | Full task tree update           |
| `task_updated`           | Single task update              |
| `task_deleted`           | Task deletion                   |
| `workload_item_created`  | Workload item created           |
| `workload_item_updated`  | Workload item updated           |
| `workload_batch_updated` | Multiple workload items updated |

## Permission (No-Auth Fallback)

### POST /api/permission/:permId/respond

Respond to a permission request via direct URL (used by ntfy notification deep links).

**Query parameters:**

| Parameter  | Type     | Description                    |
| ---------- | -------- | ------------------------------ |
| `token`    | `string` | ntfy auth token                |
| `decision` | `string` | Decision (can also be in body) |

Decisions: `once`, `always`, `deny`.

## Internal Endpoints

These endpoints require the internal token (`X-Internal-Token` header) and are used by the task board MCP server and external hooks.

### POST /api/internal/task-tools/set

Set task children (agent decomposition).

### POST /api/internal/task-tools/complete

Mark current task complete.

### GET /api/internal/task-tools/status

Get current task status.

### POST /api/internal/task-tools/block

Block current task with a reason.

### POST /api/internal/task-tools/artifact

Add an artifact to the current task.

### GET /api/repos

List configured repos.

### POST /api/repos/open

Open a repo session with worktree allocation.

## Common Error Shape

All error responses follow the same shape:

```json
{
  "error": "Human-readable error message"
}
```

HTTP status codes follow standard conventions: `400` for bad requests, `401` for unauthorized, `404` for not found, `500` for server errors.
