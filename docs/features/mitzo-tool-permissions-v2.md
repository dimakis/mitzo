# Mitzo Tool Permissions V2

## Why this exists

The current permissions model mixes static allow lists, `canUseTool` fallback decisions, and mode mapping in ways that are hard to reason about and easy to over-permit.

This document replaces that with a deterministic tier model and an explicit mode-by-tier matrix.

## What was good in V1

- Correctly identified that `bypassPermissions` is the wrong default for everyday use.
- Introduced a tier model, which is the right abstraction for policy clarity.
- Proposed surfacing SDK prompt context (`title`, `description`, `decisionReason`) to improve HITL quality.
- Included an implementation map by file and a sequence diagram.

## What was risky in V1

- `safe` tier was described as read-only but included mutating tools.
- `auto` mode still allowed elevated tools, increasing blast radius.
- "Always allow" remained effectively name-based even when `ruleContent` existed.
- Ask-mode behavior was internally inconsistent between text and matrix.
- Validation scope was too narrow for a permission-system refactor.

## Policy model (authoritative)

### Tool tiers

- `safe`: read-only, no side effects (`Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`)
- `standard`: workspace-local mutation (`Write`, `Edit`, `StrReplace`, `EditNotebook`, `TodoWrite`, `Task`)
- `elevated`: shell/exec/system/network-sensitive (`Bash`, `Shell`)
- `unknown`: any tool not explicitly classified

### Mode matrix

| Mode                         | safe  | standard | elevated | unknown |
| ---------------------------- | ----- | -------- | -------- | ------- |
| `ask` (`plan`)               | allow | prompt   | prompt   | prompt  |
| `agent` (`default`)          | allow | allow    | prompt   | prompt  |
| `auto` (`acceptEdits`)       | allow | allow    | prompt   | prompt  |
| `yolo` (`bypassPermissions`) | allow | allow    | allow    | allow   |

Notes:

- `auto` is fast-edit mode, not no-guardrail mode.
- `yolo` is explicit and opt-in only, with strong UI warning.
- Unknown tools never auto-allow except in explicit `yolo`.

## "Always allow" semantics

`PermissionUpdate.suggestions` must be applied at `PermissionRuleValue` granularity (tool name + optional `ruleContent`), not just tool name.

Required behavior:

- If suggestion contains `ruleContent`, store and match it.
- Name-only fallback is allowed only when SDK returns no rule content.
- UI copy must reflect scope: "always allow this tool" vs "always allow this exact pattern."

## Implementation changes

### `server/tool-tiers.ts`

- Keep `ToolTier` and `getToolTier()`.
- Make classification side-effect based (not convenience based).
- `shouldAutoAllow(toolName, mode)` must implement matrix exactly.
- Add `getAllowedToolsForMode(mode)` as a derived helper from matrix + map.

### `server/chat.ts`

- Map modes as:
  - `ask` -> `plan`
  - `agent` -> `default`
  - `auto` -> `acceptEdits`
  - `yolo` -> `bypassPermissions`
- Keep `canUseTool` as the final policy gate for all prompted decisions.
- Forward SDK prompt metadata (`title`, `description`, `displayName`, `decisionReason`, `signal`) plus `tier`.

### `server/permissions.ts`

- Persist pending entries with `tier`.
- Persist allow-list entries as structured rules:
  - `toolName`
  - optional `ruleContent`
  - optional provenance (`source: sdk_suggestion | manual`)
- Resolve approvals against structured rules first, then name-only fallback.

### Frontend (`PermissionBanner`, `ChatView`)

- Display tier badge and risk color.
- Prefer SDK `title`/`description` over handcrafted summaries when present.
- Show scope of "Always allow" clearly when `ruleContent` is present.

## Test plan (required)

### Unit

- `tool-tiers.test.ts`
  - classification for known tools
  - unknown defaults to `unknown`
  - mode x tier decision matrix exhaustively validated
- `permissions.test.ts`
  - structured rule matching (with `ruleContent`)
  - fallback behavior when `ruleContent` absent
  - reject over-broad matches

### Integration

- WS `permission_request` contract includes SDK metadata + `tier`
- `auto` mode never silently allows elevated/unknown tools
- `yolo` mode allows all only when explicitly selected
- aborted requests (`signal`) release pending state cleanly

## Rollout

1. Land tier and matrix tests first (red -> green).
2. Land server policy behavior.
3. Land frontend prompt clarity updates.
4. Run full suite (`npm test`) and manual mode smoke checks.
5. Capture before/after examples in PR description (one per mode).
