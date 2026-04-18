# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Backend + frontend concurrently (tsx watch)
npm run dev:server   # Backend only (with file watching)
npm run build:server # Compile server TS → dist/ (+ workspace packages)
npm run build        # Production build (frontend into frontend/dist)
npm run build:all    # Build server + frontend
npm start            # Run built server (node dist/index.js)
npm run deploy       # Build all + restart launchd service

npm run lint         # ESLint (server + frontend)
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)
npm test             # Vitest (2200+ tests, 187 files)
```

**Deployment:** Mitzo runs as a launchd service (`com.mitzo.server`). The server is compiled to JS via `tsc` (not live-transpiled). Run `npm run deploy` to build and restart. Logs in `logs/server-{stdout,stderr}.log`.

Pre-commit hooks (husky + lint-staged) run lint and format on staged files. Conventional commit messages enforced via commitlint. **Pre-commit hooks are not a substitute for CI** — they only check staged files of specific types. Always verify CI passes after pushing (see `.cursor/rules/ci-discipline.mdc`).

## Architecture

Web-based command center for Claude Code sessions via the Agent SDK. Two npm projects share one repo:

**Backend** (`server/`) — Node.js + Express + TypeScript, run via `tsx`

- `index.ts` — Express app, mounts routes, HTTP server + WebSocket. Sends `client_id` on WS connect for session reattach. Runs stale worktree cleanup on startup.
- `app.ts` — Express app factory (extracted from index.ts for testability via supertest).
- `chat.ts` — Agent SDK integration: `startChat()` assembles prompts, creates streaming-input `AsyncQueue`, starts `query()`, wires message handler. `sendToChat()` and `interruptChat()` push follow-up messages. Session listing via `listSessions`/`getSessionMessages` SDK calls. `getMessages()` returns v2 `FinishedMessage[]` format for session restore.
- `query-loop.ts` — Core event translator: SDK events → v2 protocol. Maintains `openBlockCount` for deferred `message_end`. `forceFlushPendingMessage()` force-closes open blocks at turn boundaries and session end. Tracks snapshot state for iOS reattach recovery.
- `session-registry.ts` — `SessionRegistry` class: detach/reattach/rekey, TTL-based abort (10 min), `currentSnapshot` for reattach recovery, `findBySessionId` for reconnection.
- `permission-handler.ts` — Builds the `canUseTool` callback for SDK permission flow. Uses `shouldAutoAllow()` for auto-decisions, falls back to WS-based prompting with ntfy/Pushover notifications.
- `async-queue.ts` — `AsyncQueue<T>` implementing `AsyncIterable<T>` for streaming-input. Supports `push()` for follow-up messages and `close()` for session teardown.
- `tool-tiers.ts` — Tool risk classification (`safe`, `standard`, `elevated`, `unknown`). `shouldAutoAllow()` implements mode x tier matrix. `.mitzo.json` tier overrides via `applyTierOverrides()`.
- `tool-summary.ts` — Tool input summarization. **SDK field names**: `file_path` (not `path`), `content` (not `contents`), `pattern`/`path` for Glob (not `glob_pattern`/`target_directory`).
- `content-blocks.ts` — SDK content block parsing (text, tool_use, tool_result). Used by stream and session restore API.
- `permissions.ts` — Permission request/response registry with tier metadata.
- `skills.ts` — Skill registry: scoped discovery (bundled → user → repo), lazy metadata/body loading, deterministic precedence, collision tracking.
- `slash-commands.ts` — Slash-command parsing, prompt expansion, skill resolution from user input.
- `skill-policy.ts` — Per-turn tool restriction: skills declare `allowed-tools` in frontmatter, enforced as a ceiling on `canUseTool`.
- `native-commands.ts` — Built-in native commands (`/skills`) — TypeScript product behavior, not prompt-based.
- `auto-rename.ts` — Automatic session renaming every N user prompts via LLM summarization.
- `event-store.ts` — Persistent event store for session message replay.
- `hook-bridge.ts` — Bridges project-level hooks (`.claude/settings.json`) to Agent SDK sessions.
- `api-schemas.ts` — Zod schemas for HTTP request/response validation.
- `ws-schemas.ts` — Zod schemas for WebSocket message validation.
- `internal-token.ts` — Internal token generation for inter-process auth.
- `repo-mcp-server.ts` — Repo-scoped MCP server configuration.
- `notification-helpers.ts` — Shared notification formatting utilities.
- `inbox.ts` — Inbox integration endpoint.
- `task-store.ts` — `TaskStore` class: SQLite persistence for tasks with tree queries, cascade status, DFS ordering, orphan detection. WAL mode + foreign keys.
- `task-tools.ts` — Pure handler functions for agent task tools (TaskSet, TaskComplete, TaskStatus, TaskBlock). Never throw — return error strings.
- `task-mcp-server.ts` — Stdio MCP server exposing task tools as `mcp__task-board__*`. Calls back to internal HTTP endpoints.
- `task-context.ts` — XML task context builder for system prompt injection. Includes current task, siblings, parent tree, and summaries (capped at 2000 chars).
- `task-orchestrator.ts` — `TaskOrchestrator`: event-driven state machine (idle/running/paused) with DFS sequential task assignment. Spec mode for human review of decompositions. Orphan detection reclaims tasks from dead sessions.
- `mcp-config.ts` — Loads MCP server configs from Cursor mcp.json.
- `worktree.ts` — Git worktree lifecycle.
- `repo-config.ts` — `.mitzo.json` reader for quick actions, venv paths, tier overrides.
- `notify.ts` / `pushover.ts` — Push notifications (ntfy + Pushover/Apple Watch).
- `auth.ts` — Passphrase login, JWT (HS256 via jose), cookie auth.
- `logger.ts` — Structured logger with LOG_LEVEL filtering.
- `constants.ts` — Server-wide constants (timeouts, buffer limits, defaults).
- `git-version.ts` — Local/remote commit comparison for update detection.
- `port-check.ts` — Prevents duplicate server instances.

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript

- `types/chat.ts` — v2 types: `StreamingBlock`, `StreamingMessage`, `FinishedBlock`, `FinishedMessage`, `BlockType`, `RawToolInput`, `PermissionRequest`, `ToolTier`, `Session`, `ImageAttachment`.
- `types/ws-messages.ts` — Typed WebSocket message unions (client → server, server → client).
- `types/task.ts` — Task model types (`Task`, `TaskStatus`, `LoopStatus`, `SessionPolicy`).
- `hooks/` — `useChatMessages` (useReducer for v2 protocol: MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SESSION_END/MESSAGE_SNAPSHOT/RESTORE), `useChatSession`, `useChatConnection`, `usePermission`, `useTaskBoard` (task CRUD + loop control + WS subscriptions), `useFileNavigation`, `useFileEditor`, `useLongPress`.
- `lib/` — `ws-pool` (module-level WebSocket pool with 500-message buffer and auto-reconnect), `groupMessages` (tool block grouping with configurable threshold), `constants`, `formatTime`, `paste-images`, `model-preference`, `rename-session`, `resizeImage`, `swipe-reveal`, `truncate`.
- Pages: `Login`, `SessionList`, `ChatView` (renders `current` inline + `messages[]` grouped), `DesktopChatView`, `FileViewer`, `InboxView`, `CalendarView`, `TodoView`, `TodoDetailView`, `TaskBoard`.
- Components: `MessageBubble` (UserBubble/TextBubble), `ThinkingBlock`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `SlashPicker`, `ErrorBoundary`, `MitzoLogo`, `TaskNode`, `TaskCreateForm`, `LoopControls`, `TaskSidebar`.
- Auth via `ProtectedRoute` wrapper. Vite dev server proxies `/api` and `/ws` to backend.

**v2 protocol — key reducer behaviors:**

- `MESSAGE_START` finalizes any orphaned `current` into `messages[]` before creating new streaming message (prevents multi-turn loss).
- `SESSION_END` force-finalizes `current` if non-null (prevents message loss when server ordering is off).
- `RESTORE` validates message shape — filters out pre-v2 stale localStorage caches.
- `groupBlocks()` guards against undefined/non-array input.

**Session resilience:**

- WebSocket disconnect detaches (not aborts) the session via `SessionRegistry`.
- New WebSocket can reattach to a detached session using the `client_id` sent on connect.
- Detached sessions auto-abort after 10 minutes.
- Frontend uses a module-level WS pool (`ws-pool.ts`) — connections survive component unmount/remount.
- Messages arriving while the chat component is unmounted are buffered in the pool (up to 500 messages) and replayed on re-mount via `wsDrainBuffer()`.

**Repo configuration (`.mitzo.json`):**

- On startup, `repo-config.ts` reads `${REPO_PATH}/.mitzo.json` for quick actions and venv paths.
- Quick actions appear on the home screen grid. Without config, only Chat and Files are shown.
- Venv paths are relative to `REPO_PATH`, resolved and prepended to `PATH` for Agent SDK sessions.
- `GET /api/config` serves resolved quick actions (with absolute `cwd` paths) to the frontend.

**Worktree isolation (opt-in):**

- Worktrees are off by default. Enabled per-session via the "WT" toggle in the chat header.
- `WORKTREE_ENABLED` env var is the ceiling — if `false`, worktrees are disabled entirely.
- When enabled: worktree created at `${REPO_PATH}-sessions/session-<id>/`, branched from HEAD.
- Server sends `session_info` with branch name, cwd, and worktree flag. Frontend shows branch pill.
- Stale worktrees (>7 days) cleaned up on startup.
- Sessions with explicit `cwd` or `resume` skip worktree creation.

**Tool permission tiers:**

- `tool-tiers.ts` classifies tools into four risk tiers: `safe` (read-only, always allowed), `standard` (file writes, allowed in agent/auto), `elevated` (shell, prompted in agent, allowed in auto), `unknown` (MCP tools etc, always prompted).
- `chat.ts` builds `allowedTools` dynamically via `getAllowedToolsForMode(mode)` instead of a static list.
- `canUseTool` in `buildPermissionHandler` uses `shouldAutoAllow()` before prompting, and forwards SDK context (`title`, `description`, `displayName`, `decisionReason`, `tier`) to the frontend.
- `auto` mode maps to `acceptEdits` (not `bypassPermissions`) — auto-allows file edits but still prompts for unknown tools.
- `PermissionBanner` shows a tier badge (color-coded) and SDK title/description when available.

**File browser:**

- `GET /api/git/info` returns current branch + worktree list with branches.
- `GET /api/files` accepts optional `root` query param for worktree-scoped browsing.
- `PUT /api/files/write` writes file content (path-validated to `REPO_PATH` and sessions dir).
- `FileViewer` fetches git info on mount, shows branch pill, worktree selector bar when worktrees exist.
- Markdown files have an Edit button — toggles to a full-height textarea with Save/Cancel and unsaved-changes guards.

**Observability (Jaeger):**

- OpenTelemetry tracing via `server/tracing.ts`, opt-in when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- Jaeger UI at http://localhost:16686, service name: "mitzo"
- Currently instrumented: `ws.switch_session`, `ws.send`, `ws.reconnect` (all in `ws-handler-v2.ts`)
- Query traces via Jaeger API: `curl http://localhost:16686/api/traces?service=mitzo&operation=<op>`
- Deep instrumentation roadmap in `docs/design/otel-deep-instrumentation.md`
- When debugging session/streaming issues, check Jaeger first — it shows routing decisions, timing, and errors

**MCP integration:**

- On startup, `loadMcpServers()` reads `~/.cursor/mcp.json` (or `MCP_CONFIG_PATH`).
- Stdio servers are passed as `mcpServers` in the Agent SDK `query()` options.
- Claude sessions get all configured MCP tools (Jira, GitLab, etc.) automatically.
- `GET /api/config` exposes server names (not credentials) to the frontend.

**Task board and orchestration:**

- `TaskStore` uses SQLite (`.mitzo/tasks.db`) with WAL mode and foreign keys. Tasks form a tree (parentId), with status cascade rules: failed > blocked > active > pending_review > all done/skipped = done > pending.
- `TaskOrchestrator` is a singleton event-driven state machine. `tick()` is stateless — always re-reads from SQLite. No polling; tool completions and REST mutations trigger tick.
- Agent tools (`TaskSet`, `TaskComplete`, `TaskStatus`, `TaskBlock`) are delivered as `mcp__task-board__*` via a child-process MCP server. Classified as `safe` tier.
- Spec mode: `start(goalId, { specMode: true })` lets the agent decompose a goal into subtasks, then pauses for human approval before execution begins.
- Orphan detection: during `tick()`, active tasks whose `session_id` doesn't match any alive session get reclaimed to `pending`.
- Task context is injected into the system prompt as XML blocks per design doc §8.1.
- Loop status is broadcast to all clients via WS (`loop_status` event type).
- REST API: `/api/tasks` CRUD, `/api/loop/{status,start,pause,resume,stop}`, `/api/tasks/:id/{approve,reject}`, `/api/loop/spec/{approve,reject}`.
- Phase 2 is `reuse` session policy only — `spawn`/`auto` are Phase 3.
- Design doc: `docs/design/global-task-board.md`.

**Skills system:**

- Skills are reusable prompt packages invoked via `/slash-command` in chat input.
- Three scopes: **Native** (TypeScript commands like `/skills`), **Skills** (markdown with YAML frontmatter), **Quick actions** (launchers from `.mitzo.json`).
- Discovery: repo-local (`.mitzo/skills/`), user (`~/.mitzo/skills/`), bundled (`server/bundled-skills/`).
- Resolution order: Native → Repo → User → Bundled. Deterministic precedence with collision metadata.
- `SlashPicker` component shows available skills when user types `/` in chat input, with type badges and collision notes.
- Skills can declare `allowed-tools` in frontmatter — enforced as a ceiling (never expands permissions) via `skill-policy.ts`.
- Bundled skills: `/simplify` (complexity, duplication, cleanup), `/risk-scan` (failure modes, missing tests, unsafe assumptions), `/pr-review` (diff/branch code review), `/person` (people profile lookup and update), `/review-response` (triage and fix PR review comments).
- `GET /api/skills` returns merged registry with collision info, scoped by `cwd` query param.

**Voice integration (landing with PR #108):**

- Client-direct architecture: frontend talks to [Yapper](~/projects/yapper/) for STT/TTS, server stays text-only.
- `lib/tts.ts` — Text chunking at sentence boundaries, WAV synthesis via Yapper API, singleton AudioContext playback.
- `hooks/useVoice.ts` — STT (push-to-talk) + TTS (auto-speak toggle, voice selection, sequential chunk playback).
- `components/VoiceSettings.tsx` — Speaker toggle with pulse indicator, voice picker dropdown grouped by language.
- Graceful degradation when Yapper is offline — voice features hide automatically.

**Key conventions:**

- All server imports use `.js` extensions (required for ESM + tsx)
- Frontend and backend have separate `package.json`, `tsconfig.json`, and `node_modules`
- `REPO_PATH` env var controls the default repo (required — set in `.env`)
- No hardcoded machine-specific paths in source code
- Types are in `frontend/src/types/`, not in page files
- Components import from `types/` and `lib/`, never from page files

## What is Mitzo?

Mitzo is a web-based command center for Claude Code sessions, built on the Anthropic Agent SDK. It provides a mobile-first interface for managing AI-assisted workflows — chat sessions with slash-command skills, file browsing/editing, worktree isolation, MCP tool integration, voice input/output via Yapper, quick actions, and a task board with autonomous orchestration.

Mitzo lives at `~/tools/mitzo/` and is pointed at the `mgmt` workspace via the `REPO_PATH` env var. It is open source and designed to be portable — no hardcoded paths or machine-specific configuration.

## Test-Driven Development (Required)

All feature work follows TDD. This is not optional.

### The Cycle

1. **Write test first** — the test defines the API contract (function names, params, return types). The test file is the first artifact.
2. **Run test — see it fail (Red)** — confirm the test fails for the right reason (`ModuleNotFoundError`, `AssertionError`, etc.). If it passes without implementation, the test is wrong.
3. **Implement the feature** — write the minimum code to make the test pass. Follow the contract the test defined.
4. **Run test — see it pass (Green)** — all assertions must pass. If the test fails, fix the implementation, not the test.
5. **Refactor (if needed)** — clean up. Tests must still pass after refactoring.
6. **Commit immediately** — stage both test and implementation files. One atomic commit with a conventional commit message. Never start the next task without committing.

### Anti-patterns

- Writing implementation first, then adding tests afterward.
- Modifying test assertions to match incorrect implementation (fix the code, not the test).
- Committing tests separately from their implementation.
- Skipping the red phase (the test must fail first to prove it tests something real).
- Structuring plans with "Implementation" and "Tests" as separate phases — each step is test-first.

### Running Tests

```bash
npm test              # Vitest — full suite
npm test -- --watch   # Watch mode during development
npm test -- <path>    # Run specific test file
```

### Planning Integration

When creating build plans, each step must be structured as:

```
Step N: Build <component> (test-first)
  - Test file is the first artifact
  - Implementation follows
  - Both committed together
```

## Git Workflow

**Never push to main.** All work — features, fixes, docs, CI config, rule changes, typo corrections — goes through a branch and PR. No exceptions. This is enforced by a pre-commit hook (`.husky/pre-commit`) that rejects commits on `main`.

1. `git checkout -b <type>/<name>` from main
2. Develop and commit on the branch
3. `git push -u origin HEAD && gh pr create`
4. Wait for CI to pass (`gh run watch`)
5. Merge via the PR
6. Delete the branch

See `.cursor/rules/ci-discipline.mdc` for the full CI discipline rules.

## Code Style

- Write minimal, clean code. This project is open source — others will read and contribute to it.
- No machine-specific paths or configuration. Everything must be generic and portable.
- Keep files short and focused. Prefer clarity over cleverness.
- Use `err: unknown` + `instanceof Error` checks, not `err: any`.
- Conventional commits: `feat`, `fix`, `refactor`, `docs`, `build`, `chore`.
