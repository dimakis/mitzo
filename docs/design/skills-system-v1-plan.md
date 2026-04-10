# Skills System V1 Build Plan

**Status:** Proposed → Reviewed
**Date:** 2026-04-04 (reviewed 2026-04-05)
**Depends on:** `docs/features/mitzo-skills-system.md`
**Author:** Claude (with Dimitri)

---

## Goal

Land the smallest useful Mitzo skills system:

- explicit-only skill invocation
- native commands owned by Mitzo
- lazy skill discovery and loading
- repo-local skills resolved from active `cwd` or worktree
- collision visibility with deterministic precedence
- first bundled skill pack:
  - `/simplify`
  - `/risk-scan`
  - `/pr-review`

This plan is deliberately narrow. It builds the substrate first, then proves the product shape with one native command and three bundled skills.

## V1 Scope

### In scope

- server-side skill registry
- bundled + user + repo-local skill discovery
- lazy metadata loading and lazy body loading
- `cwd`-aware repo root resolution for skills
- deterministic precedence with collision metadata
- slash-command parsing and skill prompt rendering
- per-turn skill tool restriction
- `GET /api/skills`
- slash picker in chat input
- native command registry
- `/skills` as the first native command
- bundled skills: `/simplify`, `/risk-scan`, `/pr-review`

### Out of scope

- auto-invocation of skills
- `.claude/skills` import
- shell execution inside skill markdown
- subagent execution from skills
- plugin system
- more native commands beyond `/skills`
- refactoring all of `repoConfig` to become fully `cwd`-scoped

## Success Criteria

V1 is done when all of the following are true:

1. Typing `/` in the chat input opens a picker with `native`, `repo`, `user`, and `bundled` entries.
2. Picker entries are resolved from the active `cwd` or worktree, not just `BASE_REPO`.
3. If `/deploy` exists in more than one scope, Mitzo resolves by precedence and clearly tells the user that a collision exists.
4. Skill metadata can be browsed without loading full `SKILL.md` bodies into the model.
5. Invoking `/name args` is resolved on the server, not trusted to the client.
6. Skill content is only read and rendered when the user explicitly invokes that skill.
7. Skill `allowed-tools` can narrow tool access for that turn, but never expand beyond the current mode.
8. `/skills` executes as a native command and does not hit the model.
9. `/simplify`, `/risk-scan`, and `/pr-review` ship as bundled skills and parse cleanly.

## Structural Constraints

These are the traps that matter.

### 1. The server must remain authoritative

The frontend can help with discovery and autocomplete, but final resolution of `/name args` must happen on the server.

Reason:

- avoids client/server drift
- keeps precedence behavior consistent
- keeps native command execution centralized
- makes collision notices authoritative

### 2. Long-lived sessions change the permission implementation

Mitzo uses a long-lived `query()` with streaming input in `server/chat.ts`. That means SDK `allowedTools` is set when the session starts, not per user turn.

So skill `allowed-tools` cannot rely only on the initial `query({ allowedTools })` options.

V1 must enforce skill restrictions through session-scoped policy state checked by `buildPermissionHandler()` and cleared when the turn completes.

### 3. Skills need `cwd`-aware root resolution without a giant repo-config refactor

Today `repoConfig` is loaded once from `BASE_REPO` in `server/chat.ts`.

That is fine for quick actions and the current app config, but it is not enough for repo-local skill resolution once worktrees or alternate `cwd`s are involved.

V1 should introduce a separate skill-root resolution path instead of trying to make all repo config dynamic in one go.

That keeps the slice shippable.

## Product Shape

### Native commands

Native commands are Mitzo product behavior implemented in TypeScript.

V1 native command set:

- `/skills`

Deferred native commands:

- `/resume`
- `/mcp`
- `/hooks`
- `/loop`

### Bundled skill types

Bundled skills should be:

- cross-repo
- analysis-first
- useful on a phone
- low-assumption about deploy systems and CI
- mostly prompt-driven, not runtime-driven

The initial bundled pack breaks into three useful types:

| Skill        | Type               | Purpose                                                      |
| ------------ | ------------------ | ------------------------------------------------------------ |
| `/simplify`  | quality/refinement | Find complexity, duplication, and cleanup opportunities      |
| `/risk-scan` | diagnostic/risk    | Surface failure modes, missing tests, and unsafe assumptions |
| `/pr-review` | diff/branch review | Review current diff/branch like a compact mobile code review |

`/pr-review` should not assume a real hosted PR exists. In v1 it should review the current branch or diff first, and only use richer context if available.

## Architectural Review (2026-04-05)

Findings from a full trace through the plan against the existing codebase.

### Major Gaps

1. **Wrong interception point.** The plan routes slash resolution through `chat.ts`, but message dispatch lives in `index.ts` (`handleChatWs`). Native commands must intercept _before_ the `isActive()` check — they should never touch the SDK. Skills transform the prompt and pass through to `startChat`/`sendToChat` as usual.

2. **Per-turn tool restriction race condition (Step 3).** `AsyncQueue` allows queued follow-up messages. If the user sends `/simplify` then a plain message while the model is working, restrictions must reset per-message, not per-turn. Fix: attach `skillPolicy` to each message in the queue, read it in `buildPermissionHandler`.

3. **No `skill_invoked` WS event.** The user sends `/simplify api layer` but the model sees a rendered prompt. Without a frontend event, the UX is confusing. Add a `skill_invoked` server→client event so the frontend can badge the user message.

### Cross-Cutting Decisions

| Decision                                                  | Rationale                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Drop parameterized `allowed-tools` from v1                | `Bash(git status)` adds parameter-matching complexity for minimal value. Accept tool names only. |
| Validate `cwd` in `GET /api/skills` via `isAllowedPath()` | Prevents path traversal — same pattern as `GET /api/files`.                                      |
| Add a skills button in `ChatInput.tsx`                    | `/` is on a secondary keyboard page on iOS. Don't rely only on typing it.                        |
| Cache key = resolved skills directory path, not repo root | Worktrees of the same repo can have different `.mitzo/skills/` content.                          |
| `SKILL.md` size limit: 10KB                               | Prevents prompt bloat from malicious or poorly written skills.                                   |
| Safe YAML parsing only                                    | Use `yaml` package or `js-yaml` `safeLoad`. Never `load`.                                        |
| Mode-aware availability hints on skill metadata           | Warn when a skill's tools won't work in the current mode (e.g., `/pr-review` in `ask` mode).     |

### Edge Cases to Handle

- Empty `.mitzo/skills/` directory → return empty registry for that scope
- Missing `SKILL.md` in a skill directory → skip with warning log
- No frontmatter or invalid YAML → skip with warning log
- Empty body after frontmatter → error at invocation time, not at discovery
- `cwd` before session starts → picker defaults to `BASE_REPO`
- Concurrent tabs with skill policy → policy is per-session, not per-connection
- mtime checks → check both directory mtime (entries added/removed) and file mtime (content changes)
- Typos (`/deplo`) → suggest close matches in the error response

---

## Step 1: Build skill registry core (test-first)

- Test file is the first artifact: `server/__tests__/skills-registry.test.ts`
- Implementation follows: `server/skills.ts`
- Both committed together

### What this step builds

- skill metadata model
- scope discovery for:
  - bundled: `~/tools/mitzo/skills/`
  - user: `~/.mitzo/skills/`
  - repo: `<resolved-repo-root>/.mitzo/skills/`
- root resolution from `cwd`
- deterministic precedence
- collision metadata
- lazy metadata cache

### Key decisions

- discover metadata on demand
- do not read full `SKILL.md` bodies in the metadata path
- store collision sets alongside the winning command
- cache key is the absolute resolved path to the skills directory, not the repo root (worktrees can differ)
- repo root resolution uses `git rev-parse --show-toplevel` with timeout and fallback to `cwd` (mirrors `getBranch()` in `chat.ts`)
- mtime invalidation checks both directory mtime (entry add/remove) and individual `SKILL.md` file mtime (content changes)
- malformed/missing `SKILL.md` files are skipped with a warning log, not hard errors
- `SKILL.md` files larger than 10KB are skipped at discovery time
- safe YAML parsing only (`yaml` package or `js-yaml` `safeLoad`)

### Tests

- resolves repo root from `cwd` (including deeply nested subdirectories)
- falls back to `cwd` when not in a git repo
- returns repo/user/bundled entries with correct precedence
- preserves colliding definitions in metadata
- treats native names as reserved
- does not load skill body during metadata-only discovery
- invalidates cache when skill files change (both directory and file mtime)
- skips directories with missing `SKILL.md` (warning, no crash)
- skips `SKILL.md` with invalid/missing YAML frontmatter
- skips `SKILL.md` larger than 10KB
- handles empty `.mitzo/skills/` directory gracefully
- uses separate cache entries for different worktree paths of the same repo

### Likely files

- `server/skills.ts`
- `server/__tests__/skills-registry.test.ts`

## Step 2: Build slash-command parsing and prompt rendering (test-first)

- Test file is the first artifact: `server/__tests__/skill-rendering.test.ts`
- Implementation follows: `server/skills.ts`, `server/chat.ts`
- Both committed together

### What this step builds

- parse `/name args`
- distinguish native command, skill invocation, and plain text
- render skill body with `$ARGUMENTS`
- generate a consistent rendered prompt envelope

### Interception point

Slash resolution must happen in `index.ts` (`handleChatWs`), not inside `chat.ts`. This is because:

- native commands must intercept _before_ the `isActive()` check — they never touch the SDK
- skills transform the prompt and pass through to `startChat`/`sendToChat` as usual

Add a `resolveSlashCommand(prompt, cwd)` call in `handleChatWs` before routing to `startChat`/`sendToChat`.

### Important rule

If the message is not slash-prefixed, Mitzo must pass it through unchanged.

If it is slash-prefixed:

- server resolves it in `index.ts`
- native command → execute directly, respond via WS, never touch SDK
- skill → transform prompt, pass through to `startChat`/`sendToChat`
- unknown → return inline error with close-match suggestions
- client is not trusted as the source of truth

### Parsing rule

Split on first space. First token (without `/`) is the command name, rest is arguments.

`/skills deploy` → `name=skills`, `arguments="deploy"` (not a compound lookup).

### `$ARGUMENTS` substitution

`$ARGUMENTS` is the only substitution token. Simple string replacement, not a template engine. Literal `$ARGUMENTS` in skill text that isn't meant for substitution is an authoring mistake — document this.

### Error transport for unknown commands

Unknown slash commands return a synthetic error rendered inline in the chat, using the existing `ERROR` action pattern in `useChatMessages`. Not a new event type — reuse what exists. Include close-match suggestions (Levenshtein or prefix match against registry).

### Tests

- `/simplify api layer` parses into `name=simplify`, `arguments="api layer"`
- `/skills deploy` parses into `name=skills`, `arguments="deploy"`
- plain text passes through untouched
- unknown slash command returns inline error with suggestions
- rendered prompt includes source, arguments, and skill envelope
- skill body is loaded only at invocation time
- `$ARGUMENTS` is substituted in the rendered body

### Likely files

- `server/skills.ts`
- `server/index.ts` (slash interception in `handleChatWs`)
- `server/chat.ts`
- `server/__tests__/skill-rendering.test.ts`

## Step 3: Build per-turn skill tool restriction (test-first)

- Test file is the first artifact: `server/__tests__/skill-policy.test.ts`
- Implementation follows: `server/session-registry.ts`, `server/permission-handler.ts`, `server/chat.ts`, `server/query-loop.ts`
- Both committed together

### What this step builds

- per-message skill policy (not per-session global state)
- `allowed-tools` enforcement as a restriction, not an expansion
- message-boundary reset of skill restrictions

### Why this step is separate

This is the tricky part of the whole design.

Because the session is long-lived, skill restrictions must be enforced by policy callbacks during the turn, not only by initial SDK options.

### Critical design: per-message policy, not per-turn

The `AsyncQueue` allows queued follow-up messages. Consider:

1. User sends `/simplify api layer` (skill with `allowed-tools: [Read, Glob, Grep]`)
2. While the model processes, user sends `now also refactor the controller` (plain text)

If policy is session-global state, message 2 inherits message 1's restrictions — wrong.

**Fix:** Attach a `skillPolicy` field to each message pushed to the `AsyncQueue`. When the SDK dequeues a message, read its policy and update the permission handler's active restriction. This way each message carries its own policy context.

### `shouldAutoAllow` interaction

`shouldAutoAllow()` in `permission-handler.ts` is called _before_ the WS-based prompt flow. Skill restrictions must be checked _before_ `shouldAutoAllow`, or `shouldAutoAllow` must be made policy-aware. Otherwise a `safe`-tier tool auto-allowed by the mode matrix will bypass skill restrictions.

Recommended: check skill policy first, then fall through to `shouldAutoAllow` only if the tool passes the skill filter.

### Parameterized `allowed-tools` deferred

`Bash(git status)` syntax is deferred to v2. V1 accepts tool names only (e.g., `Read`, `Glob`, `Bash`). Document this in the skill format spec.

### Tests

- skill `allowed-tools` narrows the effective tool set for that turn
- skill cannot grant shell in `ask` mode
- skill restrictions are checked before `shouldAutoAllow` (a `safe` tool not in `allowed-tools` is denied)
- plain message following a skill invocation has no restrictions (per-message reset)
- queued messages carry independent policy (skill message + plain message in queue)
- collisions do not affect policy behavior once resolution is complete
- MCP tools are excluded when `allowed-tools` is specified (not in the allow list = denied)

### Likely files

- `server/session-registry.ts`
- `server/permission-handler.ts`
- `server/query-loop.ts`
- `server/chat.ts`
- `server/__tests__/skill-policy.test.ts`

## Step 4: Build skills API and slash-picker UX (test-first)

- Test files are the first artifacts:
  - `server/__tests__/routes.test.ts` additions
  - `frontend/src/components/__tests__/SlashPicker.test.tsx`
- Implementation follows: `server/app.ts`, `frontend/src/components/SlashPicker.tsx`, `frontend/src/components/ChatInput.tsx`
- Both committed together

### What this step builds

- `GET /api/skills?cwd=...`
- client-side slash picker UI
- source badges
- collision note UI
- argument hints
- skills button in `ChatInput.tsx`

### Security

`GET /api/skills` must validate the `cwd` parameter using `isAllowedPath()` from `app.ts`. Same pattern as `GET /api/files`. Without this, a client could probe arbitrary directory structure.

### `cwd` availability

Before a session starts, the frontend has no session-specific `cwd`. The picker should:

- default to `BASE_REPO` for new sessions (fetched from `GET /api/config`)
- use the session's `cwd` from `session_info` for active sessions

### UX rules

- typing `/` opens picker
- dedicated skills button in input bar also opens picker (iOS keyboard workaround)
- picker can filter by command name (client-side against cached `GET /api/skills` results)
- repo-local results float above others
- collisions are visible as inline text below the entry (not tooltips — no hover on touch)
- picker closes on: backspace past `/`, space after bare `/`, selection, escape/tap-outside
- typos show "no matches" with suggestion if a close match exists

### Tests

- API returns winner plus collision metadata
- API respects `cwd`
- API rejects `cwd` outside allowed paths
- API defaults to `BASE_REPO` when `cwd` is omitted
- API includes `modeCompatible` hint based on current session mode
- picker opens on slash input
- picker opens on skills button tap
- picker renders source badges and argument hints
- picker shows collision notice as inline text when duplicates exist
- selecting an item inserts `/name` into the input
- picker closes on backspace past `/`
- picker filters client-side against cached results

### Likely files

- `server/app.ts`
- `frontend/src/components/ChatInput.tsx`
- `frontend/src/components/SlashPicker.tsx`
- `frontend/src/components/__tests__/SlashPicker.test.tsx`
- `server/__tests__/routes.test.ts`

## Step 5: Build native command registry and `/skills` (test-first)

- Test files are the first artifacts:
  - `server/__tests__/native-commands.test.ts`
  - `frontend/src/hooks/__tests__/useChatMessages.test.ts` additions if new WS events are introduced
- Implementation follows: `server/native-commands.ts`, `server/chat.ts`, `server/ws-schemas.ts`, `frontend/src/types/ws-messages.ts`, `frontend/src/hooks/useChatMessages.ts`
- Both committed together

### What this step builds

- native command registry
- special execution path for native commands
- `/skills`

### Minimal `/skills` behavior

V1 `/skills` should:

- list available commands with source and description
- optionally accept a name argument (`/skills deploy`)
- show collisions for a specific name
- avoid calling the model

### WS dispatch change

Native commands bypass the SDK entirely. The dispatch in `index.ts` (`handleChatWs`) needs a third path:

1. Parse the incoming `send` message for slash prefix
2. If native command → execute directly, send result via WS, never touch `startChat`/`sendToChat`
3. If skill → transform prompt, pass through to normal chat flow
4. If plain text → pass through unchanged

This intercept must happen _before_ the `isActive(clientId)` check, because `/skills` should work whether or not a session is running.

### WS event for native command results

Add a dedicated event rather than pretending results are assistant text:

```typescript
interface NativeCommandResultMsg {
  type: 'native_command_result';
  v: 2;
  command: string;
  content: string; // rendered markdown
  entries?: SkillEntry[]; // for /skills specifically
}
```

Frontend adds a corresponding action in `useChatMessages` and renders native command results distinctly (not as assistant bubbles).

### `skill_invoked` event

When a skill (not native command) is invoked, emit before the rendered prompt reaches the model:

```typescript
interface SkillInvokedMsg {
  type: 'skill_invoked';
  v: 2;
  name: string;
  source: 'repo' | 'user' | 'bundled';
  arguments: string;
}
```

Frontend renders this as a small badge on the user message bubble.

### Tests

- `/skills` executes through native registry, not skill renderer
- `/skills` does not hit the model path
- `/skills` works whether or not a session is active
- `/skills deploy` returns all matching definitions and the winner
- unknown native command names fail cleanly with inline error
- `native_command_result` WS event has correct shape
- `skill_invoked` WS event is emitted before model receives rendered prompt
- frontend renders native command results distinctly from assistant messages

### Likely files

- `server/native-commands.ts`
- `server/index.ts` (third dispatch path in `handleChatWs`)
- `server/chat.ts`
- `server/ws-schemas.ts`
- `frontend/src/types/ws-messages.ts`
- `frontend/src/hooks/useChatMessages.ts`
- `server/__tests__/native-commands.test.ts`

## Step 6: Build the bundled skill pack (test-first)

- Test file is the first artifact: `server/__tests__/bundled-skills.test.ts`
- Implementation follows:
  - `skills/simplify/SKILL.md`
  - `skills/risk-scan/SKILL.md`
  - `skills/pr-review/SKILL.md`
- Both committed together

### Skill contracts

#### `/simplify`

Purpose:

- inspect a changed area or requested scope
- identify duplication, unnecessary complexity, and cleanup opportunities
- present improvements before mutating anything

#### `/risk-scan`

Purpose:

- identify likely failure modes
- call out edge cases and missing tests
- prioritize risks by severity

#### `/pr-review`

Purpose:

- review current diff, branch, or named scope like a mobile-friendly code review
- focus on bugs, regressions, unsafe assumptions, and missing tests
- degrade gracefully if the current mode lacks the tools needed for a full diff review

**Mode compatibility note:** This skill needs `Bash` (for `git diff`), which is `elevated` tier. In `ask` mode, the model will attempt git commands, get denied, and the skill degrades poorly. The `GET /api/skills` response should mark this as `modeCompatible: false` in `ask` mode, and the picker should show a warning badge.

### Tests

- bundled skill names are unique
- bundled skill metadata parses correctly
- descriptions exist and are concise
- each bundled skill's `allowed-tools` does not include `Write` or `Edit` (analysis-first, not mutation-first)
- each bundled skill body contains an explicit approval gate instruction (e.g., "wait for approval", "present before mutating")
- `/pr-review` is marked `modeCompatible: false` for `ask` mode
- all bundled `SKILL.md` files are under 10KB

### Likely files

- `skills/simplify/SKILL.md`
- `skills/risk-scan/SKILL.md`
- `skills/pr-review/SKILL.md`
- `server/__tests__/bundled-skills.test.ts`

## File Map

| Area                          | Files most likely touched                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Skill discovery and rendering | `server/skills.ts`, `server/chat.ts`                                                 |
| Session policy                | `server/session-registry.ts`, `server/permission-handler.ts`, `server/query-loop.ts` |
| API                           | `server/app.ts`                                                                      |
| WS protocol                   | `server/ws-schemas.ts`, `frontend/src/types/ws-messages.ts`                          |
| Chat input UX                 | `frontend/src/components/ChatInput.tsx`, `frontend/src/components/SlashPicker.tsx`   |
| Chat state                    | `frontend/src/hooks/useChatMessages.ts`, maybe `frontend/src/pages/ChatView.tsx`     |
| Bundled content               | `skills/*/SKILL.md`                                                                  |

## Notes on Existing Surfaces

### Quick actions need no schema change for v1

Quick actions already support `prompt`, so they can launch commands immediately:

```json
{
  "label": "Risk scan",
  "desc": "Scan current branch for failure modes",
  "prompt": "/risk-scan"
}
```

That means the skills system can improve quick actions without redesigning them.

### `GET /api/config` should stay focused

Do not overload `GET /api/config` with skills.

Add `GET /api/skills` as a dedicated route instead. Skills are dynamic by `cwd`; app config is not.

## Rollout Recommendation

Land this as six checkpoints in order.

Do not start with bundled skills.

That would be backwards. Without a registry, server-side resolution, and policy enforcement, skill files are just markdown sitting in a directory.

The right order is:

1. registry
2. rendering
3. policy
4. API + picker
5. `/skills`
6. bundled pack

## Remaining Open Questions

1. Should native command results render inline in chat, or open dedicated UI surfaces immediately?
2. Is mtime-based cache invalidation sufficient, or should the slash picker also expose a manual refresh affordance?
3. Should `/pr-review` default to current working tree diff, current branch diff, or ask the user when ambiguity exists?
