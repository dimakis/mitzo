# Task Board Phase 1 — Implementation Plan

## Context

Mitzo's Global Task Board elevates it from a session launcher into an orchestration layer. Phase 1 is the foundation: persistent task board with manual CRUD, tree view UI, and real-time WS updates. No orchestrator, no agent tools, no auto-assignment — just the data layer, REST API, and frontend.

Design doc: `~/redhat/mgmt/architecture/discussions/mitzo/global-task-board.md`

## Key Decisions

| Decision      | Choice                                    | Rationale                                                |
| ------------- | ----------------------------------------- | -------------------------------------------------------- |
| DB location   | `${REPO_PATH}/.mitzo/tasks.db`            | Follows `events.db` pattern, separate lifecycle          |
| ID generation | `crypto.randomUUID()`                     | Built-in, no deps                                        |
| WS strategy   | Reuse `/ws/chat` with `"global"` pool key | Avoids new endpoint; filter by `task_*` event types      |
| Mutations     | REST-only (POST/PATCH/DELETE)             | Simpler than WS input handlers; broadcast after mutation |
| Route         | `/tasks` frontend, `/api/tasks` REST      | Matches existing `/todos` → `/api/todos` pattern         |
| State updates | Server-authoritative via WS               | WS events replace local state, no optimistic merges      |

## Build Order (9 steps, 1 commit each)

### Step 1: `server/task-store.ts` — SQLite Store

**New files:** `server/task-store.ts`, `server/__tests__/task-store.test.ts`

Class `TaskStore` following `EventStore` pattern:

- Constructor: `dbPath`, WAL mode, `PRAGMA foreign_keys=ON`, schema init, migrations
- `create(input)` → Task (auto-depth from parent, `randomUUID()` for ID)
- `get(id)` → Task | null
- `update(id, fields)` → Task | null (sets `completedAt` on terminal statuses)
- `delete(id)` → boolean (CASCADE to children)
- `listRoots()` → Task[] (parent_id IS NULL, ordered by priority, created_at)
- `getChildren(parentId)` → Task[]
- `getTree()` → Task[] (flat fetch, in-memory tree assembly via Map)
- `getSubtree(rootId)` → Task[]

Schema from design doc §3.1. `annotations` stored as JSON string, parsed in row mapper.

**Tests (15):** CRUD operations, depth calculation, cascade delete, tree assembly, terminal status sets completedAt, nonexistent ID handling.

**Reference:** `server/event-store.ts` for SQLite patterns.

### Step 2: REST Endpoints — `server/app.ts` + `server/api-schemas.ts`

**Modified files:** `server/app.ts`, `server/api-schemas.ts`
**New test file:** `server/__tests__/task-routes.test.ts`

Add Zod schemas: `TaskCreateBody`, `TaskUpdateBody`

REST routes:

```
GET    /api/tasks       → getTree()           → 200 { tasks }
POST   /api/tasks       → create(body)        → 201 { task }
GET    /api/tasks/:id   → get(id)             → 200 { task } | 404
PATCH  /api/tasks/:id   → update(id, body)    → 200 { task } | 404
DELETE /api/tasks/:id   → delete(id)          → 200 { ok } | 404
```

Add `setTaskBroadcast(fn)` callback (same pattern as `setInboxBroadcast`). Mutations call broadcast after success.

**Tests (10):** Happy path CRUD, validation errors, 404s, auth required.

**Reference:** `server/app.ts` for route mounting, broadcast callback pattern.

### Step 3: WS Broadcast — `server/index.ts`

**Modified file:** `server/index.ts`

Wire `setTaskBroadcast` to broadcast to all connected WS clients.

Event types (server → client, v2 format):

- `task_state` — full tree hydration on connect
- `task_updated` — single task delta (create or update)
- `task_deleted` — removal by ID

Send `task_state` hydration after `client_id` on new WS connections.

**Tests (3-4):** Broadcast wiring, hydration on connect.

**Reference:** `server/index.ts` for existing broadcast patterns.

### Step 4: Frontend Types — `frontend/src/types/task.ts`

**New file:** `frontend/src/types/task.ts`
**Modified file:** `frontend/src/types/ws-messages.ts` (add task events to union)

Type definitions for `Task`, `TaskStatus`, `SessionPolicy`, and WS message types.

### Step 5: `useTaskBoard` Hook

**New files:** `frontend/src/hooks/useTaskBoard.ts`, `frontend/src/hooks/__tests__/useTaskBoard.test.ts`

Returns: `{ loading, tasks, createTask, updateTask, deleteTask, skipTask, refresh }`

- Hydrates from `GET /api/tasks` on mount
- Subscribes to WS pool key `"global"` for live updates
- `task_state` → replace tree; `task_updated` → upsert in tree; `task_deleted` → remove from tree
- Mutations call REST, rely on WS broadcast for state sync

**Tests (10):** Fetch, mutations, WS event handling, refresh.

**Reference:** `frontend/src/hooks/useTodoData.ts` for pattern.

### Step 6: `TaskNode` Component

**New files:** `frontend/src/components/TaskNode.tsx`, `frontend/src/components/__tests__/TaskNode.test.tsx`

Props: `task`, `depth`, `onStatusChange`, `onDelete`, `onAddChild`

Renders: status icon (color-coded), title, expand/collapse chevron, recursive children. Depth indentation via left padding or border colors (mobile-friendly).

**Tests (7):** Renders title, status icons, expand/collapse, depth indentation, recursive children.

**Reference:** `frontend/src/components/TodoCard.tsx` for hierarchical rendering.

### Step 7: `TaskCreateForm` Component

**New files:** `frontend/src/components/TaskCreateForm.tsx`, `frontend/src/components/__tests__/TaskCreateForm.test.tsx`

Props: `parentId?`, `onCreate`, `onCancel`

Inline form: auto-focused input + Add/Cancel buttons. Escape cancels. Placeholder varies by root vs child.

**Tests (6):** Render, submit, disabled state, escape, cancel.

### Step 8: `TaskBoard` Page

**New files:** `frontend/src/pages/TaskBoard.tsx`, `frontend/src/pages/__tests__/TaskBoard.test.tsx`

Structure: header (back, title + count, add, refresh) → create form (conditional) → task list → empty state.

Uses `useTaskBoard()` hook.

**Tests (5):** Loading, empty, list rendering, add button, refresh.

**Reference:** `frontend/src/pages/TodoView.tsx` for page structure.

### Step 9: Route + Styles

**Modified files:** `frontend/src/App.tsx`, `frontend/src/styles/global.css`

Add `/tasks` route with `ProtectedRoute` wrapper. Add CSS classes following BEM-like convention (`.task-board-*`, `.task-node-*`, `.task-create-*`).

## Commit Strategy

Branch: `feat/task-board-phase1`

1. `feat(server): add TaskStore with SQLite persistence`
2. `feat(server): add task board REST endpoints`
3. `feat(server): broadcast task events via WebSocket`
4. `feat(frontend): add task board types and WS messages`
5. `feat(frontend): add useTaskBoard hook with REST + WS`
6. `feat(frontend): add TaskNode tree component`
7. `feat(frontend): add TaskCreateForm inline component`
8. `feat(frontend): add TaskBoard page`
9. `feat(frontend): integrate task board route and styles`

## Critical Reference Files

- `server/event-store.ts` — SQLite store class pattern
- `server/app.ts` — route mounting, broadcast callbacks
- `server/index.ts` — WS setup, hydration, broadcast wiring
- `frontend/src/hooks/useTodoData.ts` — REST data hook pattern
- `frontend/src/components/TodoCard.tsx` — hierarchical component pattern
- `frontend/src/pages/TodoView.tsx` — page layout pattern
- `frontend/src/lib/ws-pool.ts` — WS connection pooling

## Verification

1. `npm test` passes after every commit
2. `npm run lint` and `npm run typecheck` pass
3. Manual: create root task, create child task, skip task, delete task
4. Manual: open two browser tabs, verify WS sync (create in one, appears in other)
5. Manual: refresh page, verify tasks persist from SQLite

## Gotchas

- `PRAGMA foreign_keys = ON` must be set at connection time for CASCADE to work
- WS pool `"global"` key needs to connect to `/ws/chat` — the handler sends `client_id` and task hydration; hook ignores non-task messages
- `annotations` is JSON string in DB, `string[]` in TypeScript — parse/serialize in row mapper
- Tree assembly is in-memory (fine for Phase 1 scale of tens of tasks)
