# Mitzo Enterprise Engineering Plan

**Version:** 1.3
**Date:** 2026-04-03
**Scope:** Documentation only — no code changes until explicitly requested

---

## Executive Summary

Mitzo is a functional, mobile-first Claude Code interface built on Node.js/Express/TypeScript (backend) and React 19/Vite/TypeScript (frontend). It runs in production via pm2 on a personal server, with Pushover + ntfy push notifications, worktree isolation, MCP tool integration, and extended thinking visibility.

**v0.1.0 released (2026-04-03).** Phase 1 complete, Phase 2 partially complete. The v2 message protocol landed with explicit block lifecycle, deferred message_end, and message snapshots for iOS reattach. The former god objects have been modularized:

- `chat.ts` reduced from 575 → 468 LOC (query-loop, permission-handler, async-queue extracted)
- `ChatView.tsx` reduced from 542 → 337 LOC (useChatMessages, useChatSession, useChatConnection, usePermission extracted)

Remaining risks:

1. **Testing blindspots** — 209 tests across 22 files (up from 151/18), but still no route-layer tests, no WS integration tests, no e2e tests. Frontend reducer tests are strong but component test coverage is thin.
2. **Type erosion** — `any` in production code, untyped WS messages, no runtime validation. Model catalog still duplicated.
3. **Security posture** — no rate limiting, CSRF, or request size limits.

CI is now green and structurally sound (all steps run independently). Branch discipline enforced via `.cursor/rules/ci-discipline.mdc`.

The five remaining phases address these risks in dependency order.

---

## Current State Baseline

Measured against the codebase as of 2026-04-03 (v0.1.0, post-Phase 2 partial).

### Codebase Size

| File                                    | LOC | Role                                                  |
| --------------------------------------- | --: | ----------------------------------------------------- |
| `frontend/src/hooks/useChatMessages.ts` | 519 | Chat reducer + WS handler (extracted from ChatView)   |
| `server/chat.ts`                        | 468 | Chat orchestration (reduced from 575)                 |
| `server/index.ts`                       | 454 | Express routes + WS handler                           |
| `server/query-loop.ts`                  | 374 | SDK → v2 protocol translator (extracted from chat.ts) |
| `frontend/src/pages/ChatView.tsx`       | 337 | Chat UI (reduced from 542)                            |
| `frontend/src/pages/SessionList.tsx`    | 248 | Home screen + session list                            |
| `server/session-registry.ts`            | 197 | Session state + snapshot                              |
| `frontend/src/pages/FileViewer.tsx`     | 144 | File browser + editor                                 |
| `server/worktree.ts`                    | 145 | Git worktree lifecycle                                |
| `server/permission-handler.ts`          | 130 | canUseTool callback (extracted from chat.ts)          |

New since v1.2: `query-loop.ts`, `permission-handler.ts`, `async-queue.ts`, `useChatMessages.ts` (hook), `useChatSession.ts`, `useChatConnection.ts`, `usePermission.ts`, `ThinkingBlock.tsx`, `ErrorBoundary.tsx`.

### Phase 1 Status: COMPLETE

| Deliverable                                                                    | Status |
| ------------------------------------------------------------------------------ | ------ |
| Constants centralized (`server/constants.ts`, `frontend/src/lib/constants.ts`) | Done   |
| Structured logger (`server/logger.ts`)                                         | Done   |
| Silent catch blocks fixed (22 → 0)                                             | Done   |
| Error boundaries (ChatView, FileViewer, full app)                              | Done   |
| CI restructured (all steps run independently via `if: always()`)               | Done   |
| CI discipline rule (`.cursor/rules/ci-discipline.mdc`)                         | Done   |
| Branch workflow enforced (never push to main)                                  | Done   |

### Testing

| Metric                      |                                                        Count |
| --------------------------- | -----------------------------------------------------------: |
| Test files                  |                                                           22 |
| Test cases (`it()`)         |                                                          209 |
| Frontend reducer test files |                1 (`chatMessagesReducer.test.ts` — 30+ cases) |
| Frontend lib test files     |      3 (`groupMessages`, `paste-images`, `model-preference`) |
| Server unit test files      | 18 (query-loop, tool-summary, auth, chat, permissions, etc.) |
| Route-layer test files      |                                                            0 |
| WebSocket integration tests |                                                            0 |
| E2E test files              |                                                            0 |

### Security & CI

| Item                                     | Status                                                   |
| ---------------------------------------- | -------------------------------------------------------- |
| Rate limiting                            | None                                                     |
| CSRF protection                          | None (partial via `sameSite: 'strict'`)                  |
| Request size limits                      | None (`express.json()` unlimited)                        |
| Security headers (helmet)                | Not installed                                            |
| Notification tokens                      | NTFY token in URLs; Pushover reuses `NTFY_AUTH_TOKEN`    |
| CI: lint + typecheck + unit test + build | Yes (all steps independent)                              |
| CI: e2e tests                            | No                                                       |
| CI: security scanning                    | No                                                       |
| CI: coverage reporting                   | No                                                       |
| CI: bundle size tracking                 | No                                                       |
| Deployment                               | `scripts/deploy.sh` (git pull + npm build + pm2 restart) |

---

## Phase 1: Foundation — Error Handling, Logging, Constants ✓ COMPLETE

**Completed 2026-04-02.** Constants centralized, structured logger deployed, 22 silent catches fixed, error boundaries added, CI restructured, branch discipline enforced.

### Rationale

Silent failures hide production bugs. Scattered constants make reasoning about system behavior impossible. These fixes are cheap, high-leverage, and required before adding tests (you cannot assert on behavior you cannot observe) or security controls (you cannot rate-limit if you cannot log violations).

### 1.1 Centralize All Constants

Create a single source of truth for every hardcoded value. See the **Constants Centralization Plan** section for the full inventory.

| Task                                      | Files Affected                                                                                                          | Complexity |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| Create `server/constants.ts`              | New file                                                                                                                | S          |
| Create `frontend/src/lib/constants.ts`    | New file                                                                                                                | S          |
| Replace all hardcoded values with imports | `chat.ts`, `notify.ts`, `session-registry.ts`, `tool-summary.ts`, `groupMessages.ts`, `ws-pool.ts`, `content-blocks.ts` | M          |

### 1.2 Structured Logging (Server)

Replace raw `console.log/error` calls with a lightweight structured logger. Shape: `{ level, module, message, ...context }`.

| Task                                                    | Files Affected                                                               | Complexity |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| Create `server/logger.ts` (thin wrapper over `console`) | New file                                                                     | S          |
| Replace all `console.*` calls with `logger.*`           | `chat.ts`, `index.ts`, `worktree.ts`, `mcp-config.ts`, `session-registry.ts` | M          |
| Add request-ID correlation for HTTP logs                | `index.ts`                                                                   | M          |

### 1.3 Fix Silent catch Blocks

The 15+ empty or single-line silent catches fall into two categories:

- **Infrastructure catches** (worktree cleanup, stale dir iteration) — non-fatal, should at minimum log a `warn`
- **Logic catches** (message parsing, `getMessages` outer try-catch, `ChatView.tsx` localStorage) — mask bugs, need specific error types and logging

| Task                                                                    | Files Affected                                                                                            | Complexity |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------- |
| Audit and classify all silent catches                                   | `chat.ts`, `worktree.ts`, `repo-config.ts`, `mcp-config.ts`, `index.ts`, `ChatView.tsx`, `FileViewer.tsx` | M          |
| Add `logger.warn` to intentionally-swallowed errors                     | Same                                                                                                      | S          |
| Convert logic-path catches to log + rethrow or log + user-visible error | Same                                                                                                      | M          |

### 1.4 Frontend Error Boundaries

Add a React error boundary wrapping `ChatView` and `FileViewer`. Without this, any unhandled render error crashes the entire page with a blank screen — on mobile, this is a silent failure.

| Task                                               | Files Affected | Complexity |
| -------------------------------------------------- | -------------- | ---------- |
| Create `frontend/src/components/ErrorBoundary.tsx` | New file       | S          |
| Wrap routes in `App.tsx`                           | `App.tsx`      | S          |

### 1.5 Fix the Failing notify.ts Test

`notify.test.ts` has one test flagged as failing. Fix before the test suite is extended.

| Task                                      | Files Affected                                        | Complexity |
| ----------------------------------------- | ----------------------------------------------------- | ---------- |
| Diagnose and fix `notify.test.ts` failure | `server/__tests__/notify.test.ts`, `server/notify.ts` | S          |

### Phase 1 Success Criteria

- [x] Zero inline magic numbers in server or frontend code — all imported from `constants.ts`
- [x] Zero raw `console.*` calls in `server/` — all routed through `logger.*`
- [x] Silent catch count reduced from 22 to 0 (each either logs or rethrows)
- [x] React error boundary wraps all routes — blank-screen crash impossible
- [x] All 151 tests pass (up from 118 at plan creation)

---

## Phase 2: Modularization — Split God Objects, Extract Hooks, State Management

**Priority: High. Required before features can be added safely.**
**Goal:** Reduce file complexity, make components independently testable, eliminate race conditions.

### 2.1 Split `startChat()` in `chat.ts`

`startChat()` at ~200 LOC performs five distinct jobs (image staging, tool list construction, query config, permission handling with ntfy + Pushover, SDK event loop with thinking resolution). Extract each into a named function:

| Extract                                | Into                                              | Description    |
| -------------------------------------- | ------------------------------------------------- | -------------- |
| Image staging and prompt assembly      | `assemblePrompt(prompt, images, cwd)`             | Pure function  |
| Tool allow-list construction           | `buildAllowedTools(mode, mcpServers, extraTools)` | Pure function  |
| SDK query configuration object         | `buildQueryOptions(...)`                          | Pure function  |
| SDK event loop (the `for await` block) | `runQueryLoop(q, clientId, abortController)`      | Async function |

`startChat()` becomes an orchestrator. The 110-LOC `buildPermissionHandler()` closure moves to its own module (`server/permission-handler.ts`) to make it independently testable.

| Task                                                            | Files Affected                  | Complexity |
| --------------------------------------------------------------- | ------------------------------- | ---------- |
| Extract helper functions from `startChat`                       | `chat.ts`                       | M          |
| Move `buildPermissionHandler` to `server/permission-handler.ts` | New file, `chat.ts`             | M          |
| Verify no behavior change via existing tests                    | `server/__tests__/chat.test.ts` | S          |

### 2.2 Refactor `ChatView.tsx` — Hook Extraction

`ChatView.tsx` at 542 LOC does seven things simultaneously: session identity management, WebSocket subscription and message routing (including thinking blocks), message state accumulation, streaming + thinking buffer management, permission state, model persistence, and send/stop logic. Extract into four custom hooks. See the **ChatView Hook Extraction Plan** section for signatures.

| Task                                                    | Files Affected                   | Complexity |
| ------------------------------------------------------- | -------------------------------- | ---------- |
| Extract `useChatSession`                                | New `hooks/useChatSession.ts`    | M          |
| Extract `useChatMessages`                               | New `hooks/useChatMessages.ts`   | L          |
| Extract `useChatConnection`                             | New `hooks/useChatConnection.ts` | M          |
| Extract `usePermission`                                 | New `hooks/usePermission.ts`     | S          |
| Reduce `ChatView.tsx` to composition and JSX (~100 LOC) | `ChatView.tsx`                   | M          |

### 2.3 Refactor `FileViewer.tsx`

`FileViewer.tsx` at 303 LOC mixes three responsibilities: directory browsing, file viewing/markdown rendering, and edit state machine.

| Extract                                 | Into                         |
| --------------------------------------- | ---------------------------- |
| Directory and file fetching, navigation | `hooks/useFileNavigation.ts` |
| Edit state machine                      | `hooks/useFileEditor.ts`     |

| Task                                   | Files Affected   | Complexity |
| -------------------------------------- | ---------------- | ---------- |
| Extract `useFileNavigation`            | New file         | M          |
| Extract `useFileEditor`                | New file         | M          |
| Reduce `FileViewer.tsx` to composition | `FileViewer.tsx` | M          |

### 2.4 State Management — ChatView Reducer

The 10+ interdependent state variables in `ChatView` create implicit state machine behavior with no enforced invariants. After hook extraction, `useChatMessages` manages its slice via `useReducer` rather than multiple `useState` calls. The WebSocket message handler `switch` statement already has the shape of a reducer — formalize it.

| Task                                                      | Files Affected             | Complexity |
| --------------------------------------------------------- | -------------------------- | ---------- |
| Define `ChatMessagesState` and `ChatMessagesAction` types | `hooks/useChatMessages.ts` | S          |
| Implement `chatMessagesReducer`                           | `hooks/useChatMessages.ts` | M          |
| Replace `useState` calls with `useReducer`                | `hooks/useChatMessages.ts` | M          |

### 2.5 Make Tool Tiers Data-Driven

Move tool tier configuration to a format extensible from `.mitzo.json` without code changes.

| Task                                        | Files Affected                    | Complexity |
| ------------------------------------------- | --------------------------------- | ---------- |
| Define `ToolTierConfig` interface           | `tool-tiers.ts`                   | S          |
| Accept optional overrides from `RepoConfig` | `tool-tiers.ts`, `repo-config.ts` | M          |
| Add validation for override values          | `repo-config.ts`                  | S          |

### Phase 2 Success Criteria

- [ ] `chat.ts` reduced from 575 LOC to <300 (orchestrator + imports only)
- [ ] `ChatView.tsx` reduced from 542 LOC to <150 (composition + JSX only)
- [ ] `FileViewer.tsx` reduced from 305 LOC to <120
- [ ] `startChat()` split into 5+ named functions, each independently testable
- [ ] `buildPermissionHandler` in its own module with its own test file
- [ ] `ChatView` state managed via `useReducer` with typed actions — no implicit state machine
- [ ] Thinking block state (`thinkingBuf`, finalization logic) encapsulated in reducer, not inline
- [ ] Tool tier overrides work from `.mitzo.json` without code changes
- [ ] All 151+ existing tests still pass after every extraction

---

## Phase 3: Testing — Frontend Components, Routes, Integration

**Priority: High. Locks in correctness before Phase 4 refactors types.**
**Goal:** Meaningful coverage at every layer; test patterns for future contributors.

### 3.1 Frontend Component Tests

`MessageBubble.test.ts` already exists with 2 tests. Extend coverage to remaining components.

| Component                | Test Scope                                                          | Status                  |
| ------------------------ | ------------------------------------------------------------------- | ----------------------- |
| `MessageBubble`          | Renders user/assistant/tool roles; newline formatting               | Partial (2 tests exist) |
| `PermissionBanner`       | Renders tiers correctly; calls `onRespond` with correct args; timer | Not started             |
| `ToolGroup` / `ToolPill` | Grouping renders correctly; expand/collapse; raw input display      | Not started             |
| `ThinkingBlock`          | Expand/collapse; streaming vs finalized state                       | Not started             |
| `ChatInput`              | Send on Enter; disabled when running; image paste; attachment limit | Not started             |
| `ErrorBoundary`          | Catches render errors; shows fallback                               | Not started             |

| Task                                                                      | Files Affected                       | Complexity |
| ------------------------------------------------------------------------- | ------------------------------------ | ---------- |
| Extend existing MessageBubble tests; add tests for remaining 5 components | `frontend/src/components/__tests__/` | M          |

### 3.2 Custom Hook Tests

After Phase 2 hook extraction, write `renderHook` tests for each hook.

| Hook                | Key Test Cases                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `useChatMessages`   | `text_delta` streaming; `done`; `error` with session-expired path; `tool_call` + `tool_result` pairing |
| `useChatSession`    | Persists session ID to localStorage; restores from cache; falls back to API fetch                      |
| `useChatConnection` | Reports `connected` state correctly; reconnect flow                                                    |
| `usePermission`     | Sets/clears permission; timeout clears correctly                                                       |

| Task             | Files Affected                  | Complexity |
| ---------------- | ------------------------------- | ---------- |
| Write hook tests | `frontend/src/hooks/__tests__/` | L          |

### 3.3 Server Route Tests

`index.ts` is currently untested. Add integration tests using `supertest`.

| Route                                  | Test Cases                                                               |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `POST /api/permission/:permId/respond` | Valid token + decision; invalid token; invalid decision; unknown permId  |
| `GET /api/sessions`                    | Authenticated returns array; unauthenticated returns 401                 |
| `GET /api/files`                       | Allowed path returns entries; path traversal returns 403                 |
| `GET /api/files/read`                  | Reads file; nonexistent returns 404; disallowed path returns 403         |
| `PUT /api/files/write`                 | Writes file; missing body fields return 400; disallowed path returns 403 |

| Task                                                               | Files Affected                    | Complexity |
| ------------------------------------------------------------------ | --------------------------------- | ---------- |
| Add `supertest` to devDependencies                                 | `package.json`                    | S          |
| Refactor `index.ts` to export `app` separately from server startup | `index.ts`                        | S          |
| Write route tests                                                  | `server/__tests__/routes.test.ts` | M          |

### 3.4 WebSocket Integration Tests

The full chat lifecycle has never been tested end-to-end. Use `ws` client library in tests against a real server instance.

| Scenario                         | Test                      |
| -------------------------------- | ------------------------- |
| Connect and receive `client_id`  | WS handshake              |
| Send `stop` while idle           | No error                  |
| Unauthenticated WS upgrade       | Returns 401               |
| Reattach with invalid `clientId` | Returns `reattach_failed` |

| Task                                           | Files Affected                            | Complexity |
| ---------------------------------------------- | ----------------------------------------- | ---------- |
| Create WS integration test harness             | `server/__tests__/ws.integration.test.ts` | L          |
| Mock SDK `query` for controllable WS scenarios | Same                                      | M          |

### Phase 3 Success Criteria

- [ ] Frontend component test files cover all 7 components (MessageBubble, PermissionBanner, ToolGroup, ToolPill, ThinkingBlock, ChatInput, ErrorBoundary)
- [ ] Custom hook tests exist for all 4 extracted hooks
- [ ] Route-layer tests cover all HTTP endpoints via `supertest`
- [ ] WebSocket integration tests cover connect, stop, auth, and reattach flows
- [ ] Total test count exceeds 200 (from current 151)
- [ ] `index.ts` exports `app` separately from server startup (testability gate)

---

## Phase 4: Type Safety and Validation — Zod, Remove `any`, API Contracts

**Priority: Medium-High. Required for production reliability.**

### 4.1 Runtime Validation of WebSocket Messages (Server)

Incoming WS messages are parsed with `JSON.parse` and fields accessed directly. Any malformed payload can trigger silent failures.

| Task                                                | Files Affected             | Complexity |
| --------------------------------------------------- | -------------------------- | ---------- |
| Add `zod` to server dependencies                    | `package.json`             | S          |
| Define schemas for all incoming WS message types    | New `server/ws-schemas.ts` | M          |
| Apply `safeParse` in `handleChatWs` message handler | `index.ts`                 | M          |

### 4.2 Runtime Validation of HTTP Request Bodies

| Task                                                         | Files Affected              | Complexity |
| ------------------------------------------------------------ | --------------------------- | ---------- |
| Define Zod schemas for request bodies                        | New `server/api-schemas.ts` | M          |
| Apply `safeParse` in route handlers; return typed 400 errors | `index.ts`                  | M          |

### 4.3 Remove `any` from `session-registry.ts`

`queryInstance?: any` — import the correct SDK type or define a minimal interface.

| Task                                            | Files Affected        | Complexity |
| ----------------------------------------------- | --------------------- | ---------- |
| Replace `queryInstance?: any` with correct type | `session-registry.ts` | S          |

### 4.4 Type the Frontend WS Message Handler

Define a discriminated union for all server-to-client WebSocket messages.

| Task                                       | Files Affected                      | Complexity |
| ------------------------------------------ | ----------------------------------- | ---------- |
| Define `ServerMessage` discriminated union | `frontend/src/types/ws-messages.ts` | M          |
| Apply type guard in `ws-pool.ts` or hook   | `ws-pool.ts`, `useChatMessages.ts`  | M          |

### 4.5 Shared Type Package

`ToolTier`, model IDs, and WS message types are duplicated between server and frontend. The model catalog is particularly fragile — `AVAILABLE_MODELS` in `chat.ts` and hardcoded `<option>` values in `ChatView.tsx` must be kept in sync manually. A `shared/` workspace package eliminates drift.

| Task                                                                                             | Files Affected                                  | Complexity |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------- |
| Create `shared/` workspace package with `tsconfig.json`                                          | New `shared/` directory                         | M          |
| Move `ToolTier`, model catalog, and WS message types to `shared/`                                | `shared/src/types.ts`                           | M          |
| Update `tsconfig.json` and `package.json` for workspace references                               | Root, `server/`, `frontend/`                    | M          |
| Replace `AVAILABLE_MODELS` in `chat.ts` and `<option>` list in `ChatView.tsx` with shared import | `chat.ts`, `ChatView.tsx`                       | M          |
| Replace local type definitions with `shared/` imports                                            | `tool-tiers.ts`, `ws-pool.ts`, `ws-messages.ts` | M          |
| Add `shared/` build step to CI                                                                   | `.github/workflows/ci.yml`                      | S          |

**Note:** `zod` is already available in `mcp-server/package.json`. The shared package can re-export Zod schemas that serve as both runtime validators (server) and type sources (frontend via `z.infer`), making 4.1–4.4 schemas reusable without duplication.

### Phase 4 Success Criteria

- [ ] Production `any` count reduced from 5 to 0
- [ ] All incoming WS messages validated via Zod `safeParse` before processing
- [ ] All HTTP request bodies validated via Zod — malformed payloads return typed 400 errors
- [ ] `ServerMessage` discriminated union covers all WS message types on the frontend
- [ ] `shared/` package exists and is consumed by both `server/` and `frontend/`
- [ ] No type definitions duplicated between server and frontend

---

## Phase 5: Security Hardening

**Priority: Medium. Required before any public-facing deployment.**

### 5.1 Rate Limiting

| Endpoint                               | Risk                        | Recommended Limit         |
| -------------------------------------- | --------------------------- | ------------------------- |
| `POST /api/auth/login`                 | Brute force passphrase      | 5 req/min per IP          |
| `POST /api/permission/:permId/respond` | Replay on permission tokens | 10 req/min per IP         |
| WebSocket upgrade                      | Connection exhaustion       | 10 connections/min per IP |

| Task                                                    | Files Affected | Complexity |
| ------------------------------------------------------- | -------------- | ---------- |
| Add `express-rate-limit`                                | `package.json` | S          |
| Apply limiters to login, permission/respond, WS upgrade | `index.ts`     | M          |

### 5.2 Notification Token Exposure

The NTFY auth token is in action URLs as a query parameter — visible in server access logs and HTTP referrer headers. Pushover (`pushover.ts`) reuses the same `NTFY_AUTH_TOKEN` for its deep-link URLs, doubling the exposure surface.

| Task                                                                   | Files Affected                             | Complexity |
| ---------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| Replace query-param token with HMAC-signed, time-limited action tokens | `notify.ts`, `pushover.ts`, `index.ts`     | M          |
| Use a separate `ACTION_SECRET` distinct from `NTFY_AUTH_TOKEN`         | `notify.ts`, `pushover.ts`, `.env.example` | S          |

### 5.3 CSRF Protection

`sameSite: 'strict'` cookies provide partial protection. Explicit CSRF token validation needed for state-mutating endpoints.

| Task                                                                            | Files Affected | Complexity |
| ------------------------------------------------------------------------------- | -------------- | ---------- |
| Add CSRF token validation for `PUT /api/files/write` and `DELETE /api/sessions` | `index.ts`     | M          |

### 5.4 Request Size Limits

`express.json()` has no `limit` option — open to large payload attacks.

| Task                                   | Files Affected | Complexity |
| -------------------------------------- | -------------- | ---------- |
| Set `express.json({ limit: '10mb' })`  | `index.ts`     | S          |
| Set smaller limit for non-image routes | `index.ts`     | S          |

### 5.5 Security Headers

| Task                                 | Files Affected | Complexity |
| ------------------------------------ | -------------- | ---------- |
| Add `helmet` to dependencies         | `package.json` | S          |
| Configure CSP, HSTS, X-Frame-Options | `index.ts`     | M          |

### Phase 5 Success Criteria

- [ ] `express-rate-limit` applied to login, permission, and WS upgrade endpoints
- [ ] NTFY action URLs use HMAC-signed time-limited tokens (not raw auth token)
- [ ] CSRF token validation on all state-mutating endpoints
- [ ] `express.json()` has explicit `limit` set (10MB for image routes, 1MB default)
- [ ] `helmet` configured with CSP, HSTS, and X-Frame-Options
- [ ] Security scan of the hardened app produces no high/critical findings

---

## Phase 6: CI/CD Enhancement

**Priority: Medium. Continuous quality gate.**

### 6.1 End-to-End Tests with Playwright

| Flow            | Scenario                                              |
| --------------- | ----------------------------------------------------- |
| Login           | Correct passphrase → authenticated; wrong → error     |
| New chat        | Send message → streaming text appears → done state    |
| File viewer     | Navigate directories → open file → view content       |
| Permission flow | Mock permission request → Allow Once → chat continues |

| Task                                             | Files Affected                             | Complexity |
| ------------------------------------------------ | ------------------------------------------ | ---------- |
| Add `@playwright/test`                           | `package.json`                             | S          |
| Create `e2e/` with fixtures and page objects     | New directory                              | M          |
| Add `test:e2e` script; add Playwright step to CI | `package.json`, `.github/workflows/ci.yml` | M          |

### 6.2 Security Scanning

| Scan Type                  | Tool                                       | Trigger        |
| -------------------------- | ------------------------------------------ | -------------- |
| Dependency vulnerabilities | `npm audit`                                | Every PR       |
| Secret detection           | `trufflesecurity/trufflehog` or `gitleaks` | Every push     |
| SAST                       | `semgrep` or CodeQL                        | Weekly + on PR |

| Task                                     | Files Affected                   | Complexity |
| ---------------------------------------- | -------------------------------- | ---------- |
| Add `npm audit --audit-level=high` to CI | `.github/workflows/ci.yml`       | S          |
| Add secret scanning action               | `.github/workflows/ci.yml`       | S          |
| Add SAST action                          | `.github/workflows/security.yml` | M          |

### 6.3 Bundle Size Tracking

No size budget currently. A 1MB JS bundle on a mobile connection is a UX failure.

| Task                                           | Files Affected                  | Complexity |
| ---------------------------------------------- | ------------------------------- | ---------- |
| Add `size-limit` to frontend devDependencies   | `frontend/package.json`         | S          |
| Set budgets (e.g., main chunk < 200KB gzipped) | New `frontend/.size-limit.json` | S          |
| Add size check to CI                           | `.github/workflows/ci.yml`      | S          |

### 6.4 Test Coverage Reporting

| Task                                                | Files Affected             | Complexity |
| --------------------------------------------------- | -------------------------- | ---------- |
| Add `--coverage` to `vitest run` with `v8` provider | `vitest.config.ts`         | S          |
| Upload coverage to Codecov                          | `.github/workflows/ci.yml` | S          |
| Set coverage thresholds for new code                | `vitest.config.ts`         | M          |

### 6.5 Deployment Hardening

Mitzo runs on a single host via `pm2`. `scripts/deploy.sh` already handles `git pull --ff-only`, `npm install`, `npm run build`, and `pm2 restart mitzo` with a delayed restart to avoid self-kill. The foundation exists — harden it.

| Task                                                                 | Files Affected             | Complexity |
| -------------------------------------------------------------------- | -------------------------- | ---------- |
| Add health check endpoint (`GET /health`)                            | `index.ts`                 | S          |
| Add pre-deploy CI gate (deploy only if CI green)                     | `.github/workflows/ci.yml` | M          |
| Add rollback to `deploy.sh` (stash current hash, restore on failure) | `scripts/deploy.sh`        | S          |
| Add `pm2` ecosystem config for consistent process management         | New `ecosystem.config.cjs` | S          |
| Document deployment and rollback procedures                          | `docs/deployment.md`       | M          |

### Phase 6 Success Criteria

- [ ] Playwright e2e tests cover login, chat, file viewer, and permission flows
- [ ] `npm audit --audit-level=high` runs on every PR and blocks on findings
- [ ] Secret scanning active on every push
- [ ] Frontend bundle size tracked with `size-limit` — main chunk < 200KB gzipped
- [ ] Test coverage reported to Codecov with thresholds for new code
- [ ] Merge to `main` triggers: build → test → deploy to staging → manual gate → production
- [ ] Rollback documented and scripted — recoverable within 5 minutes

---

## Scope Boundaries

This plan addresses production-hardening of the existing Mitzo architecture. The following are explicitly **out of scope**:

| Not Addressed                        | Why                                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Feature development                  | This is an engineering quality plan, not a product roadmap. Features resume after Phase 1–2 remove the risk of adding them. |
| Multi-user / multi-tenant            | Mitzo is a single-user tool. Auth exists to protect the exposed endpoint, not to manage user accounts.                      |
| Horizontal scaling                   | Single-host deployment. No load balancer, no database, no distributed state.                                                |
| Migration to a different framework   | Express + React 19 is the stack. This plan hardens it, not replaces it.                                                     |
| Mobile app (native)                  | Mitzo is mobile-first web, not a native app. PWA enhancements could follow Phase 6 but are not planned here.                |
| Monitoring / alerting infrastructure | Structured logging (Phase 1) is the prerequisite. Grafana/Prometheus/etc. is a future layer on top.                         |
| Performance optimization             | No evidence of performance problems at current scale. Profiling would follow observability (Phase 1).                       |

---

## Constants Centralization Plan

### Server — `server/constants.ts`

| Constant                     | Current Value      | Current Location(s)                         |
| ---------------------------- | ------------------ | ------------------------------------------- |
| `DETACHED_TTL_MS`            | `600_000` (10 min) | `session-registry.ts` (named, move here)    |
| `PERMISSION_TIMEOUT_MS`      | `120_000` (2 min)  | `chat.ts` (anonymous inline)                |
| `NTFY_NOTIFICATION_DELAY_MS` | `10_000` (10 sec)  | `chat.ts` (anonymous inline)                |
| `TOOL_RESULT_MAX_CHARS`      | `10_000`           | `chat.ts`, `content-blocks.ts` (duplicated) |
| `NOTIFY_INPUT_MAX_CHARS`     | `100`              | `notify.ts`                                 |
| `TOOL_SUMMARY_MAX_CHARS`     | `200`              | `tool-summary.ts` (used twice)              |
| `WORKTREE_BRANCH_PREFIX`     | `'session/'`       | `worktree.ts` (named, move here)            |
| `WORKTREE_STALE_HOURS`       | `168` (7 days)     | `worktree.ts` (named, move here)            |
| `WORKTREE_GIT_TIMEOUT_MS`    | `30_000`           | `worktree.ts` (inline)                      |
| `GIT_BRANCH_TIMEOUT_MS`      | `5_000`            | `chat.ts`, `index.ts` (duplicated)          |
| `SESSION_LIST_LIMIT`         | `20`               | `chat.ts` (duplicated)                      |
| `SESSION_MESSAGES_LIMIT`     | `100`              | `chat.ts`                                   |
| `HEARTBEAT_INTERVAL_MS`      | `15_000`           | `index.ts`                                  |
| `PORT_DEFAULT`               | `3100`             | `index.ts`                                  |

### Frontend — `frontend/src/lib/constants.ts`

| Constant                  | Current Value          | Current Location(s)                            |
| ------------------------- | ---------------------- | ---------------------------------------------- |
| `WS_RECONNECT_DELAY_MS`   | `500`                  | `ws-pool.ts` (`onclose` handler, inline)       |
| `WS_RECONNECT_POLL_MS`    | `5000`                 | `ws-pool.ts` (`reconnectAll` interval, inline) |
| `WS_MAX_BUFFER_SIZE`      | `500`                  | `ws-pool.ts` (`MAX_BUFFER_SIZE`, export here)  |
| `TOOL_GROUP_THRESHOLD`    | `3`                    | `groupMessages.ts`                             |
| `SCROLL_NEAR_BOTTOM_PX`   | `150`                  | `ChatView.tsx`                                 |
| `CHAT_CACHE_KEY_PREFIX`   | `'mitzo-chat-'`        | `ChatView.tsx` (duplicated)                    |
| `LAST_SESSION_KEY`        | `'mitzo-last-session'` | `ChatView.tsx`                                 |
| `MAX_IMAGE_ATTACHMENTS`   | `4`                    | `ChatInput.tsx` (`MAX_IMAGES`, export here)    |
| `DEFAULT_MODEL`           | `'claude-sonnet-4-6'`  | `ChatView.tsx`                                 |
| `SCROLL_RESTORE_DELAY_MS` | `100`                  | `ChatView.tsx` (inline setTimeout)             |

---

## ChatView Hook Extraction Plan

Signatures only. Implementation not in scope until execution is requested.

### Hook 1: `useChatSession`

**Responsibility:** Session identity, localStorage persistence, message cache restoration, model selection.

```typescript
// frontend/src/hooks/useChatSession.ts

interface ChatSessionState {
  currentSessionId: string | undefined;
  model: string;
  mode: 'ask' | 'agent' | 'auto';
  sandbox: boolean;
}

interface ChatSessionActions {
  setCurrentSessionId: (id: string | undefined) => void;
  setModel: (model: string) => void;
  setMode: (mode: 'ask' | 'agent' | 'auto') => void;
  setSandbox: (sandbox: boolean) => void;
}

function useChatSession(
  sessionId: string | undefined,
  initialMode: 'ask' | 'agent' | 'auto',
): [ChatSessionState, ChatSessionActions, poolKey: string];
```

**Owns:** `currentSessionId`, `model`, `mode`, `sandbox`, `newSessionUid` ref, `poolKey` derivation, localStorage persistence.
**Does not own:** Messages, WebSocket connection state, permission state.

---

### Hook 2: `useChatMessages`

**Responsibility:** Full message list, streaming buffer, all WS message-type handlers that mutate message state. Internally uses `useReducer`.

```typescript
// frontend/src/hooks/useChatMessages.ts

interface ChatMessagesState {
  messages: Message[];
  running: boolean;
  permission: PermissionRequest | null;
  branch: string | null;
  isWorktree: boolean;
}

type ChatMessagesAction =
  | { type: 'THINKING_START' }
  | { type: 'THINKING_DELTA'; text: string }
  | { type: 'TEXT_DELTA'; text: string }
  | { type: 'TEXT'; text: string }
  | { type: 'TOOL_CALL'; toolName: string; toolId: string; input: string; rawInput?: RawToolInput }
  | { type: 'TOOL_RESULT'; toolId: string; result: string }
  | { type: 'PERMISSION_REQUEST'; payload: PermissionRequest }
  | { type: 'PERMISSION_TIMEOUT'; permId: string }
  | { type: 'DONE'; sessionId?: string }
  | { type: 'ERROR'; error: string; sessionId?: string }
  | { type: 'SESSION_INFO'; branch: string; isWorktree: boolean }
  | { type: 'RESTORE'; messages: Message[] }
  | { type: 'USER_SEND'; text: string; images?: string[] };

function useChatMessages(
  poolKey: string,
  currentSessionId: string | undefined,
  onSessionAssigned: (id: string) => void,
  onNavigate: (path: string) => void,
): {
  state: ChatMessagesState;
  dispatch: React.Dispatch<ChatMessagesAction>;
  pendingSend: React.MutableRefObject<Record<string, unknown> | null>;
};
```

**Owns:** `messages`, `running`, `permission`, `branch`, `isWorktree`, `streamBuf` ref, the full `switch (msg.type)` dispatch in the WS subscriber.
**Does not own:** Connection state, session identity, `poolKey`.

---

### Hook 3: `useChatConnection`

**Responsibility:** WebSocket subscription lifecycle, connection status, draining buffered messages on mount.

```typescript
// frontend/src/hooks/useChatConnection.ts

function useChatConnection(
  poolKey: string,
  onMessage: (msg: WsMsg) => void,
): {
  connected: boolean;
};
```

**Owns:** `connected` state, the `wsSubscribe` + `wsDrainBuffer` effect.
**Does not own:** What to do with messages — delegates to `onMessage`.

---

### Hook 4: `usePermission`

**Responsibility:** Encapsulate the `handlePermission` callback.

```typescript
// frontend/src/hooks/usePermission.ts

function usePermission(
  poolKey: string,
  onClear: () => void,
): {
  handlePermission: (
    permId: string,
    decision: 'once' | 'always' | 'deny',
    toolName: string,
  ) => void;
};
```

**Owns:** Sending the `permission_response` WS message.
**Does not own:** Permission state storage (stays in `useChatMessages`).

---

### Resulting `ChatView.tsx`

After extraction, `ChatView.tsx` becomes ~100 LOC — a composition component with JSX only.

```typescript
// frontend/src/pages/ChatView.tsx

export function ChatView() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [sessionState, sessionActions, poolKey] = useChatSession(
    sessionId,
    searchParams.get('extraTools') ? 'auto' : 'agent',
  );

  const { state: msgState, dispatch, pendingSend } = useChatMessages(
    poolKey,
    sessionState.currentSessionId,
    sessionActions.setCurrentSessionId,
    (path) => navigate(path, { replace: true }),
  );

  const { connected } = useChatConnection(poolKey, (msg) =>
    dispatch(/* translated action */),
  );

  const { handlePermission } = usePermission(poolKey, () =>
    dispatch({ type: 'PERMISSION_TIMEOUT', permId: msgState.permission?.permId ?? '' }),
  );

  // sendMessage, handleStop, handleModeChange stay here —
  // they coordinate multiple hooks but are not large enough to extract further.

  const grouped = useMemo(() => groupMessages(msgState.messages), [msgState.messages]);

  return ( /* JSX only */ );
}
```

---

## Implementation Sequencing

```
Phase 1 (Foundation)
  ├── 1.1 Constants ──────────────────────────────────┐
  ├── 1.2 Structured Logging                          │
  ├── 1.3 Silent catch fixes                          │
  ├── 1.4 Error Boundaries                            │
  └── 1.5 Fix notify test                             │
                                                      ▼
Phase 2 (Modularization)
  ├── 2.1 Split startChat
  ├── 2.2 ChatView hooks ──────────────────────────────┐
  ├── 2.3 FileViewer hooks                             │
  ├── 2.4 Reducer for messages                         │
  └── 2.5 Tool tiers config                           │
                                                      ▼
Phase 3 (Testing)                     Phase 4 (Type Safety) ← parallel
  ├── 3.1 Component tests               ├── 4.1 Zod WS schemas
  ├── 3.2 Hook tests                    ├── 4.2 Zod HTTP schemas
  ├── 3.3 Route tests                   ├── 4.3 Remove any
  └── 3.4 WS integration tests          └── 4.4 Typed WS messages

Phase 5 (Security) ← parallel with 3+4
  ├── 5.1 Rate limiting
  ├── 5.2 NTFY token URL
  ├── 5.3 CSRF
  ├── 5.4 Request size limits
  └── 5.5 Security headers

Phase 6 (CI/CD) ← after Phase 3
  ├── 6.1 Playwright e2e
  ├── 6.2 Security scanning
  ├── 6.3 Bundle size tracking
  ├── 6.4 Coverage reporting
  └── 6.5 Deployment step
```

---

## Effort Summary

| Phase         | Title              | Estimated Effort | Unlocks                | Status       |
| ------------- | ------------------ | ---------------- | ---------------------- | ------------ |
| 1             | Foundation         | 3–5 days         | Everything             | **COMPLETE** |
| 2             | Modularization     | 5–8 days         | Phases 3, 4            | Next         |
| 3             | Testing            | 7–10 days        | Phase 6 CI gates       | Pending      |
| 4             | Type Safety        | 4–6 days         | Production reliability | Pending      |
| 5             | Security Hardening | 3–5 days         | Production deployment  | Pending      |
| 6             | CI/CD Enhancement  | 3–5 days         | Continuous quality     | Pending      |
| **Remaining** |                    | **22–34 days**   |                        |              |

Phases 3, 4, and 5 can be parallelized after Phase 2 completes, reducing wall-clock time to approximately 12–17 days remaining.

---

## Risk Register

| Risk                                                              | Likelihood   | Impact | Mitigation                                                                 |
| ----------------------------------------------------------------- | ------------ | ------ | -------------------------------------------------------------------------- |
| Hook extraction introduces subtle state ordering bugs             | Medium       | High   | Extract one hook at a time; full manual smoke test after each              |
| Thinking block state transitions break during extraction          | Medium       | High   | `thinkingBuf` finalization logic is complex; test explicitly in reducer    |
| Parallel AI sessions create merge conflicts on shared files       | **Realized** | Medium | Established: all work on branches, CI-green before merge, rebase workflow  |
| AI sessions push to main bypassing CI                             | **Realized** | High   | Fixed: `.cursor/rules/ci-discipline.mdc`, branch protection, no exceptions |
| CI failure hides downstream results (tests never run)             | **Realized** | High   | Fixed: `if: always()` on typecheck/test/build steps, summary step          |
| Zod schemas break existing clients during Phase 4                 | Low          | Medium | Use `safeParse` returning 400, not throwing; monitor for 1 week            |
| Rate limiting blocks legitimate mobile users with dynamic IPs     | Low          | Medium | Start conservative limits; loosen based on monitoring                      |
| Notification token rotation requires coordinating ntfy + Pushover | Medium       | Low    | Document rotation procedure; use shared `ACTION_SECRET`                    |
| Playwright e2e tests are flaky in CI                              | Medium       | Medium | Use `--retries=2`; fix flaky tests before adding to required PR gate       |
