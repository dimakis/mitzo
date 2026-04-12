# Global Task Board — Design Document

> **Status:** Draft — under review
> **Author:** Dimitri + Claude
> **Date:** 2026-04-10

## 1. Vision

The Global Task Board elevates Mitzo from a session launcher into an **orchestration layer**. Instead of "start a chat, give it a job," users drop goals onto a persistent board. Mitzo decomposes them, assigns sessions, loops through tasks, and reports progress — while the user steers.

Sessions become **workers**. The task board becomes the **home screen**. The user becomes a **director**.

This is Mitzo's defining feature: recursive, multi-session, user-directed autonomous work.

---

## 2. Core Concepts

### 2.1 Task

A unit of work with:

| Field               | Type              | Description                                                                              |
| ------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `id`                | uuid              | Unique identifier                                                                        |
| `parent_id`         | uuid \| null      | Parent task (null = root/goal)                                                           |
| `title`             | string            | Short description                                                                        |
| `description`       | string \| null    | Detailed context, constraints, acceptance criteria                                       |
| `status`            | enum              | `pending` · `active` · `done` · `pending_review` · `blocked` · `skipped` · `failed`      |
| `session_id`        | string \| null    | Assigned worker session (null = unassigned)                                              |
| `session_policy`    | enum              | `reuse` · `spawn` · `auto` (see §4.3)                                                    |
| `priority`          | number            | Sort order within siblings (lower = first)                                               |
| `depth`             | number            | Nesting level (0 = root goal)                                                            |
| `annotations`       | string[]          | User-added context/constraints (see §5.2)                                                |
| `summary`           | string \| null    | Completion summary — produced when task finishes, fed to siblings as context (see §8.3)  |
| `token_usage`       | number            | Cumulative tokens consumed by this task (incremented on each tool call, displayed in UI) |
| `requires_approval` | boolean           | If true, task stays in `pending_review` until user approves (see §4.6)                   |
| `claimed_by`        | string \| null    | Session that holds the mutation lock (Phase 3, see §4.7)                                 |
| `claimed_at`        | timestamp \| null | When the lock was acquired                                                               |
| `created_at`        | timestamp         |                                                                                          |
| `updated_at`        | timestamp         |                                                                                          |
| `completed_at`      | timestamp \| null |                                                                                          |

### 2.2 Goal

A root task (parent_id = null). Goals are the top-level entries on the board. A goal might be "Refactor the auth module" or "Add dark mode to the frontend." Goals decompose into tasks.

### 2.3 Task Tree

Tasks form a tree. Any task can have children (true recursion). Depth is unbounded by default, with an optional configurable max-depth guard.

**Status transition diagram:**

```
                ┌──────────────┐
                │   pending    │
                └──────┬───────┘
                       │ assigned
                       ▼
                ┌──────────────┐
         ┌──────│    active    │──────┐
         │      └──────┬───────┘      │
         │             │              │
    blocked by    completes      user stops
    TaskBlock()   TaskComplete()
         │             │              │
         ▼             ▼              ▼
  ┌────────────┐ ┌────────────┐ ┌──────────┐
  │  blocked   │ │  pending   │ │  failed  │
  └─────┬──────┘ │  _review   │ └──────────┘
        │        └─────┬──────┘
   unblocked      ┌────┴────┐
        │      approve    reject
        │         │         │
        ▼         ▼         ▼
     pending    done     active
                        (+ rejection
                         annotation)

  Any state → skipped (user skip)
```

**Valid transitions:**

| From             | To               | Trigger                                                |
| ---------------- | ---------------- | ------------------------------------------------------ |
| `pending`        | `active`         | Orchestrator assigns to session                        |
| `active`         | `pending_review` | Agent calls `TaskComplete` (when `requires_approval`)  |
| `active`         | `done`           | Agent calls `TaskComplete` (when `!requires_approval`) |
| `active`         | `blocked`        | Agent calls `TaskBlock`                                |
| `active`         | `failed`         | User stops task, or session crashes                    |
| `pending_review` | `done`           | User approves                                          |
| `pending_review` | `active`         | User rejects (with feedback)                           |
| `blocked`        | `pending`        | User unblocks (returns to queue)                       |
| `*`              | `skipped`        | User skips                                             |

**Status cascade rules** — a parent's status is derived from its children:

```
if any child is `failed`         → parent is `failed`
if any child is `blocked`        → parent is `blocked`
if any child is `active`         → parent is `active`
if any child is `pending_review` → parent is `pending_review`
if all children are `done` or `skipped` → parent is `done`
otherwise                        → parent is `pending`
```

These rules bubble up recursively. A goal's status always reflects the worst-case child. `skipped` tasks are treated as resolved — they don't block parent completion, but `failed` tasks do.

### 2.4 Worker Session

A Claude Code Agent SDK session assigned to work on task(s). A session can:

- Be assigned one task at a time (sequential)
- Complete a task and receive the next automatically
- Create sub-tasks during execution (which land on the global board)
- Be shared across tasks or isolated per-task (configurable)

---

## 3. Data Layer

### 3.1 SQLite Schema

Stored in the existing `.mitzo/events.db` database (or a dedicated `.mitzo/tasks.db` — TBD).

```sql
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','active','done','pending_review','blocked','skipped','failed')),
  session_id      TEXT,
  session_policy  TEXT NOT NULL DEFAULT 'auto'
                  CHECK(session_policy IN ('reuse','spawn','auto')),
  priority        INTEGER NOT NULL DEFAULT 0,
  depth           INTEGER NOT NULL DEFAULT 0
                  CHECK(depth >= 0),
  annotations     TEXT,    -- JSON array of strings
  summary         TEXT,    -- completion summary, fed to siblings as context
  requires_approval INTEGER NOT NULL DEFAULT 0, -- 1 = needs user sign-off
  token_usage     INTEGER NOT NULL DEFAULT 0,   -- cumulative tokens consumed by this task
  claimed_by      TEXT,    -- session holding mutation lock (Phase 3)
  claimed_at      REAL,    -- when lock was acquired
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL,
  completed_at    REAL
);

CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_session ON tasks(session_id);
```

**Note on `depth`:** Redundant with `parent_id` (computable via recursive CTE), but stored for query performance. Enforced on write — `createTask` computes `depth = parent.depth + 1` and the CHECK constraint prevents negative values. If parent_id changes (reparent), depth must be recomputed for the entire subtree.

### 3.2 Persistence Guarantees

- All mutations are synchronous (better-sqlite3), matching EventStore patterns
- Task state changes are atomic — no partial updates
- WAL mode for concurrent read access from multiple sessions
- Task history/audit log: TBD (Phase 3?) — could append to EventStore

### 3.3 Relationship to EventStore

Tasks are **not** events. They're persistent state that lives across sessions. However, task state changes should be emitted as events for:

- WebSocket broadcast to all connected clients
- Session-scoped event replay (so a session can see its task history)

---

## 4. Server Architecture

### 4.1 `server/task-board.ts` — Data Access

The task store. Pure CRUD + tree queries.

```typescript
class TaskBoard {
  // CRUD
  createTask(task: NewTask): Task;
  getTask(id: string): Task | null;
  updateTask(id: string, fields: Partial<Task>): Task;
  deleteTask(id: string): void;

  // Tree queries
  getRoots(): Task[]; // All goals
  getChildren(parentId: string): Task[];
  getSubtree(taskId: string): Task[]; // Full subtree
  getFullBoard(): TaskTree; // Entire board as nested structure

  // Scheduling
  getNextExecutable(options?: {
    strategy: 'dfs' | 'bfs' | 'priority'; // default: 'dfs'
    parentId?: string; // scope to a subtree
    skipBlockedAncestors: boolean; // default: true
  }): Task | null;

  // Status queries
  getBySession(sessionId: string): Task[];
  getOrphaned(): Task[]; // Active tasks with dead sessions
  deriveParentStatus(parentId: string): TaskStatus; // Cascade rules (§2.3)

  // Batch operations
  reorderChildren(parentId: string, orderedIds: string[]): void;
  reparent(taskId: string, newParentId: string): void;
}
```

### 4.2 `server/task-orchestrator.ts` — The Loop Brain

The orchestrator watches the board and drives sessions.

```typescript
class TaskOrchestrator {
  // Lifecycle
  start(): void; // Begin watching the board
  pause(): void; // Pause all orchestration (sessions keep running but no new assignments)
  resume(): void; // Resume orchestration
  stop(): void; // Stop all orchestration + optionally stop sessions

  // Task assignment
  assignNext(sessionId: string): Task | null; // Pick next task for a session
  unassign(taskId: string): void; // Return task to pending
  reassign(taskId: string, sessionId: string): void;

  // Session spawning
  spawnForTask(taskId: string): string; // Create new session, return sessionId

  // Directing (§5)
  interrupt(taskId: string, message: string): void;
  redirect(taskId: string, newDescription: string): void;
  annotate(taskId: string, note: string): void;
  skip(taskId: string): void;
  reprioritize(taskId: string, newPriority: number): void;

  // Health
  reclaimOrphans(): void; // Reassign tasks from dead sessions

  // Events
  on(event: 'task_changed' | 'loop_status', handler): void;
}
```

**Orchestration loop (pseudocode):**

```
while running:
  if paused: wait for resume signal

  for each active session with no active task:
    task = board.getNextExecutable({ strategy: 'dfs' })
    if task:
      assign task to session
      inject sibling summaries as context
      send task context as follow-up prompt

  for each completed task:
    if task.requires_approval:
      set status to pending_review
      notify user
    else:
      set status to done
      generate completion summary → task.summary

    parent = getParent(task)
    parent.status = board.deriveParentStatus(parent.id)  // cascade rules

  reclaim orphaned tasks (sessions that died)

  wait for next state change (event-driven, not polling)
```

**Critical invariant: the orchestrator loop is stateless between iterations.** It re-reads the board from SQLite on every cycle — no cached task state, no in-memory assumptions. This prevents races between the orchestrator and user actions (e.g., user reprioritizes while orchestrator is mid-assignment). Synchronous SQLite writes are the serialization point.

**Scheduling strategies:**

| Strategy        | Behavior                                                      | Best for                                                 |
| --------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `dfs` (default) | Depth-first: finish one branch before starting the next       | Sequential work where later tasks depend on earlier ones |
| `bfs`           | Breadth-first: complete all tasks at depth N before depth N+1 | Parallel exploration, wide decomposition                 |
| `priority`      | Strict priority ordering across all pending leaves            | User-directed prioritization                             |

The default is `dfs` because most task decompositions are sequential — "do A, then B, then C." The user can override per-goal or globally.

### 4.3 Session Policy

Each task can specify how it should be executed:

| Policy  | Behavior                                                                                   |
| ------- | ------------------------------------------------------------------------------------------ |
| `reuse` | Assign to the parent task's session (context carries over)                                 |
| `spawn` | Create a new isolated session (clean context)                                              |
| `auto`  | Orchestrator decides: reuse if context is relevant, spawn if depth is deep or topic shifts |

The `auto` policy is the default. The orchestrator uses a simple heuristic (refined over time):

```
if depth > 2             → spawn (deep tasks need clean context)
else if same parent      → reuse (sibling context is valuable)
else if context_tokens > 80% of window → spawn (context is full)
else                     → reuse
```

This is intentionally conservative. The heuristic can grow smarter in Phase 4, but a predictable default is more important than an optimal one.

### 4.4 Custom Tools

Available in all Agent SDK sessions. Intercepted server-side before reaching the SDK.

| Tool           | Purpose                                           | Tier |
| -------------- | ------------------------------------------------- | ---- |
| `TaskSet`      | Create/replace task list under current task       | safe |
| `TaskUpdate`   | Edit a task (title, description, status)          | safe |
| `TaskComplete` | Mark current task done (requires summary string)  | safe |
| `TaskStatus`   | Read the board (current task, siblings, progress) | safe |
| `TaskBlock`    | Mark current task as blocked with reason          | safe |
| `TaskCreate`   | Add a single new task (child of current or root)  | safe |

**Tool interception flow:**

1. Agent SDK calls tool → `canUseTool` callback fires
2. Server recognizes task tool → handles it internally
3. Returns result to SDK as tool_result
4. Emits `task_updated` delta event over WebSocket (not full board snapshot)

These are NOT prompt-based skills. They're server-intercepted tool calls, similar to how `TodoWrite` works in Claude Code but with persistence and orchestration backing.

### 4.5 Spec Mode — Plan Before Build

Before the orchestrator starts executing a goal, it can run in **spec mode**: the agent proposes a task decomposition, and the user reviews/edits before any work begins.

**Flow:**

1. User adds a goal to the board
2. Orchestrator spawns a session in spec mode (ask-only, no file writes)
3. Agent analyzes the goal and calls `TaskSet` with a proposed tree
4. Tasks land on the board with status `pending` — orchestrator does NOT auto-start
5. User reviews: reorder, annotate, add/remove tasks, adjust session policies
6. User clicks "Start" → orchestrator begins execution

**Why this matters:** Spec mode is "plan before build" for the task board. It prevents the agent from charging ahead with a bad decomposition. The user validates the plan, then runs it — exactly how we already work in conversation, but now externalized and editable.

**Implementation:** Spec mode is a flag on the goal: `spec_mode: boolean`. When true, the orchestrator creates the session with `mode: 'ask'` and waits for user approval before transitioning to execution. Phase 2.

### 4.6 Verification — Trust But Check

Agents will claim tasks are done. Sometimes they're wrong.

**Verification levels (per-task, configurable):**

| Level            | Behavior                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `none` (default) | Agent calls `TaskComplete` → task is done. Trust the agent.                                                     |
| `approval`       | Agent calls `TaskComplete` → status becomes `pending_review` → user reviews and approves/rejects.               |
| `hook`           | On completion, run a validation hook (e.g., `npm test`, `cargo check`). Pass → done. Fail → blocked with error. |

The `requires_approval` field on the task model controls this. Hooks are Phase 3+. For Phase 2, `none` and `approval` are sufficient.

**Rejected tasks:** If a user rejects a `pending_review` task, it goes back to `active` with a rejection annotation explaining what's wrong. The session gets an interrupt with the rejection feedback.

### 4.7 Concurrency Control (Phase 3)

When multiple sessions can run in parallel, task mutations need coordination.

**Optimistic locking via `claimed_by` / `claimed_at`:**

- A session claims a task before mutating it (`claimed_by = sessionId, claimed_at = now`)
- Mutations check `claimed_by` matches — reject if another session holds the lock
- Locks auto-expire after 5 minutes (dead session protection)
- Read operations are always allowed (no lock needed)

This is lightweight — not a distributed lock, just a SQLite column. Sufficient for single-server Mitzo.

### 4.8 Integration Points

| File                  | Change                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| `chat.ts`             | Register session with orchestrator on start; inject task context into system prompt |
| `query-loop.ts`       | Intercept task tool calls; emit task events                                         |
| `session-registry.ts` | Track task assignments per session; notify orchestrator on session death            |
| `index.ts`            | Mount task REST endpoints; handle task WS messages                                  |
| `app.ts`              | New routes: `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, `/api/loop/*` |
| `constants.ts`        | Max depth, orphan timeout, auto-spawn thresholds                                    |
| `tool-tiers.ts`       | Register task tools as safe tier                                                    |

---

## 5. Directing — User Steering Mechanisms

The user is the director. These are their controls.

### 5.1 Interrupt

**What:** Inject guidance into an active task's session mid-execution.
**Example:** "Focus on error handling, skip the refactor part."
**Mechanism:** `orchestrator.interrupt(taskId, message)` → calls `interruptChat()` on the assigned session with the user's message prepended with task context.
**UI:** Tap active task → type message → "Interrupt" button.

### 5.2 Annotate

**What:** Add context or constraints to a pending task before it's picked up.
**Example:** "Use the existing auth helpers, don't create new ones."
**Mechanism:** Appends to `task.annotations[]`. When the orchestrator sends the task to a session, annotations are included in the prompt.
**UI:** Tap pending task → "Add note" → text input.

### 5.3 Redirect

**What:** Stop current approach, reframe the task entirely.
**Example:** "Actually, don't refactor — just add a wrapper."
**Mechanism:** `orchestrator.redirect(taskId, newDescription)` → interrupts session with "STOP current approach" message, updates task description, restarts execution.
**UI:** Tap active task → "Redirect" → edit description → confirm.

### 5.4 Reprioritize

**What:** Reorder pending tasks.
**Example:** Drag task 3 above task 1.
**Mechanism:** `board.reorderChildren(parentId, newOrder)` → orchestrator picks up next task in new order.
**UI:** Drag handle on pending tasks (desktop) or long-press + move (mobile).

### 5.5 Skip

**What:** Skip a task without completing it.
**Mechanism:** Sets status to `skipped`. Orchestrator moves to next. Parent completion ignores skipped children.
**UI:** Swipe-to-skip or tap → "Skip" button.

### 5.6 Manual Assign

**What:** Force a task to a specific session (existing or new).
**Example:** "Give this to the session that already has the auth context."
**Mechanism:** `orchestrator.reassign(taskId, sessionId)` or `orchestrator.spawnForTask(taskId)`.
**UI:** Tap task → "Assign" → session picker or "New session."

### 5.7 Stop

**What:** Abort a task's execution entirely.
**Mechanism:** Marks task as `failed`, stops the session (or just unassigns). Children go to `skipped`.
**UI:** Tap active task → "Stop."

### 5.8 Add Task

**What:** Manually add a task to the board (as root goal or child of existing).
**Mechanism:** `board.createTask(...)`.
**UI:** "+" button on board or on a specific task (to add child).

---

## 6. Protocol

### 6.1 New WebSocket Events

**Server → Client:**

```typescript
// Full board snapshot — hydration only (sent on WS connect and explicit refresh)
// NOT sent on every mutation — that's a scaling problem
{
  type: 'task_state',
  board: TaskTree,           // nested structure
  activeTaskId: string | null,
  loopStatus: 'idle' | 'running' | 'paused'
}

// Delta update — primary event for all task mutations
// This is the workhorse. Frontend applies these incrementally.
{
  type: 'task_updated',
  task: Task,
  change: 'created' | 'status' | 'assigned' | 'annotated' | 'reordered' | 'deleted'
}

// Orchestrator status
{
  type: 'loop_status',
  status: 'idle' | 'running' | 'paused',
  activeTaskId: string | null,
  activeSessionId: string | null,
  progress: { total: number, done: number, active: number, pending: number }
}
```

**Client → Server:**

```typescript
{ type: 'task_interrupt', taskId: string, message: string }
{ type: 'task_annotate', taskId: string, note: string }
{ type: 'task_redirect', taskId: string, description: string }
{ type: 'task_skip', taskId: string }
{ type: 'task_stop', taskId: string }
{ type: 'task_assign', taskId: string, sessionId: string | 'new' }
{ type: 'task_reprioritize', taskId: string, priority: number }
{ type: 'task_create', parentId: string | null, title: string, description?: string }
{ type: 'loop_pause' }
{ type: 'loop_resume' }
{ type: 'loop_stop' }
```

### 6.2 REST Endpoints

Pure REST — no RPC-style endpoints. Annotations are part of the task resource, updated via PATCH.

```
GET    /api/tasks              — Full board (tree structure), hydration endpoint
POST   /api/tasks              — Create task (body: { parentId?, title, description? })
GET    /api/tasks/:id          — Single task with children
PATCH  /api/tasks/:id          — Update any task fields (status, description, annotations, priority, session_policy, requires_approval)
DELETE /api/tasks/:id          — Delete task (cascades to children)

GET    /api/loop/status        — Orchestrator status + progress counts
POST   /api/loop/start         — Start orchestration
POST   /api/loop/pause         — Pause
POST   /api/loop/resume        — Resume
POST   /api/loop/stop          — Stop
```

Reordering is a PATCH to the parent: `PATCH /api/tasks/:parentId` with `{ childOrder: [id1, id2, ...] }`. This updates the `priority` field on each child atomically.

---

## 7. Frontend

### 7.1 Task Board Page

**Route:** `/` (replaces session list as home screen on mobile) or `/board`

**Layout:**

- Header: "Task Board" + orchestrator status pill (idle/running/paused) + controls
- Tree view: collapsible, nested task list
- Each task shows: status icon, title, assigned session badge, depth indicator
- Active tasks pulse or highlight
- Progress bar per goal (done/total descendants)

**Mobile considerations:**

- Tree indentation via left border colors (not deep padding — screen is narrow)
- Swipe actions: skip, stop
- Tap to expand/collapse children
- Long-press for action menu (interrupt, annotate, redirect, assign, delete)
- Bottom sheet for task details and directing actions

**Depth handling (critical for usability):**

- Auto-collapse: children deeper than depth 2 are collapsed by default
- Focus mode: tap a task to "zoom in" — it becomes the root of the view, showing only its subtree. Breadcrumb trail at the top for navigation back up.
- Breadcrumbs: `Goal > Task > Subtask > ...` — always visible when focused, tappable to navigate up
- Depth limit indicator: if max depth is configured, show a visual marker on tasks approaching the limit
- Summary roll-up: collapsed parent nodes show `3/5 done` badge without expanding

### 7.2 Task Sidebar (in ChatView)

When viewing a session that has task assignments:

- Shows current task context (title, description, annotations)
- Shows sibling tasks and their statuses
- Shows parent goal progress
- Quick actions: complete, block, skip

**Desktop:** Right sidebar panel (alongside or replacing ContextPanel)
**Mobile:** Collapsible header bar or swipe-down panel

### 7.3 Session List Integration

Session list entries show:

- Task badge: which task(s) the session is working on
- Status: active/idle/completed
- Sessions without tasks still appear (ad-hoc chats)

### 7.4 New Components

| Component        | Purpose                                                         |
| ---------------- | --------------------------------------------------------------- |
| `TaskBoard`      | Full board page with tree view                                  |
| `TaskNode`       | Single task in tree (status, title, actions)                    |
| `TaskDetail`     | Expanded task view (description, annotations, session link)     |
| `TaskActions`    | Action menu (interrupt, annotate, redirect, skip, stop, assign) |
| `TaskSidebar`    | In-session task context panel                                   |
| `LoopControls`   | Start/pause/resume/stop orchestrator                            |
| `TaskProgress`   | Progress bar for goal subtrees                                  |
| `TaskCreateForm` | New task input (inline or modal)                                |

### 7.5 State Management

New hook: `useTaskBoard()`

- Hydrates from `GET /api/tasks` on mount (full board snapshot)
- Subscribes to WS `task_updated` deltas and `loop_status` events for live updates
- Applies deltas incrementally to local state (no full re-fetch on every change)
- `task_state` is only used for initial hydration and explicit refresh — never broadcast on mutation
- Provides board data + dispatch actions (create, update, skip, etc.)
- Computes derived state: progress counts, subtree token totals

---

## 8. Prompt Engineering

### 8.1 Task Context Injection

When the orchestrator sends a task to a session, it assembles a prompt:

```
<task id="abc-123" depth="1" parent="Refactor auth module">
  <title>Extract token validation logic</title>
  <description>Move JWT validation from middleware into a dedicated service...</description>
  <annotations>
    - Use the existing auth helpers in lib/auth/
    - Don't break the /api/health endpoint
  </annotations>
  <siblings>
    ✅ Audit current auth flow
    → Extract token validation logic (you are here)
    ○ Add integration tests
    ○ Update API documentation
  </siblings>
  <completed-siblings>
    <summary task="Audit current auth flow">
      Found 3 auth paths: JWT middleware (routes/auth.ts:45),
      API key check (middleware/apikey.ts), and session cookie
      (lib/session.ts). JWT path has no refresh token rotation.
      Key files: routes/auth.ts, middleware/apikey.ts, lib/session.ts.
    </summary>
  </completed-siblings>
</task>

Work on this task. When done, call TaskComplete with a summary of what you did and what the next sibling should know. If you need to break it into subtasks, call TaskSet. If you're blocked, call TaskBlock with a reason.
```

### 8.2 System Prompt Addition

Sessions working under the orchestrator get an additional system prompt block:

```
You are working as part of a task board. Your current task is provided in <task> blocks.
Available task tools: TaskComplete, TaskSet, TaskUpdate, TaskBlock, TaskCreate, TaskStatus.
- Call TaskComplete when the task is done.
- Call TaskSet to decompose into subtasks (they'll be executed automatically).
- Call TaskBlock if you need human input or are stuck.
- Do not work on other tasks — the orchestrator will assign them.
```

### 8.3 Context Budget & Summaries

Deep recursion burns context. Mitigations:

**Spawn policy:** Deep tasks get fresh sessions (no accumulated context). The `auto` heuristic (§4.3) handles this — depth > 2 triggers a spawn.

**Completion summaries (first-class):**

Every completed task produces a `summary` (stored on the task model). This is the primary context handoff mechanism:

```
<completed-sibling task="Audit current auth flow">
  Found 3 auth paths: JWT middleware (routes/auth.ts:45),
  API key check (middleware/apikey.ts), and session cookie
  (lib/session.ts). JWT path has no refresh token rotation.
  Key files touched: none (read-only audit).
</completed-sibling>
```

Summaries are:

- Generated by the agent as part of `TaskComplete` (the tool requires a summary string)
- Injected into the prompt for subsequent sibling tasks
- Cumulative — later siblings see all prior siblings' summaries
- Capped at ~500 tokens per summary to prevent bloat

This is how knowledge flows through the task tree without sharing sessions. A task doesn't need its sibling's full conversation — just the outcome.

**Max depth guard:** Configurable limit (default: 5). Beyond this, the agent is instructed to work inline rather than decomposing further. The prompt changes:

```
You are at maximum decomposition depth. Do NOT create subtasks.
Complete this work directly.
```

---

## 9. Phasing

### Phase 1: Foundation — Board + Manual Loop

**Goal:** Persistent task board with manual orchestration. User creates tasks, assigns sessions, sees progress.

**Server:**

- [ ] `task-board.ts` — SQLite store, CRUD, tree queries
- [ ] REST endpoints for task CRUD
- [ ] Task WS events (`task_state` for hydration, `task_updated` deltas for mutations)
- [ ] WS handlers for client task actions
- [ ] Task board hydration on WS connect

**Frontend:**

- [ ] `TaskBoard` page with tree view
- [ ] `TaskNode` component with status, expand/collapse
- [ ] `TaskCreateForm` — inline task creation
- [ ] `TaskActions` — skip, delete, manual assign
- [ ] Route integration (home screen or `/board`)
- [ ] `useTaskBoard` hook

**Deprecation:**

- [ ] Stop advertising TodoWrite in system prompts (deprecation notice)
- [ ] TodoWrite calls still work but emit a deprecation warning in logs

**Not in Phase 1:** Orchestrator, auto-assignment, agent tools, loop controls, directing.

**Milestone:** User can create a task tree, manually start sessions per task, see status updates.

---

### Phase 2: Agent Tools + Simple Loop + Spec Mode

**Goal:** Agents can read and write tasks. Orchestrator auto-assigns sequential tasks within a goal. Spec mode lets users review the plan before execution.

**Server:**

- [ ] Custom tools: `TaskSet`, `TaskComplete` (with required summary), `TaskStatus`, `TaskBlock`
- [ ] Tool interception in `query-loop.ts`
- [ ] Task context injection in `chat.ts` (system prompt + task block + sibling summaries)
- [ ] `task-orchestrator.ts` — basic sequential loop (DFS, one task at a time per goal)
- [ ] Spec mode: goal starts in ask-only session, user approves before execution
- [ ] Session policy: `reuse` only (same session works through the list)
- [ ] Orphan detection: reclaim tasks from dead sessions
- [ ] Status cascade: `deriveParentStatus()` with cascade rules from §2.3
- [ ] `requires_approval` support: tasks can require user sign-off

**Frontend:**

- [ ] `LoopControls` — start/pause/resume/stop
- [ ] `TaskSidebar` in ChatView (current task context)
- [ ] Live status updates (active task highlights, progress bars)
- [ ] `loop_status` event handling
- [ ] Spec mode UI: review proposed tree, edit, approve to start
- [ ] `pending_review` state with approve/reject actions

**Not in Phase 2:** Multi-session, spawn policy, directing (beyond skip/stop), concurrency locking.

**Milestone:** User drops a goal → agent proposes decomposition → user reviews/edits → approves → orchestrator loops through tasks → user sees progress and can pause/approve completions.

---

### Phase 3: Directing + Session Policy + Concurrency

**Goal:** Full user steering. Session spawn/reuse policies. Multi-session coordination with concurrency control.

**Server:**

- [ ] Directing mechanisms: interrupt, annotate, redirect, reprioritize
- [ ] Session policy: `spawn`, `reuse`, `auto` with heuristic (depth > 2 → spawn, etc.)
- [ ] Multi-session: orchestrator can run parallel tasks in separate sessions
- [ ] Concurrency control: `claimed_by`/`claimed_at` optimistic locking with 5-min expiry
- [ ] `TaskCreate`, `TaskUpdate` agent tools
- [ ] Max depth guard (default: 5)
- [ ] Verification hooks: run validation commands on task completion
- [ ] Scheduling strategy selection: DFS / BFS / priority (per-goal configurable)

**Frontend:**

- [ ] `TaskDetail` expanded view with annotations, session link, summary
- [ ] Interrupt UI (tap task → type message → send)
- [ ] Annotate UI (add notes to pending tasks)
- [ ] Redirect UI (edit description + restart)
- [ ] Reprioritize (drag to reorder on desktop, long-press on mobile)
- [ ] Manual assign (session picker)
- [ ] Session badges on task nodes
- [ ] Focus mode: zoom into subtree with breadcrumb navigation
- [ ] Depth indicators and auto-collapse for deep trees

**Milestone:** User can direct work mid-flight. Tasks run in parallel across sessions. Smart session reuse. Deep trees are navigable.

---

### Phase 4: Intelligence + Polish

**Goal:** The orchestrator gets smarter. Board becomes the primary Mitzo experience.

**Server:**

- [ ] Auto-decomposition: orchestrator can suggest task breakdowns for goals
- [ ] Smart `auto` policy: context-aware session reuse vs spawn decisions
- [ ] Task templates: save and reuse common task structures (e.g., "Refactor module", "Build feature", "Write blog post")
- [ ] Task replay: rewind a task and rerun with different instructions
- [ ] Dual-agent verification: one agent executes, another reviews
- [ ] Task audit log (append to EventStore for history)
- [ ] Notifications: push alerts on task completion, blocks, failures
- [ ] Cost/token visibility: track and display token usage per task and per goal

**Frontend:**

- [ ] Board as default home screen (session list becomes secondary)
- [ ] Goal progress dashboard with cost/token stats
- [ ] Task history timeline
- [ ] Task replay UI (rewind + re-instruct)
- [ ] Template picker: select from saved task structures
- [ ] Desktop: three-panel with board left, chat center, task detail right
- [ ] Mobile: tab bar (Board, Chat, Files)

**Milestone:** Mitzo is a task orchestration platform, not just a chat interface.

---

## 10. Open Questions

### Resolved

| #   | Question                     | Resolution                                                                                                                                                              |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Task completion verification | Three levels: `none`, `approval`, `hook`. Per-task `requires_approval` flag. See §4.6.                                                                                  |
| 5   | Context handoff              | Completion summaries (first-class `summary` field). ~500 token cap. See §8.3.                                                                                           |
| 7   | Conflict resolution          | Optimistic locking via `claimed_by`/`claimed_at` with 5-min expiry. Phase 3. See §4.7. Orchestrator is stateless between iterations — re-reads from SQLite every cycle. |
| 9   | Cost visibility              | `token_usage` field in schema from day one. Incremented during execution, displayed when UI is ready. Forcing function against runaway recursion.                       |
| 10  | TodoWrite relationship       | Deprecate in Phase 1 (stop advertising it), remove in Phase 2. Two task systems = confusion for both agent and user. Task tools are the replacement.                    |

### Still Open

1. **Separate DB or shared?** Tasks in `events.db` or a dedicated `tasks.db`? Separate is cleaner, shared is simpler. Leaning toward `tasks.db` — different lifecycle semantics (wipe/archive tasks independently of events).

2. **Board scope:** One global board per Mitzo instance, or per-repo boards (keyed by REPO_PATH)? Per-repo seems right for isolation, but cross-repo goals are interesting. Start per-repo, optional workspace view in Phase 4.

3. **Concurrency limits:** Phase 3 introduces parallel sessions. How many simultaneous? API rate limits? Cost controls? Need to define a `max_parallel_sessions` config.

4. **Persistence of completed goals:** Archive? Auto-delete after N days? Keep forever? Completed goals should probably archive (hidden from board, queryable via API).

5. **Error recovery:** Session crashes mid-task. Mark failed, notify user, let them retry or skip. Don't auto-retry — it burns tokens on the same failure mode.
