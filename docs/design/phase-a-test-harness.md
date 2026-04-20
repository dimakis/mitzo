# Phase A: Test Harness — Build the Safety Net Before the Refactor

**Status:** In progress
**Date:** 2026-04-03
**Author:** Claude (with Dimitri)

---

## Motivation

Mitzo v0.1.1 has 209 tests across 22 files. They're strong unit tests on extracted modules (query-loop, reducer, tool-tiers, auth, session-registry, etc.), but `index.ts` — the 454-LOC nerve center that wires every route, the WebSocket handler, auth middleware, file APIs, and startup sequence — has **zero tests**.

Refactoring `index.ts` without route tests, WS integration tests, and e2e coverage is refactoring blind. This document specifies the test harness that must exist before any structural changes to the server entry point.

### What We're Protecting

- 17 HTTP endpoints across auth, sessions, files, config, and permissions
- WebSocket upgrade + chat handler (reattach, send, interrupt, stop)
- Auth middleware ordering (permission route before global auth — order-dependent)
- File path validation (`isAllowedPath`, `resolveRoot`)
- 7 frontend components with 1 existing test file (MessageBubble, 2 cases)
- 4 extracted hooks with 0 dedicated test files (reducer tested separately)
- 0 end-to-end tests

---

## Test Infrastructure

### New Dependencies

**Root `package.json` (devDependencies):**

- `supertest` — HTTP route testing against the Express app
- `@types/supertest` — TypeScript types

**Frontend `package.json` (devDependencies):**

- `@testing-library/react` — component rendering and queries
- `@testing-library/jest-dom` — DOM matchers
- `@testing-library/user-event` — user interaction simulation
- `jsdom` — browser environment for Vitest

**Root (separate install, not in main package.json):**

- `@playwright/test` — e2e tests (installed via `npx playwright install`)

### Vitest Configuration

Current `vitest.config.ts` is minimal — only sets auth env vars. Update to a workspace configuration that splits server (node) and frontend (jsdom) environments:

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      AUTH_PASSPHRASE: 'test-passphrase-for-vitest',
      AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-for-hs256',
      COOKIE_MAX_AGE_HOURS: '1',
    },
  },
});

// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'server',
      include: ['server/__tests__/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'frontend',
      include: ['frontend/src/**/__tests__/**/*.test.ts'],
      environment: 'jsdom',
    },
  },
]);
```

### Convention Alignment

| Area             | Convention                                   | Rationale                                    |
| ---------------- | -------------------------------------------- | -------------------------------------------- |
| Server imports   | `.js` extensions                             | Match existing ESM pattern (`../auth.js`)    |
| Frontend imports | Extensionless                                | Match existing pattern (`../MessageBubble`)  |
| Server mocks     | `vi.mock('./module.js')` + `vi.fn()`         | Match `query-loop.test.ts` patterns          |
| Frontend mocks   | `vi.mock('module')` before imports           | Match `MessageBubble.test.ts` pattern        |
| Component tests  | `@testing-library/react` `render` + `screen` | New convention for new tests                 |
| Hook tests       | `@testing-library/react` `renderHook`        | New convention                               |
| Existing tests   | Untouched                                    | New conventions layer alongside, not replace |

---

## `app.ts` Extraction (Test-Enabling)

The smallest possible change to make route testing possible. NOT the full `index.ts` breakup.

### What Moves

`server/app.ts` (new file) exports the Express `app` with all route registrations:

- `express()` + `express.json()` + `cookieParser()`
- All route handlers (version, permission, auth, models, config, sessions, files, git, worktrees)
- Auth middleware (`app.use('/api', authMiddleware)`)
- Static file serving + SPA fallback
- Helper functions: `isAllowedPath`, `resolveRoot`, `getGitBranch`

### What Stays in `index.ts`

- `import { app } from './app.js'`
- `createServer(app)` + WebSocket server setup
- `server.on('upgrade', ...)` + `handleChatWs`
- `checkPort` + `server.listen()` + startup cleanup + update check interval

### Why This Split

`supertest` needs `app` without `server.listen()`. The WS handler can't be tested with supertest anyway (needs real ws client), so it stays in `index.ts` for now.

---

## Route-Layer Tests

**File:** `server/__tests__/routes.test.ts`

### Mock Strategy

```typescript
vi.mock('../chat.js', () => ({
  getSessions: vi.fn().mockResolvedValue([]),
  getMessages: vi.fn().mockResolvedValue([]),
  hideSession: vi.fn(),
  hideAllSessions: vi.fn(),
  BASE_REPO: '/tmp/test-repo',
  repoConfig: { quickActions: [], allowedPaths: [], resolvedVenvPaths: [], toolTierOverrides: {} },
  getMcpServerNames: vi.fn().mockReturnValue([]),
  AVAILABLE_MODELS: [{ id: 'test-model', label: 'Test', desc: 'Test' }],
  registry: { get: vi.fn() },
}));

vi.mock('../permissions.js', () => ({
  resolvePending: vi.fn().mockReturnValue(true),
}));
```

### Test Cases

**Auth routes (4 tests):**

| Test                  | Method | Path               | Setup                     | Assert                    |
| --------------------- | ------ | ------------------ | ------------------------- | ------------------------- |
| Login success         | POST   | `/api/auth/login`  | `{ passphrase: correct }` | 200, Set-Cookie `cc_auth` |
| Login failure         | POST   | `/api/auth/login`  | `{ passphrase: wrong }`   | 401                       |
| Logout                | POST   | `/api/auth/logout` | Auth cookie               | 200, cookie cleared       |
| Auth check (unauthed) | GET    | `/api/auth/check`  | No cookie                 | 401                       |

**Permission route (4 tests):**

| Test                   | Method | Path                                               | Setup                          | Assert |
| ---------------------- | ------ | -------------------------------------------------- | ------------------------------ | ------ |
| Valid token + decision | POST   | `/api/permission/p1/respond?token=X&decision=once` | `NTFY_AUTH_TOKEN=X`            | 200    |
| Invalid token          | POST   | `/api/permission/p1/respond?token=bad`             | —                              | 401    |
| Bad decision           | POST   | `/api/permission/p1/respond?token=X&decision=bad`  | —                              | 400    |
| Unknown permId         | POST   | `/api/permission/p1/respond?token=X&decision=once` | `resolvePending` returns false | 404    |

**Session routes (5 tests):**

| Test              | Method | Path                        | Assert                        |
| ----------------- | ------ | --------------------------- | ----------------------------- |
| List sessions     | GET    | `/api/sessions`             | 200, array                    |
| Unauthed sessions | GET    | `/api/sessions`             | 401                           |
| Get messages      | GET    | `/api/sessions/s1/messages` | 200, array                    |
| Hide session      | DELETE | `/api/sessions/s1`          | 200, `hideSession` called     |
| Clear sessions    | DELETE | `/api/sessions`             | 200, `hideAllSessions` called |

**File routes (8 tests):**

| Test               | Method | Path                                        | Setup                   | Assert             |
| ------------------ | ------ | ------------------------------------------- | ----------------------- | ------------------ |
| List dir           | GET    | `/api/files?dir=/tmp/test-repo`             | dir exists with entries | 200, entries array |
| Path traversal     | GET    | `/api/files?dir=/etc`                       | —                       | 403                |
| Dir not found      | GET    | `/api/files?dir=/tmp/test-repo/nope`        | dir missing             | 404                |
| Read file          | GET    | `/api/files/read?path=/tmp/test-repo/f.txt` | file exists             | 200, content       |
| Read disallowed    | GET    | `/api/files/read?path=/etc/passwd`          | —                       | 403                |
| Write file         | PUT    | `/api/files/write`                          | `{ path, content }`     | 200                |
| Write missing body | PUT    | `/api/files/write`                          | `{}`                    | 400                |
| Write disallowed   | PUT    | `/api/files/write`                          | path outside repo       | 403                |

**Config/info routes (4 tests):**

| Test              | Method | Path            | Assert                                        |
| ----------------- | ------ | --------------- | --------------------------------------------- |
| Version (no auth) | GET    | `/api/version`  | 200, `{ hash, commit, updateAvailable }`      |
| Models            | GET    | `/api/models`   | 200, array                                    |
| Config            | GET    | `/api/config`   | 200, `{ repoPath, mcpServers, quickActions }` |
| Git info          | GET    | `/api/git/info` | 200, `{ branch, repoPath, worktrees }`        |

**Total: ~25 tests**

---

## WebSocket Integration Tests

**File:** `server/__tests__/ws-integration.test.ts`

### Setup

Real HTTP server on random port (`server.listen(0)`). Real `ws` client. Chat functions mocked at module level.

```typescript
let server: Server;
let port: number;
let authCookie: string;

beforeAll(async () => {
  // Start server on random port
  server = createServer(app);
  // Set up WSS + upgrade handler
  await new Promise((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  // Get auth cookie via login
  authCookie = await getAuthCookie(port);
});

afterAll(() => server.close());
```

### Test Cases

**Connection lifecycle (4 tests):**

| Test       | Action                          | Assert                                       |
| ---------- | ------------------------------- | -------------------------------------------- |
| Connect    | WS to `/ws/chat` with cookie    | Receives `{ type: 'client_id' }`             |
| No auth    | WS to `/ws/chat` without cookie | Socket error/close (401)                     |
| Wrong path | WS to `/ws/other`               | Socket destroyed                             |
| Heartbeat  | Connect, wait                   | Ping received within `HEARTBEAT_INTERVAL_MS` |

**Chat flow (4 tests):**

| Test       | Send                                            | Assert                         |
| ---------- | ----------------------------------------------- | ------------------------------ |
| Start chat | `{ type: 'send', prompt: 'hello' }`             | `startChat` called with prompt |
| Follow-up  | `{ type: 'send', prompt: 'more' }` while active | `sendToChat` called            |
| Stop       | `{ type: 'stop' }`                              | `stopChat` called              |
| Interrupt  | `{ type: 'interrupt', prompt: 'hey' }`          | `interruptChat` called         |

**Reattach (3 tests):**

| Test                    | Send                                    | Assert                |
| ----------------------- | --------------------------------------- | --------------------- |
| Valid reattach          | `{ type: 'reattach', clientId: X }`     | `reattached` response |
| Invalid reattach        | `{ type: 'reattach', clientId: 'bad' }` | `reattach_failed`     |
| Disconnect while active | Close WS                                | `detachChat` called   |

**Error handling (2 tests):**

| Test         | Send                  | Assert              |
| ------------ | --------------------- | ------------------- |
| Invalid JSON | `not-json`            | `{ type: 'error' }` |
| Unknown type | `{ type: 'unknown' }` | No error, no crash  |

**Total: ~13 tests**

---

## Frontend Component Tests

### PermissionBanner (6 tests)

**File:** `frontend/src/components/__tests__/PermissionBanner.test.tsx`

- Renders tier badge with `perm-banner--elevated` class when tier is `'elevated'`
- Shows `title` when provided, falls back to `displayName`, then `toolName`
- "Allow Once" button calls `onRespond(permId, 'once', toolName)`
- "Always Allow" button calls `onRespond(permId, 'always', toolName)`
- "Deny" button calls `onRespond(permId, 'deny', toolName)`
- Auto-deny fires when timer reaches 0 (fake timers)

### ChatInput (6 tests)

**File:** `frontend/src/components/__tests__/ChatInput.test.tsx`

- Enter key calls `onSend` with text
- Shift+Enter does not send
- Send button disabled when text empty and no images
- Stop button visible when `running` is true
- `onSend` returning false keeps text in input
- Paste with image calls `extractImageFiles` and adds attachment

Mock: `vi.mock('../../lib/paste-images')`, `vi.mock('../../lib/resizeImage')`

### ThinkingBlock (4 tests)

**File:** `frontend/src/components/__tests__/ThinkingBlock.test.tsx`

- Shows "Thinking..." when `streaming` is true and block not done
- Shows "Thought" when block is done
- Shows "Reasoning redacted" for `redacted_thinking` blockType
- Returns null when content empty and not streaming

### ToolPill (3 tests)

**File:** `frontend/src/components/__tests__/ToolPill.test.tsx`

- Shows `tool-pill--running` class when not done
- Clicking header toggles expanded state
- Renders raw input detail for write-type tool

### ToolGroup (3 tests)

**File:** `frontend/src/components/__tests__/ToolGroup.test.tsx`

- Shows "N tool calls" label
- Auto-collapses when all tools complete (fake timers for useEffect)
- Shows `+N` when more than 8 tools

### ErrorBoundary (3 tests)

**File:** `frontend/src/components/__tests__/ErrorBoundary.test.tsx`

- Renders children when no error
- Shows error message when child throws
- "Try Again" button resets and re-renders children

**Total: ~25 component tests**

---

## Hook Tests

### useChatSession (4 tests)

**File:** `frontend/src/hooks/__tests__/useChatSession.test.ts`

- Returns stable `poolKey` across re-renders for new sessions
- Writes `currentSessionId` to localStorage
- `setModel` calls `setPreferredModel`
- `setMode` updates mode in state

Mock: `vi.mock('../../lib/model-preference')`

### useChatConnection (3 tests)

**File:** `frontend/src/hooks/__tests__/useChatConnection.test.ts`

- Sets `connected` true on `_open` message
- Sets `connected` false on `_close` message
- Calls `wsDrainBuffer` on mount

Mock: `vi.mock('../../lib/ws-pool')`

### usePermission (2 tests)

**File:** `frontend/src/hooks/__tests__/usePermission.test.ts`

- Calls `wsSend` with permission_response message
- Calls `onClear` after sending

Mock: `vi.mock('../../lib/ws-pool')`

**Total: ~9 hook tests**

---

## E2E Tests (Playwright)

**Directory:** `e2e/`

### Setup

```typescript
// playwright.config.ts
export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'npm run dev:server',
    port: 3100,
    reuseExistingServer: true,
  },
  retries: 2,
  use: {
    baseURL: 'http://localhost:3100',
  },
});
```

### Test Cases

**Login (2 tests):**

- Navigate to `/login`, enter correct passphrase, verify redirect to `/`
- Enter wrong passphrase, verify error message

**Chat (2 tests):**

- Send message, verify streaming text appears, verify completion
- Click stop button during generation, verify it stops

**File viewer (1 test):**

- Navigate to `/files`, click directory, click file, verify content displayed

**Total: 5 e2e tests**

---

## CI Updates

Add to `.github/workflows/ci.yml`:

1. `npm audit --audit-level=high` — blocks on known vulnerabilities
2. Update test count guard to ≥280 (from 200)
3. Playwright e2e step (separate from unit tests)
4. mcp-server build check (`cd mcp-server && npm ci && npm run build`)

---

## PR Sequence

| PR  | Branch                 | Depends On | Content                                    |
| --- | ---------------------- | ---------- | ------------------------------------------ |
| 1   | `test/infra-setup`     | —          | Dependencies, vitest workspace config      |
| 2   | `test/app-extract`     | PR 1       | `server/app.ts`, minimal `index.ts` change |
| 3   | `test/route-tests`     | PR 2       | `server/__tests__/routes.test.ts`          |
| 4   | `test/ws-integration`  | PR 2       | `server/__tests__/ws-integration.test.ts`  |
| 5   | `test/frontend-infra`  | PR 1       | Frontend test deps, jsdom env              |
| 6   | `test/component-tests` | PR 5       | 6 component test files                     |
| 7   | `test/hook-tests`      | PR 5       | 3 hook test files                          |
| 8   | `test/playwright-e2e`  | —          | Playwright config, 5 e2e tests             |
| 9   | `test/ci-updates`      | PRs 3-8    | CI workflow additions                      |

---

## Expected Outcome

| Metric          | Before            | After                   |
| --------------- | ----------------- | ----------------------- |
| Test files      | 22                | ~31                     |
| Test cases      | 209               | ~280+                   |
| Route coverage  | 0                 | All 17 HTTP endpoints   |
| WS integration  | 0                 | Full lifecycle          |
| Component tests | 2 (MessageBubble) | ~27 across 7 components |
| Hook tests      | 0 (reducer only)  | 9 across 3 hooks        |
| E2E tests       | 0                 | 5 critical paths        |
| CI steps        | 7                 | 10+                     |

After this lands, `index.ts` refactoring becomes safe.
