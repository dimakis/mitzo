# Task Board Phase 2 — Implementation Plan

## Context

Phase 1 (PR #182) delivered the foundation: `TaskStore` with SQLite CRUD + tree queries, REST API, WS broadcast, `useTaskBoard` hook, and `TaskNode`/`TaskCreateForm`/`TaskBoard` frontend. Phase 2 makes the task board autonomous: agents can read/write tasks via custom tools, an orchestrator loop auto-assigns sequential tasks, spec mode lets users review decompositions before execution, and the frontend gains loop controls, a task sidebar, and approval UI.

Design doc: `docs/design/global-task-board.md` (sections 4.1–4.6, 7.2, 7.4–7.5, 8.1–8.3)

## Key Decisions

| Decision               | Choice                                                       | Rationale                                                                                                                       |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Tool delivery          | In-process MCP server via `createSdkMcpServer()`             | Agent SDK native; handlers run in-process, return results directly — no deny/retry issues. Tools appear as `mcp__task-board__*` |
| Orchestrator state     | Stateless between `tick()` — re-reads from SQLite            | Per design doc critical invariant; prevents races with user actions                                                             |
| Session policy         | `reuse` only for Phase 2                                     | `spawn`/`auto` scoped to Phase 3; keeps orchestrator simple                                                                     |
| Spec mode session      | `mode: 'ask'` via existing SDK plan mode                     | Prevents file writes during decomposition                                                                                       |
| Orchestrator lifecycle | Singleton, event-driven (not polling)                        | WS events + REST mutations trigger `tick()` — no timers                                                                         |
| Task context format    | XML blocks per design doc §8.1                               | Structured, parseable, consistent with system prompt patterns                                                                   |
| `deriveParentStatus`   | Method on `TaskStore`                                        | Pure data function; easier to test; orchestrator calls after mutations                                                          |
| Orphan detection       | `TaskStore.getOrphaned()` + `SessionRegistry` liveness check | Store queries active tasks; registry confirms session alive                                                                     |

## Build Order (14 steps, 1 commit each)

### Step 1: `TaskStore` Extensions — Cascade, DFS, Orphan Detection

**Modified files:** `server/task-store.ts`, `server/__tests__/task-store.test.ts`

Extend `TaskStore` with Phase 2 methods:

- `deriveParentStatus(parentId)` — cascade rules from §2.3: failed > blocked > active > pending_review > all-done/skipped > pending
- `cascadeStatus(taskId)` — walk up parent chain calling `deriveParentStatus`, stop when status unchanged
- `getBySession(sessionId)` → Task[] — all tasks assigned to a session
- `setSessionId(taskId, sessionId | null)` → Task | null
- `getNextExecutable(parentId?)` → Task | null — DFS: deepest-left pending leaf, ordered by priority/created_at
- `getOrphaned(activeSessionIds: Set<string>)` → Task[] — active tasks whose session_id is not in the set

**Tests (18):** deriveParentStatus (7 status combos), getBySession (2), setSessionId (2), getNextExecutable (5 incl. DFS ordering, skip done/blocked, null when all done), cascadeStatus (2 multi-level), getOrphaned (2).

**Reference:** `server/task-store.ts`, design doc §2.3

### Step 2: Task Tool Handlers — `server/task-tools.ts`

**New files:** `server/task-tools.ts`, `server/__tests__/task-tools.test.ts`

Pure functions taking `TaskStore` + context, returning result strings:

- `handleTaskSet(store, currentTaskId, tasks: Array<{title, description?, priority?}>)` — delete existing children, create new ones
- `handleTaskComplete(store, currentTaskId, summary: string)` — mark done or pending_review (based on `requiresApproval`), store summary, cascade
- `handleTaskStatus(store, currentTaskId)` — formatted status: current task, siblings, progress
- `handleTaskBlock(store, currentTaskId, reason: string)` — set blocked, add reason to annotations

All return strings (never throw for invalid input — return error strings).

**Tests (14):** TaskSet creates/replaces children (3), TaskComplete done + pending_review + cascade (4), TaskStatus formatted output (2), TaskBlock status + annotation (2), error cases (3).

**Reference:** `server/task-store.ts`

### Step 3: In-Process MCP Server — `server/task-mcp-server.ts`

**New files:** `server/task-mcp-server.ts`, `server/__tests__/task-mcp-server.test.ts`
**Modified files:** `server/chat.ts`, `server/session-registry.ts`, `server/tool-tiers.ts`, `server/tool-summary.ts`

Create an in-process MCP server via the SDK's `createSdkMcpServer()`:

```typescript
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

export function createTaskMcpServer(store: TaskStore, getTaskContext: () => TaskContext | null) {
  return createSdkMcpServer({
    name: 'task-board',
    tools: [
      { name: 'TaskSet', inputSchema: { ... }, handler: async (args) => { ... } },
      { name: 'TaskComplete', inputSchema: { ... }, handler: async (args) => { ... } },
      { name: 'TaskStatus', inputSchema: {}, handler: async () => { ... } },
      { name: 'TaskBlock', inputSchema: { ... }, handler: async (args) => { ... } },
    ],
  });
}
```

Each handler calls the corresponding function from `task-tools.ts`, using `getTaskContext()` to resolve the current task. Returns `{ content: [{ type: 'text', text: resultString }] }`.

In `chat.ts`: when session has task context, add the task MCP server to `mcpServers` in `query()` options. Tools appear as `mcp__task-board__TaskSet` etc — the agent uses them like any other tool.

Add `taskContext: { currentTaskId: string; goalId: string } | null` to `ManagedSession` in `session-registry.ts`.

In `tool-tiers.ts`: classify `mcp__task-board__*` as `safe` tier. In `tool-summary.ts`: add summarization for task tool inputs.

**Tests (10):** MCP server creates with all 4 tools (1), each handler returns correct result format (4), no task context returns error text (1), WS broadcast fires on mutation (1), tool tier classified as safe (1), handler validates input (2).

**Reference:** `server/repo-mcp-server.ts` (MCP pattern), `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`createSdkMcpServer`)

### Step 4: Task Context Injection — `server/chat.ts`

**Modified files:** `server/chat.ts`, `server/session-registry.ts`
**New file:** `server/__tests__/task-context.test.ts`

`buildTaskContextPrompt(store, taskId)` — assembles XML block per §8.1:

- `<task>` with id, depth, parent title
- Title, description, annotations
- Sibling list with status markers
- `<completed-siblings>` with summaries (capped at 2000 chars each)

Append task board system prompt (§8.2) in `startChat` when `taskContext` is present.

**Tests (8):** XML generation (4 variants), system prompt inclusion (1), no task context unchanged (1), depth >= 5 guard (1), summary truncation (1).

**Reference:** `server/chat.ts` (`assemblePrompt`), design doc §8.1–8.3

### Step 5: Task Orchestrator Core — `server/task-orchestrator.ts`

**New files:** `server/task-orchestrator.ts`, `server/__tests__/task-orchestrator.test.ts`

Class `TaskOrchestrator`:

- State: `status: 'idle' | 'running' | 'paused'`, `activeGoalId`, `activeSessionClientId`
- `start(goalId, opts?)`, `pause()`, `resume()`, `stop()`, `getStatus()` → LoopStatus
- `tick()` — the core loop: re-read state, cascade completed, get next executable, assign, inject context, broadcast
- `onTaskCompleted(taskId)` / `onTaskBlocked(taskId)` — trigger `tick()`

Event-driven: `tick()` called on start, resume, task completion, task block. No polling.

**Tests (16):** start (1), pause (1), resume (1), stop (1), tick assigns DFS (2), tick when paused (1), tick when all done (1), tick skips blocked (1), onTaskCompleted (2), onTaskBlocked (1), getStatus (1), cascade on completion (1), goal completion → idle (1), reuse session (1), broadcast fires (1).

**Reference:** Design doc §4.2, `server/chat.ts` (`sendToChat`)

### Step 6: Orchestrator REST + WS Endpoints

**Modified files:** `server/app.ts`, `server/index.ts`, `server/ws-schemas.ts`, `server/api-schemas.ts`
**New file:** `server/__tests__/loop-routes.test.ts`

REST:

```
GET    /api/loop/status
POST   /api/loop/start    { goalId, specMode? }
POST   /api/loop/pause
POST   /api/loop/resume
POST   /api/loop/stop
```

WS: `loop_status` event type. Wire orchestrator instantiation in `index.ts`.

**Tests (10):** status (1), start (1), pause (1), resume (1), stop (1), 400 no goalId (1), 409 already running (1), WS broadcast (1), auth required (2).

**Reference:** `server/app.ts`, `server/index.ts`

### Step 7: Spec Mode

**Modified files:** `server/task-orchestrator.ts`, `server/task-store.ts`, `server/__tests__/task-orchestrator.test.ts`
**New file:** `server/__tests__/spec-mode.test.ts`

`start(goalId, { specMode: true })`:

1. Session with `mode: 'ask'`
2. Inject planning prompt
3. After `TaskSet`, stay paused with `awaitingApproval: true`
4. On user approve → transition to running, begin DFS
5. On reject → delete proposed children, stop

Add `spec_mode` column to tasks table.

**Tests (8):** ask mode session (1), planning prompt (1), stays paused after TaskSet (1), approve → running (1), reject → children deleted (1), flag persisted (1), non-spec direct start (1), session cleanup on reject (1).

**Reference:** Design doc §4.5

### Step 8: Orphan Detection + `requires_approval`

**Modified files:** `server/task-orchestrator.ts`, `server/task-store.ts`, `server/app.ts`
**New file:** `server/__tests__/task-orchestrator.test.ts` (extend)

Orphan detection in `tick()`: find active tasks with dead sessions, reset to pending.

`requires_approval` flow: TaskComplete → `pending_review` → user approve (→ done + cascade) or reject (→ active + feedback annotation + interrupt session).

REST: `POST /api/tasks/:id/approve`, `POST /api/tasks/:id/reject { feedback }`.

Add `getActiveSessionIds()` to `SessionRegistry`.

**Tests (12):** orphan detection (3), requires_approval → pending_review (2), approve → done + cascade (2), reject → active + feedback (2), orchestrator skips pending_review (1), approve triggers tick (1), getActiveSessionIds (1).

**Reference:** Design doc §4.6

### Step 9: Frontend Types — Loop Status + WS Events

**Modified files:** `frontend/src/types/task.ts`, `frontend/src/types/ws-messages.ts`

Add `LoopStatus` interface, `LoopStatusMsg`/`TaskApproveMsg`/`TaskRejectMsg` to WS message union.

No tests (pure types).

### Step 10: `useTaskBoard` — Loop State + Approval Actions

**Modified files:** `frontend/src/hooks/useTaskBoard.ts`, `frontend/src/hooks/__tests__/useTaskBoard.test.ts`

Extend hook:

- `loopStatus: LoopStatus`
- `startLoop(goalId, specMode?)`, `pauseLoop()`, `resumeLoop()`, `stopLoop()`
- `approveTask(id)`, `rejectTask(id, feedback)`
- Subscribe to `loop_status` WS events

**Tests (12):** loop status hydration (1), WS updates (1), each loop action (4), approve/reject (2), defaults (1), regression on existing (1), spec mode flow (1), error handling (1).

### Step 11: `LoopControls` Component

**New files:** `frontend/src/components/LoopControls.tsx`, `frontend/src/components/__tests__/LoopControls.test.tsx`

Props: `loopStatus`, `goals`, `onStart`, `onPause`, `onResume`, `onStop`, `specMode`, `onSpecModeToggle`

Renders: status pill (idle/running/paused), goal selector + Start (idle), Pause + Stop (running), Resume + Stop (paused), progress bar, spec mode toggle, approve/reject (awaiting approval).

**Tests (8):** idle UI (1), running UI (1), paused UI (1), progress bar (1), disabled without goals (1), onStart with goalId (1), spec mode toggle (1), awaiting approval UI (1).

### Step 12: `TaskSidebar` Component

**New files:** `frontend/src/components/TaskSidebar.tsx`, `frontend/src/components/__tests__/TaskSidebar.test.tsx`

Props: `currentTask`, `siblings`, `parentProgress`, `onApprove`, `onReject`

Renders: current task title + description, annotations, sibling list with status icons, progress bar, approve/reject for pending_review. Collapsible on mobile.

**Tests (8):** title + description (1), annotations (1), siblings (1), progress (1), approve/reject for pending_review (2), hidden when null (1), reject feedback input (1).

### Step 13: Page Integration

**Modified files:** `frontend/src/pages/TaskBoard.tsx`, `frontend/src/pages/ChatView.tsx`, `frontend/src/pages/DesktopChatView.tsx`, `frontend/src/styles/global.css`

- `TaskBoard`: add LoopControls, highlight active task, inline approve/reject on pending_review
- `ChatView`/`DesktopChatView`: add TaskSidebar, derive current task from loop status

**Tests (8):** TaskBoard renders LoopControls (1), active task highlighted (1), ChatView renders sidebar (1), sidebar hidden (1), approve/reject wired (1), pending_review inline actions (1), progress matches (1), sidebar collapses mobile (1).

### Step 14: End-to-End Wiring + Cleanup

**Modified files:** `server/index.ts`, `server/app.ts`, `server/query-loop.ts`, `server/constants.ts`
**New file:** `server/__tests__/task-e2e.test.ts`

Final wiring:

- Orchestrator instantiation in `index.ts`
- `onTaskCompleted`/`onTaskBlocked` callbacks from tool interception → orchestrator
- Approve/reject REST → orchestrator
- Constants: `MAX_TASK_DEPTH = 5`, `TASK_SUMMARY_MAX_CHARS = 2000`, `ORPHAN_CHECK_INTERVAL_MS = 60_000`

**Tests (6):** full flow (1), spec mode flow (1), orphan recovery (1), approval flow (1), loop controls (1), status cascade (1).

## Commit Strategy

Branch: `feat/task-board-phase2` (from main after Phase 1 merge)

1. `feat(server): add deriveParentStatus, getNextExecutable, and cascade methods to TaskStore`
2. `feat(server): add task tool handlers (TaskSet, TaskComplete, TaskStatus, TaskBlock)`
3. `feat(server): add task board in-process MCP server`
4. `feat(server): add task context injection to system prompt`
5. `feat(server): add TaskOrchestrator with DFS sequential loop`
6. `feat(server): add orchestrator REST and WS endpoints`
7. `feat(server): add spec mode to orchestrator`
8. `feat(server): add orphan detection and requires_approval flow`
9. `feat(frontend): add loop status types and WS messages`
10. `feat(frontend): extend useTaskBoard with loop state and approval actions`
11. `feat(frontend): add LoopControls component`
12. `feat(frontend): add TaskSidebar component`
13. `feat(frontend): integrate LoopControls and TaskSidebar into pages`
14. `feat: wire end-to-end orchestration loop with tool interception`

## Critical Reference Files

- `server/task-store.ts` — extended in steps 1, 7, 8
- `server/repo-mcp-server.ts` — MCP server pattern for step 3
- `server/chat.ts` — system prompt assembly, `sendToChat`/`interruptChat`
- `server/session-registry.ts` — session state, task context
- `server/query-loop.ts` — tool result events, wiring in step 14
- `server/index.ts` — WS handlers, orchestrator instantiation
- `frontend/src/hooks/useTaskBoard.ts` — hook extended in step 10
- `frontend/src/pages/ChatView.tsx` — TaskSidebar integration

## Verification

1. `npm test` passes after every commit
2. `npm run lint` and `npm run typecheck` pass
3. Manual: create goal → start loop → orchestrator assigns first pending task
4. Manual: agent calls TaskComplete → next task auto-assigned
5. Manual: pause → no new assignments; resume → assignment resumes
6. Manual: stop → status returns to idle
7. Manual: spec mode — create goal → start with spec → agent proposes tree → approve → execution begins
8. Manual: `requires_approval` — TaskComplete → pending_review → approve → done
9. Manual: reject pending_review → feedback annotation, task back to active
10. Manual: TaskSidebar in ChatView when session has active task
11. Manual: LoopControls on TaskBoard reflect orchestrator state
12. Manual: two browser tabs — loop status syncs via WS

## Gotchas

- **In-process MCP tool naming**: tools appear as `mcp__task-board__TaskSet` etc. The `allowedTools` list must include `mcp__task-board__*` wildcard. Ensure `tool-tiers.ts` classifies these as `safe` so they auto-allow without prompting.
- **Orchestrator statelessness**: never cache task state between `tick()` calls — always re-read from SQLite. Prevents races with user edits.
- **Session reuse only**: always inject follow-up prompts via `sendToChat`, not `startChat`. New sessions are Phase 3 (`spawn` policy).
- **`cascadeStatus` loop guard**: stop recursing when parent's derived status matches current. Prevents infinite loops.
- **Spec mode cleanup**: reject must stop the ask-mode session, not leave it orphaned.
- **`PRAGMA foreign_keys = ON`**: already set in Phase 1 TaskStore constructor — verify survives new methods.
- **WS pool `"global"` key**: `loop_status` events must broadcast on the same channel `useTaskBoard` subscribes to.
- **`getNextExecutable` ancestor check**: skip subtrees with blocked/failed ancestors — pending children under a blocked parent are not executable.
- **Task context prompt size**: cap sibling summaries at 2000 chars when injecting. Store full, truncate on read.
- **Concurrent mutations**: orchestrator `tick()` and user REST actions can race. SQLite serializes writes, but re-read state after mutations before acting.
