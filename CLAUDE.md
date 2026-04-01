# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Backend + frontend concurrently
npm run build        # Production build (frontend into frontend/dist)
npm start            # Serve built frontend + API from one process
npm run dev:server   # Backend only (with file watching)

npm run lint         # ESLint (server + frontend)
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)
npm test             # Vitest (118 tests)
```

Pre-commit hooks (husky + lint-staged) run lint and format on staged files. Conventional commit messages enforced via commitlint.

## Architecture

Web-based command center for Claude Code sessions via the Agent SDK. Two npm projects share one repo:

**Backend** (`server/`) — Node.js + Express + TypeScript, run via `tsx`

- `index.ts` — Express app, mounts routes, HTTP server + WebSocket. Sends `client_id` on WS connect for session reattach. Runs stale worktree cleanup on startup.
- `chat.ts` — Agent SDK integration. Manages session lifecycle via `SessionRegistry`, permission handling, mode switching, streaming. Loads MCP servers on startup. Sends `session_info` (branch, cwd, worktree flag) before SDK messages.
- `session-registry.ts` — `SessionRegistry` class: decouples session lifecycle from WebSocket. Supports detach (WS disconnect), reattach (WS reconnect), and TTL-based abort for abandoned sessions (10 min).
- `repo-config.ts` — Reads `.mitzo.json` from `REPO_PATH` for quick actions and venv paths. Falls back to empty defaults if missing or invalid.
- `port-check.ts` — TCP port probe. Prevents duplicate server instances by checking if the port is already in use before `server.listen()`.
- `mcp-config.ts` — Reads MCP server configs from `~/.cursor/mcp.json` (or `MCP_CONFIG_PATH`). Filters to stdio servers, excludes disabled entries, passes to `query()`.
- `content-blocks.ts` — Shared parsing of SDK content blocks (text, tool_use, tool_result). Used by both the streaming loop and the session history API.
- `tool-summary.ts` — Human-readable summarization of tool inputs for the permission UI.
- `worktree.ts` — Git worktree lifecycle: create, remove, cleanup stale, list.
- `tool-tiers.ts` — Tool risk classification (`safe`, `standard`, `elevated`, `unknown`). `getToolTier()` classifies tools, `shouldAutoAllow()` implements the mode x tier decision matrix, `getAllowedToolsForMode()` builds the SDK `allowedTools` list dynamically.
- `permissions.ts` — Permission request/response registry. Passes SDK `suggestions` through for "Always Allow". Carries `tier` on pending entries.
- `notify.ts` — ntfy push notifications for permission prompts.
- `auth.ts` — Passphrase login, JWT (HS256 via jose), cookie-based auth.

**Frontend** (`frontend/`) — React 19 + Vite + TypeScript

- `types/chat.ts` — Shared types: `Message`, `Session`, `ImageAttachment`, `PermissionRequest` (with `title`, `description`, `tier`), `ToolTier`, `GroupedItem`.
- `lib/` — Shared utilities: `groupMessages`, `formatTime`, `truncate`, `resizeImage`, `ws-pool` (module-level WebSocket pool with message buffering).
- Pages: `Login`, `SessionList` (dynamic quick actions from `.mitzo.json` + history + swipe-to-dismiss), `ChatView` (streaming chat + sandbox toggle + branch pill + buffer replay on mount), `FileViewer` (directory browser + markdown viewer/editor + worktree selector + branch indicator).
- Components: `MessageBubble`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `MitzoLogo`.
- Auth check via `ProtectedRoute` wrapper that calls `/api/auth/check`.
- Vite dev server proxies `/api` and `/ws` to backend (port 3100).

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

**MCP integration:**

- On startup, `loadMcpServers()` reads `~/.cursor/mcp.json` (or `MCP_CONFIG_PATH`).
- Stdio servers are passed as `mcpServers` in the Agent SDK `query()` options.
- Claude sessions get all configured MCP tools (Jira, GitLab, etc.) automatically.
- `GET /api/config` exposes server names (not credentials) to the frontend.

**Key conventions:**

- All server imports use `.js` extensions (required for ESM + tsx)
- Frontend and backend have separate `package.json`, `tsconfig.json`, and `node_modules`
- `REPO_PATH` env var controls the default repo (required — set in `.env`)
- No hardcoded machine-specific paths in source code
- Types are in `frontend/src/types/`, not in page files
- Components import from `types/` and `lib/`, never from page files

## What is Mitzo?

Mitzo is a web-based command center for Claude Code sessions, built on the Anthropic Agent SDK. It provides a mobile-first interface for managing AI-assisted workflows — chat sessions, file browsing/editing, worktree isolation, MCP tool integration, and quick actions.

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

## Code Style

- Write minimal, clean code. This project is open source — others will read and contribute to it.
- No machine-specific paths or configuration. Everything must be generic and portable.
- Keep files short and focused. Prefer clarity over cleverness.
- Use `err: unknown` + `instanceof Error` checks, not `err: any`.
- Conventional commits: `feat`, `fix`, `refactor`, `docs`, `build`, `chore`.
