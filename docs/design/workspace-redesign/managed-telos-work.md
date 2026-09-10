# Managed Telos work: conversation, plan and worker sessions

Draft implementation contract from the 8 September 2026 workflow trace. This document describes proposed behavior; the manager capability is not implemented by the accompanying navigation fix.

## User experience

Keep one persistent **Manage work** conversation accessible from Chats. It can oversee several explicitly attached Telos items. The manager is the conversation where the user changes priorities, refines plans, resolves blockers and reviews outcomes. Individual worker conversations remain independently accessible.

On desktop, the existing conversation renderer occupies the center; a work panel lists attached Telos items and expands each into its execution steps and worker chats. On mobile, the same work panel opens from the conversation header in a sheet. The bottom workspace navigation stays available. Reuse the existing SessionTray for Sources and Outputs; do not add another competing tray.

Chats shows the manager conversation with a short summary such as “2 items need your input.” Expanding an attached item shows its workers with step name, status and latest outcome. Ordinary chats remain usable independently. A worker header links back to its Telos item and managing conversation. An item may have several historical execution attempts, but only one active owner; enforce that ownership in storage.

From a chat or Symposium, **Save to Telos** offers a new item or an explicit existing-item link. Preserve the source conversation, selected plan revision and acceptance criteria. **Manage this work** attaches the item to the manager; it does not immediately start execution. The manager reuses saved steps or proposes a decomposition. The user can refine it in conversation and approve an exact revision. Only then does execution begin.

The manager can queue several items; first delivery should execute one eligible worker at a time using the existing scheduler. Parallel execution is a later scheduler capability, not implied by grouping chats. Every worker starts in its own worktree and receives the approved step, dependency outcomes and permitted context. Failed steps retain their attempts and evidence; retry creates a new attempt. Changing an approved plan invalidates approval for affected unstarted steps.

When workers finish, show **Ready to verify**. Compare the result with the original Telos acceptance criteria and collect evidence before marking the outcome achieved. Preserve the difference between task completion and verified goal achievement. Show session spend and execution spend with their scopes; do not label an incomplete total “final tokens to goal.”

## Existing implementation and gaps

Source inspected at Mitzo main `23e2695`, using the live read-only `/api/todos` response on 8 September 2026.

- `server/app.ts`, `/api/todos`: delegates to the management workspace's `command_center/todo_api.py`, which reads the Telos store. The Python API already supports `--set-goal`; the Mitzo promotion handler does not call it.
- `frontend/src/pages/TodoDetailView.tsx`, `handlePromote`: posts the item title, context and sources to `/api/workload/items/:id/promote`, then navigates to the task board.
- `server/app.ts`, promotion handler: creates a new root on every request. It links only a matching local `WorkloadStore` record. For a Telos-only item supplied through the fallback body, it persists no reverse link. Repeated promotion can therefore duplicate roots.
- `server/task-store.ts`: SQLite task hierarchy, statuses, worker assignment and execution artifacts already exist. Reuse this execution tree.
- `server/task-orchestrator.ts`: already supports decomposition review, reuse/spawn policy, worker dispatch, pause/resume and workload completion. One in-memory loop selects one root; it is not a durable supervising conversation managing a portfolio of roots.
- `server/index.ts`, orchestrator wiring: reuse chooses the first attached registry client rather than an explicitly selected manager conversation. Spawn starts an isolated headless chat, but currently passes the execution root as `telosTaskId`. Keep intent, execution-root, registry-goal and session identifiers distinct.
- `server/session-overview.ts`: task/goal status exists, but there is no authoritative manager-to-items-to-attempts relationship for a grouped Chats view.
- `server/goal-client.ts`: ContexGin accounting goals form another identifier namespace. Preserve links and attributable prior spend instead of making another goal whenever a session starts.

These findings are source-level observations, not a claim that every live failure path was reproduced. No production work item was promoted or executed during this trace.

## Durable relationship contract

Store explicit relationships rather than infer ownership from a title or whichever chat happens to be connected:

1. Manager: stable ID, owning user, durable conversation ID, state.
2. Managed item: manager ID, Telos intent ID, optional ContexGin goal ID, current approved plan revision, execution root ID, verification state.
3. Plan revision: immutable accepted scope, acceptance criteria, steps, dependencies, source conversation/review references, approval metadata.
4. Execution attempt: step ID, attempt number, durable session ID, transient transport/client ID separately, worktree references, status, artifacts and spend references.

Use a uniqueness constraint for the active Telos-to-execution binding. Promotion must be idempotent and survive retries/restarts. Recover incomplete cross-store link writes rather than create another execution root. Preserve prior roots linked by the existing `telos:` annotation; migrate or reconcile these deliberately.

Manager instructions guide planning and reporting; durable storage and the scheduler own execution state. The manager cannot grant itself new authority. Explicitly bind the selected conversation and authorized context; never reuse an arbitrary attached session.

## Existing Telos work to reuse

- `e90ba17663b377c0`: Telos → Task Board bridge. Reconcile the implemented promotion path and missing durable linking; do not recreate the entire bridge.
- `9fc7bdfb6a9d81fd`: Define goals in chat and make tokens to goal trustworthy. Owns explicit intent/execution/accounting mapping and source-conversation continuity.
- `a4d34a98b4d20bbc`: TELOS and agent taskboard presentation. Existing desktop-page work owns these views; the manager panel consumes their shared task data.
- `2d80ca5c140bac5f`: Repair taskboard dispatch, callback transport and completion. Existing audit work owns dispatch correctness. Integrate its fixes before qualifying manager execution.
- `043860a336dce09c`: Task Board and Symposium workflow acceptance. Use its end-to-end scenario for the manager workflow.
- `b5cd51ac8a56007f`: Carry identity and data boundaries through Telos and Symposium. Owns the durable intent/outcome/seat contract and authority boundaries.

The existing Symposium design remains authoritative for seats, reviewer scope and transcript attribution. The manager consumes its accepted output rather than adding a second deliberation engine.

## Implementation sequence (test-first)

1. **Build durable intent/execution linking.** First test repeated promotion, concurrent requests, restart recovery, failed Telos backlink and legacy annotated roots. Implement storage and reconciliation; commit test and implementation together.
2. **Build manager ownership and recovery.** First test explicit conversation binding, multiple queued items, no attached client, competing manager ownership and restart. Implement persistent manager/item associations and resume behavior; commit together.
3. **Build approved-plan dispatch.** First test revision approval, existing step reuse, dependency failure, pause during dispatch, retry attempt preservation and isolated worktrees. Integrate the audit-owned dispatcher fixes; commit together.
4. **Build Chats and work-panel integration.** First test manager/worker navigation, multiple items, missing session history, ordinary chats, desktop/mobile and preserved token controls. Reuse the existing renderer and task components; commit together.
5. **Build outcome verification.** First test completed children with unmet acceptance criteria, evidence rejection, verified completion and scoped spend. Integrate the identity/outcome contract; commit together.

Acceptance journey: refine a plan in chat or Symposium → save/link one Telos item → attach it to Manage work → review exact decomposition → start isolated workers → interrupt/restart and recover → resolve a failure → inspect artifacts → verify the original outcome. Add a second Telos item to the same manager without duplicate roots, accidental session reuse or loss of history.
