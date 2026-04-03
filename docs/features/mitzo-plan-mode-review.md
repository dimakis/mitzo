# Mitzo Plan Mode Review

## Reviewed document

- Source: `~/.cursor/plans/mitzo_plan_mode_e46e5a8e.plan.md`
- Review goal: identify what is strong, what is risky, and how to improve the plan so it aligns with Mitzo's actual runtime behavior.

## What is good

- Product intent is strong: Ask mode for planning and Agent mode for execution is intuitive.
- Using structured tool signals (`TodoWrite`) is better than markdown parsing.
- The plan is well decomposed across server, frontend, and UX.
- Scope is mostly controlled (no plan editing/versioning in v1).

## Critical issues (must fix)

### 1) Plan state lifecycle mismatch

The plan assumes server-side session state can carry plan data across the Ask -> Agent transition. In current Mitzo, session registry state is removed at the end of a run, so `ManagedSession.plan` is not a reliable handoff mechanism.

Impact:

- Ask run can complete and clear server session state before user switches to Agent mode.
- "Execute plan on mode switch" can fail because plan is gone.

### 2) Execute trigger path is wrong for idle state

The design depends on a `set_mode` transition in WebSocket handling. In current frontend behavior, `set_mode` is only sent while a run is active. Users typically switch mode after planning completes (idle), so backend does not receive the transition event.

Impact:

- Clicking mode pills after a completed Ask turn does not trigger backend mode-change logic.

### 3) Mid-run mode changes do not reconfigure SDK query options

`permissionMode`, `allowedTools`, and system prompt append are fixed at query start. Updating `registry.mode` mid-run does not reconfigure those options for the running query.

Impact:

- A mode toggle alone does not produce true Agent-mode execution semantics for the current run.

## Important issues

### 4) `TodoWrite` as planning signal is unproven in Ask/plan mode

The proposal assumes model behavior that should be validated with tests. If `TodoWrite` is not emitted reliably in plan mode, the PlanCard pipeline breaks.

### 5) `tool_result` update strategy is underspecified

Current `tool_result` events are text-oriented. Treating them as structured plan source requires explicit correlation via `tool_use_id` and fallback behavior.

## Recommended design changes

### A) Replace mode-switch execution trigger with explicit execute action

Use an explicit "Execute Plan" action:

1. Set local mode to `agent`
2. Send a normal user message (e.g., "Execute the current plan step by step.")
3. Let a new query turn start with Agent-mode options

This fits Mitzo's per-run query setup and avoids hidden mode-transition coupling.

### B) Frontend owns durable plan state for the session UX

Treat frontend reducer state as the PlanCard source of truth during chat UX. Server emits `plan_update`; frontend stores and renders. Do not depend on `ManagedSession.plan` for cross-run continuity.

### C) Canonical event source should be `content_block_stop` for `TodoWrite`

Parse structured todo payload from `content_block_stop` for `tool_use` blocks. Use `tool_result` only as supplemental metadata, not the primary plan state source.

### D) Define clear plan lifecycle rules

Specify exactly when plan is:

- created,
- replaced,
- cleared,
- restored on reconnect,
- invalidated by a new Ask prompt.

## Minimum test additions

- Ask run emits `plan_update` from `TodoWrite` and PlanCard renders.
- Ask run ends; user clicks Execute; Agent run starts with expected prompt.
- Idle mode switch alone does not silently execute anything.
- `set_mode` during active run does not mutate already-created query options.
- Reconnect/restore preserves visible plan state in frontend.

## Suggested v2 scope

Ship in two slices:

1. Plan capture + PlanCard rendering (no execute automation)
2. Explicit Execute Plan action that starts a new Agent run

This de-risks the architecture and keeps behavior predictable.
