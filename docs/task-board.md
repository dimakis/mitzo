# Task Board

The task board provides multi-session goal decomposition and autonomous execution. Drop a high-level goal, Claude decomposes it into subtasks, and the orchestrator executes them sequentially using DFS ordering.

For the internal design rationale, see `docs/design/global-task-board.md`.

## Concepts

### Task Tree

Tasks form a tree hierarchy. A goal is a root task with subtasks as children:

```
Goal: "Add dark mode support"
  +-- Task: "Add theme context and provider"      (done)
  +-- Task: "Update component styles"              (active)
  |     +-- Subtask: "Update header"               (done)
  |     +-- Subtask: "Update sidebar"              (pending)
  |     +-- Subtask: "Update main content"         (pending)
  +-- Task: "Add toggle in settings"               (pending)
  +-- Task: "Run tests and fix failures"           (pending)
```

### Task Status

| Status           | Description                                |
| ---------------- | ------------------------------------------ |
| `pending`        | Not yet started                            |
| `active`         | Currently assigned to a session            |
| `done`           | Completed successfully                     |
| `failed`         | Failed (blocks siblings from proceeding)   |
| `blocked`        | Blocked by a dependency or external signal |
| `skipped`        | Skipped by the orchestrator                |
| `pending_review` | Awaiting human approval (spec mode)        |

### Status Cascade

Status propagates up the tree automatically:

- If any child is `failed`, the parent becomes `failed`
- If any child is `blocked`, the parent becomes `blocked`
- If any child is `active`, the parent becomes `active`
- If any child is `pending_review`, the parent becomes `pending_review`
- If all children are `done` or `skipped`, the parent becomes `done`
- Otherwise, the parent stays `pending`

### DFS Ordering

The orchestrator picks tasks in depth-first order. Within siblings, lower priority numbers go first. This means the tree is executed top-down, left-to-right, finishing each subtree before moving to the next sibling.

## Using the Task Board

### Creating a Goal

From the Task Board page, create a root goal:

1. Tap "New Goal"
2. Enter a title (e.g., "Add dark mode support")
3. Optionally add a description with more context
4. Create the goal

### Starting the Loop

Once you have a goal, start the orchestration loop:

1. Tap "Start" on the goal
2. Choose whether to use **spec mode** (recommended for complex goals)
3. The orchestrator assigns the goal to a session

### Spec Mode

In spec mode, the loop pauses after the agent decomposes the goal into subtasks. You review the proposed plan before execution begins:

1. Start loop with spec mode enabled
2. Claude decomposes the goal into subtasks
3. Loop pauses -- you see the proposed task tree
4. **Approve** to proceed with execution
5. **Reject** to have Claude re-plan with optional feedback

This prevents the agent from charging ahead with a bad decomposition.

### Loop Controls

| Control | Description                            |
| ------- | -------------------------------------- |
| Start   | Begin executing from the goal          |
| Pause   | Pause after the current task completes |
| Resume  | Resume from where it paused            |
| Stop    | Stop the loop entirely                 |

### Task Actions

| Action  | Description                                                 |
| ------- | ----------------------------------------------------------- |
| Approve | Approve a `pending_review` task                             |
| Reject  | Reject with optional feedback (task goes back to `pending`) |

## Orchestrator State Machine

The `TaskOrchestrator` is a singleton with three states:

```
     start()          pause()
idle -------> running -------> paused
  ^             |                |
  |     stop()  |     resume()   |
  +-------------+<---------------+
```

### Tick-Based Execution

The orchestrator is **stateless** -- every `tick()` re-reads the full task tree from SQLite and determines the next action. No polling; ticks are triggered by:

- Tool completions (agent finishes a task)
- REST mutations (user creates/updates tasks)
- Loop state changes (start/pause/resume/stop)

This makes the orchestrator resilient to crashes. Restart the server and it picks up where it left off.

### Orphan Detection

During each tick, the orchestrator checks for active tasks whose `session_id` doesn't match any alive session. Orphaned tasks are reclaimed to `pending` status so they can be re-assigned.

## Agent Tools

The agent interacts with the task board via MCP tools delivered through a child-process MCP server:

| Tool                            | Description                                  |
| ------------------------------- | -------------------------------------------- |
| `mcp__task-board__TaskSet`      | Decompose a task into subtasks               |
| `mcp__task-board__TaskComplete` | Mark the current task as done with a summary |
| `mcp__task-board__TaskStatus`   | Get the current task and sibling status      |
| `mcp__task-board__TaskBlock`    | Block the current task with a reason         |

These tools are classified as `safe` tier (auto-allowed in all modes).

### Task Context Injection

When a session is assigned a task, the task context is injected into the system prompt as XML blocks:

```xml
<task-context>
  <current-task id="task-123" status="active">
    <title>Update header component</title>
    <description>Add dark mode class switching</description>
  </current-task>
  <siblings>
    <task id="task-122" status="done">
      <title>Add theme context</title>
      <summary>Created ThemeContext with light/dark...</summary>
    </task>
    <task id="task-124" status="pending">
      <title>Update sidebar</title>
    </task>
  </siblings>
  <parent id="task-120">
    <title>Update component styles</title>
  </parent>
</task-context>
```

Summaries from completed siblings are included (capped at 2000 chars) so the agent has context about what was already done.

## Persistence

The task store uses SQLite (`.mitzo/tasks.db`) with WAL mode and foreign keys:

- Tasks table with tree structure (parentId foreign key)
- Status cascade computed on every write
- DFS ordering via recursive CTE queries
- Orphan detection queries

## Workflow Templates

Templates allow you to define reusable task structures:

```json
{
  "name": "PR Review Pipeline",
  "description": "Standard PR review with CI gate",
  "stages": [
    { "title": "Run tests", "stageType": "agent" },
    { "title": "Wait for CI", "stageType": "wait_for_signal", "gateConfig": { "type": "gh_ci" } },
    { "title": "Code review", "stageType": "agent" }
  ]
}
```

### Stage Types

| Type              | Description                                 |
| ----------------- | ------------------------------------------- |
| `agent`           | Executed by a Claude session                |
| `wait_for_signal` | Pauses until an external signal is received |

### Gate Config

Signal stages wait for external events:

| Gate Type        | Description                |
| ---------------- | -------------------------- |
| `gh_ci`          | GitHub CI check completion |
| `gh_review`      | GitHub PR review           |
| `centaur_review` | Centaur automated review   |
| `human_approval` | Manual human approval      |

Signals are resolved via `POST /api/signals/resolve` or `POST /api/tasks/:id/signal`.

### Instantiation

Create a task tree from a template:

```bash
curl -X POST http://localhost:3100/api/workflows/instantiate \
  -H 'Content-Type: application/json' \
  -d '{
    "templateId": "tmpl-123",
    "title": "Review PR #42",
    "variables": { "pr_number": 42 }
  }'
```

## REST API

### Tasks

| Method   | Endpoint                 | Description                         |
| -------- | ------------------------ | ----------------------------------- |
| `GET`    | `/api/tasks`             | Get all tasks as tree               |
| `POST`   | `/api/tasks`             | Create a task                       |
| `GET`    | `/api/tasks/:id`         | Get specific task                   |
| `PATCH`  | `/api/tasks/:id`         | Update task                         |
| `DELETE` | `/api/tasks/:id`         | Delete task                         |
| `POST`   | `/api/tasks/:id/approve` | Approve pending_review task         |
| `POST`   | `/api/tasks/:id/reject`  | Reject with optional feedback       |
| `POST`   | `/api/tasks/:id/signal`  | Send signal to wait_for_signal task |

### Loop

| Method | Endpoint                 | Description                                |
| ------ | ------------------------ | ------------------------------------------ |
| `GET`  | `/api/loop/status`       | Get loop state                             |
| `POST` | `/api/loop/start`        | Start loop (body: `{ goalId, specMode? }`) |
| `POST` | `/api/loop/pause`        | Pause loop                                 |
| `POST` | `/api/loop/resume`       | Resume loop                                |
| `POST` | `/api/loop/stop`         | Stop loop                                  |
| `POST` | `/api/loop/spec/approve` | Approve spec decomposition                 |
| `POST` | `/api/loop/spec/reject`  | Reject spec decomposition                  |

### Templates

| Method   | Endpoint                     | Description                  |
| -------- | ---------------------------- | ---------------------------- |
| `GET`    | `/api/templates`             | List templates               |
| `GET`    | `/api/templates/:id`         | Get template                 |
| `POST`   | `/api/templates`             | Create template              |
| `DELETE` | `/api/templates/:id`         | Delete template              |
| `POST`   | `/api/workflows/instantiate` | Instantiate template as goal |

## WebSocket Events

The task board broadcasts state changes to all connected clients:

| Event          | Description                              |
| -------------- | ---------------------------------------- |
| `loop_status`  | Loop state changed (idle/running/paused) |
| `task_state`   | Full task tree update                    |
| `task_updated` | Single task update                       |
| `task_deleted` | Task deletion                            |

## Session Policy

Currently Phase 2, which supports `reuse` session policy only -- tasks are assigned to the existing session. Phase 3 will add `spawn` (new session per task) and `auto` (orchestrator decides).
