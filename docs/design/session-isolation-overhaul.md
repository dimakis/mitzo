# Session Isolation Overhaul — Design Doc

**Status:** Phase 1 implemented (PR #278, merged 2026-04-23). Phase 2 in progress (PR #280).
**Date:** 2026-04-22
**Author:** Claude Opus 4.6 + Dimitri
**Reviewed by:** Cursor agent (review artifacts were generated as Cursor canvases during the design session, not committed to the repo)
**Prior art:** Planning documents from earlier design sessions (local-only, not committed)

---

## Goal

5+ parallel Mitzo sessions working across 11 configured repos with zero conflicts:

- Zero session bleed (events from session A never appear in session B)
- Zero worktree collisions (concurrent sessions don't race on creation)
- Working executables in worktrees (`.venv`, `node_modules` discoverable)
- Reliable resume after disconnect, iOS background, or server restart
- Deterministic ownership (reconnect is passive; takeover is explicit)
- Full observability via Grafana (logs) + Jaeger (traces)

---

## Problems (confirmed from log forensics 2026-04-22)

### P1. Watch Accumulation → Session Bleed

`handleSwitchSession` in `server/ws-handler-v2.ts` L244-323 calls `connRegistry.setActive(connectionId, msg.sessionId)` at L292, which implicitly adds a watch. But it **never unwatches the previous session**. Unwatching only happens on `switch_session(null)` (L262-270). Over a browsing session, the connection accumulates watches for every session visited (confirmed: last connection in logs watched 5 sessions). All watched sessions broadcast events to the single WebSocket. The client-side filter (`store.ts` L644-658) has race windows that let foreign events through — especially during the null-`currentSessionId` gap between `newSession()` and receiving `session_id`.

On the client side, `MitzoConnection.seqBySession` (`packages/client/src/connection.ts` L29) tracks sequence numbers per session for reconnect replay. `clearSession()` exists at L105 but is **never called** from the store. So on every reconnect, the client sends a `reconnect` message listing every session it's ever seen, causing the server to re-watch all of them.

### P2. Reconnect Storm

388 total WS connections in one server lifecycle, only 6 completed v2 handshake. 382 fell to v1 after 5s `HANDSHAKE_TIMEOUT_MS` (`server/index.ts` L235). Two bursts: 191 in 197ms (pre-restart stale), 188 in 241ms (post-restart reconnect). These consume heartbeat timers and memory.

### P3. Worktree ID Collision

**[Fixed in Phase 1]** `generateWtId()` in `server/chat.ts` originally used `randomBytes(3)` (6 hex chars, 16M values). Concurrent sessions raced on the same date prefix. Fixed: now uses `randomUUID().replace(/-/g, '').slice(0, 12)` (12 hex chars, 4.8T values) with a `.mitzo-session` lockfile.

### P4. Missing Executables

Gitignored dirs (`.venv`, `node_modules`) don't exist in worktrees. Agents can't find Python, Node, etc. The `sdkEnv()` function in `server/chat.ts` L169-193 already prepends venv paths to `PATH`, but tools that resolve executables relative to CWD (e.g. `./node_modules/.bin/vitest`) still fail.

### P5. Stale Registry Entries

**[Fixed in Phase 1]** In `server/ws-handler-v2.ts`, `handleReconnect`, `handleSendV2`, and `handleInterruptV2` originally detected when EventStore said `is_active=false` but SessionRegistry had an entry, correcting a local variable but never calling `registry.remove()`. Fixed: all three sites now call `ctx.sessionRegistry.remove(found.clientId)` to evict stale entries immediately.

### P6. Resume Breaks

`resolveResumeCwd()` in `server/chat.ts` L87-114 falls back to `BASE_REPO` when the original worktree CWD is gone, but keeps `resume: sessionId`. The Claude SDK encodes session paths by CWD — when CWD doesn't match, it throws "No conversation found". The client parser (`packages/client/src/protocol-parser.ts` L344) matches this string and calls `onSessionExpired()`, which wipes messages and navigates away — jarring UX.

### P7. Eager Worktree Creation

`createSessionWorktrees()` in `server/chat.ts` L235-293 creates worktrees for ALL configured repos at session start. With 11 repos and 5 sessions = 55 worktree dirs, most never used. 449 accumulated dirs found on disk.

### P8. Observability Gap

`LOKI_HOST` is commented out in `.env` — Grafana has no log data. OTel tracing (`server/tracing.ts`) is configured but only 3 spans exist: `ws.send`, `ws.reconnect`, `ws.switch_session` in `server/ws-handler-v2.ts`. Zero coverage of query-loop, detach/reattach, resume, stale correction. The deep instrumentation roadmap at `docs/design/otel-deep-instrumentation.md` has not been implemented.

---

## Review Responses

The design was reviewed against the codebase (see `canvases/session-isolation-overhaul-review.canvas.tsx`). Five findings were raised. Each is addressed below.

### R1. (HIGH) Reconnect should stay passive — accepted

**Finding**: The original proposal forced takeover in `handleReconnect`, but reconnects are automatic (iOS foreground, network recovery). A stale background device could steal an actively-used session without user intent.

**Resolution**: Agreed. `handleReconnect` stays **passive**: reattach only if the owner connection is gone (current behavior). Auto-takeover only on **explicit user actions**: `handleSendV2` and `handleInterruptV2`. This means: reconnect → observe; send/interrupt → take ownership. The user on the old device sees a `session_takeover` event and gets a clean "Session resumed on another device" message.

**Impact on implementation**: Phase 1.2 is split. The `handleReconnect` code at L156-192 keeps its existing ownership check (`isOwner || ownerGone`). Only `handleSendV2` (L419-429) and `handleInterruptV2` (L563-571) get the takeover logic.

### R2. (HIGH) Lazy guard cannot reliably drive on-demand creation — partially accepted

**Finding**: `checkWorktreePolicy()` (`packages/harness/src/worktree-guard.ts` L80-143) only sees `file_path` fields and absolute paths parsed from shell commands. It misses `working_directory`, relative paths, and `cd`-based navigation.

**Resolution**: The guard IS reliable for write-path tools (Write, Edit, StrReplace) which have explicit `file_path` fields — these are the tools that actually modify files. For Bash/Shell, the heuristic parser (`extractAbsolutePaths` at L25-38) is incomplete but catches the common case. To cover the gap:

1. Primary worktree: **always** created eagerly at session start
2. Secondary worktrees for write tools: created on-demand via the guard (reliable for file-path tools)
3. For Bash/Shell targeting new repos: the agent can use `$MITZO_REPO_<NAME>` env vars (already injected by `sdkEnv()` at L548-549 of `chat.ts`) which point to worktree paths once created
4. Explicit escape hatch: the system prompt tells the agent it can request worktree creation via a system message if the guard misses it

The counter-proposal's "eager all repos" approach re-introduces Problem 7 (55 worktrees). The hybrid approach — eager primary, lazy secondary via guard + explicit request — is the right tradeoff.

### R3. (MEDIUM) Symlinks reintroduce shared mutable state — accepted with caveats

**Finding**: Symlinking `.venv` means `pip install` in one session affects all others.

**Resolution**: Runtime symlinks are an **opt-in escape hatch**, not part of the core isolation guarantee. The design doc must explicitly document the shared-state tradeoff. Implementation:

1. **Primary mechanism**: `PATH` injection (already exists in `sdkEnv()` at L185-187 of `chat.ts`)
2. **Secondary mechanism**: Configurable symlink allowlist in `.mitzo.json` (`runtimeSymlinks` field). Default empty — user opts in per repo.
3. **Documentation**: System prompt includes warning: "Symlinked runtime dirs are shared across sessions. Don't install/upgrade packages in a worktree session."

This means executables are found via `PATH` (no shared state), and symlinks are only for repos where `PATH` isn't enough (e.g., tools that resolve via CWD-relative paths).

### R4. (MEDIUM) Reattach alone is not enough for takeover — accepted

**Finding**: After takeover, the old connection still watches the session in ConnectionRegistry. Pending permissions are keyed by `permId` only.

**Resolution**: Takeover becomes a full state transition:

1. Send `session_takeover` to old transport
2. **Unwatch the session from the old connection** in ConnectionRegistry (`connRegistry.unwatch(oldConnectionId, sessionId)`)
3. **[Shipped in Phase 1]** Auto-deny pending permissions for the session via `denyPendingBySession(sessionId)` (already implemented in `packages/harness/src/permissions.ts`)
4. Reattach transport to new connection

**Note**: `denyPendingBySession` and the session-scoped permission tracking are fully implemented in the harness package, not in `server/permissions.ts` (which is a thin re-export).

### R5. (MEDIUM) Shorter handshake timeout is only partial — accepted

**Finding**: 1s timeout still falls unknown sockets into v1 path. Weak protocol boundary.

**Resolution**: Change `routeWsClient` at `server/index.ts` L234-263:

1. If first message is valid JSON and a hello → v2 path (current behavior)
2. If first message is valid JSON but NOT hello → v1 path (current behavior, for legacy)
3. If first message is invalid JSON → **close immediately** (new)
4. If **no message within 1s** → **close immediately** (new — don't fall through to v1)

v1 clients that still need support must send their first message within 1s. In practice, all current clients are v2. The v1 path is kept only for backward compat during transition, not as a catch-all for dead sockets.

---

## Architecture Decision: Git Worktrees

Alternatives evaluated: pre-warmed pool (divergence problem), shallow clones (too heavy — 2-5s per repo), OverlayFS (macOS doesn't have it), APFS clones (awkward git workflow), file guard only (no parallelism). See full comparison table in prior version.

**Decision**: Git worktrees remain the isolation substrate. They give each session its own branch, working directory, and git index. Creation cost ~200ms. The implementation needs to be bulletproof — which is what this doc addresses.

**Enforcement**: Every tool call goes through `canUseTool()` → `buildPermissionHandler()` (`packages/harness/src/permission-handler.ts` L44-146) → `checkWorktreePolicy()` (`packages/harness/src/worktree-guard.ts` L80-143). Write tools check `file_path`; shell tools parse absolute paths. Reads are unrestricted.

---

## Phase 1: Fix the WS Plumbing (one PR, one branch)

> Prerequisite: read CLAUDE.md for TDD workflow, git workflow (never push to main), and ESM import conventions.

### 1.0 Enable Observability

**What**: Uncomment `LOKI_HOST=http://localhost:3200` in `.env`. Add OTel spans to critical session lifecycle paths.

**Where**: `.env` (one line), `server/query-loop.ts`, `server/chat.ts`, `server/ws-handler-v2.ts`, `server/index.ts`

**OTel spans to add** (use existing `tracer` from `server/tracing.ts` L44):

| Span name                 | File                                  | Wraps                                | Key attributes                                                  |
| ------------------------- | ------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `session`                 | `query-loop.ts` L115                  | Entire `runQueryLoop()`              | `session.id`, `session.clientId`, `session.cwd`, `session.mode` |
| `session.turn`            | `query-loop.ts` (on `message_start`)  | message_start → message_end          | `turn.index`, `turn.messageId`                                  |
| `session.resume.validate` | `chat.ts` (new `validateResumable()`) | CWD validation + worktree recreation | `resume.sessionId`, `resume.cwdExists`, `resume.recreated`      |
| `session.detach`          | `index.ts` L314-323                   | v2 WS close detach loop              | `session.sessionId`, `ws.connectionId`                          |

Span events (not separate spans): `session.stale_correction` when EventStore disagrees with registry, `session.takeover` when ownership transfers.

**Why first**: Without observability, debugging the remaining fixes is blind. Loki gives searchable logs (`{app="mitzo", module="ws-v2"}`), Jaeger gives trace correlation.

### 1.1 Clean Up Stale Registry Entries

**What**: When detecting stale sessions, actually remove them from the registry instead of just correcting a local variable.

**Where**: `server/ws-handler-v2.ts` — three locations:

- `handleReconnect` L145-154 (the `if (staleInMemory)` block)
- `handleSendV2` L398-408 (same pattern)
- `handleInterruptV2` L546-556 (same pattern)

**Current code** (all three sites are identical in structure):

```typescript
if (staleInMemory) {
  log.info('corrected stale running state from EventStore', { ... });
  // Fall through to resume path
}
```

**New code**:

```typescript
if (staleInMemory) {
  log.info('removing stale session from registry', {
    connectionId,
    sessionId,
    clientId: found.clientId,
  });
  ctx.sessionRegistry.remove(found.clientId);
  // Fall through to resume path — session will be re-created by startChat()
}
```

**Test contract**: Given a session in SessionRegistry with `isActive=true` but EventStore `is_active=false`, when `handleReconnect` processes that session, then `registry.get(found.clientId)` returns `undefined` after the call.

### 1.2 Auto-Takeover on Send/Interrupt (NOT on reconnect)

**What**: Replace `active_elsewhere` rejection with forced ownership transfer, but ONLY on explicit user actions (send, interrupt). Reconnect stays passive per review finding R1.

**Where**:

- `server/ws-handler-v2.ts` `handleSendV2` L415-463 — replace the `if (!isOwner && !isDetached && !ownerGone)` rejection block
- `server/ws-handler-v2.ts` `handleInterruptV2` L558-594 — same pattern
- `server/ws-handler-v2.ts` `handleReconnect` L156-192 — **NO CHANGE** (stays passive)
- `server/permissions.ts` — add `denyPendingBySession(sessionId)` function
- `packages/client/src/protocol-parser.ts` L328-340 — remove `active_elsewhere` handler, add `session_takeover` handler
- `packages/client/src/slices/messages.ts` — no new action type needed; `session_takeover` uses existing `ERROR` action with a friendly message + `SET_RUNNING` false

**Takeover sequence** (in handleSendV2):

1. Get old transport from session: `const oldTransport = found.session.transport`
2. Get old connection ID: `const oldConnectionId = getOwnerConnection(found.clientId)`
3. Send `session_takeover` to old transport (if open)
4. Unwatch session from old connection: `ctx.connRegistry.unwatch(oldConnectionId, sessionId)` — **R4 fix**
5. Auto-deny pending permissions: `denyPendingBySession(sessionId)` — **R4 fix**
6. Reattach: `reattachChat(found.clientId, transport)`
7. Rekey: `rekeyChat(found.clientId, newClientId)`
8. Continue to `sendToChat()`

**Test contracts**:

- Given session owned by conn-A, when conn-B sends to that session, then: conn-A receives `session_takeover`, session transport is now conn-B, pending permissions are denied, conn-A no longer watches the session.
- Given session owned by conn-A, when conn-B reconnects listing that session, then: session stays with conn-A (passive reconnect), conn-B reports `running: true` but does NOT take over.

**Existing tests to update** (~8 in `server/__tests__/ws-handler-v2.test.ts`):

- L1468-1498: "rejects send when session is active on another connection" → "takeover on send"
- L1600-1629: "still rejects when EventStore confirms session IS active" → "takeover when active"
- L1873-1898: "rejects interrupt when active on another connection" → "takeover on interrupt"
- L1954-2005, L2007-2048, L2050-2087: rekey tests → update for takeover flow
- L1852-1868: `getOwnerConnection` tests → keep (still used)

### 1.3 Client Reconnect Message Recovery

**What**: After any WS reconnect, always re-fetch messages for the active session from the REST API.

**Where**: `packages/client/src/protocol-parser.ts` — `reconnected` case (L113-115), and `store.ts` — `_foreground` handler (L611-634)

**Current behavior**: `reconnected` just sets `connectionUpdate: { status: 'connected' }`. The `_foreground` handler only re-fetches if `messages.length === 0 && !current`.

**New behavior**:

1. In `protocol-parser.ts`, `reconnected` case: add callback `callbacks.onReconnected?.()`
2. In `store.ts` `wsListener`, handle the callback:
   ```typescript
   onReconnected() {
     const activeId = parserState.currentSessionId;
     if (activeId) {
       api.getSessionMessages(activeId).then(msgs => {
         if (Array.isArray(msgs) && msgs.length > 0) {
           store.setState(s => ({
             messages: messagesReducer(s.messages, { type: 'RESTORE', messages: msgs })
           }));
         }
       }).catch(() => {});
     }
   }
   ```
3. In `_foreground` handler (L614): remove the `messages.length === 0 && !current` guard.

**Test contract**: Given a store with `sessions.active = 'sess-1'` and `messages.messages = [staleMsg]`, when `reconnected` event arrives, then `api.getSessionMessages('sess-1')` is called regardless of existing message count.

### 1.4 Eliminate Session Bleed

**What**: Two-layer fix. Server stops accumulating watches. Client stops accumulating `seqBySession` entries.

**Server** — `server/ws-handler-v2.ts` `handleSwitchSession` L292:

```typescript
// NEW: unwatch previous session before setting new active
const prev = ctx.connRegistry.get(connectionId)?.activeSession;
if (prev && prev !== msg.sessionId) {
  ctx.connRegistry.unwatch(connectionId, prev);
}
ctx.connRegistry.setActive(connectionId, msg.sessionId);
```

**Client** — `packages/client/src/store.ts`:

In `switchSession()` (L202):

```typescript
async switchSession(id: string) {
  const oldId = parserState.currentSessionId;
  if (oldId) connection.clearSession(oldId);  // NEW
  parserState.currentSessionId = id;
  // ... rest unchanged
}
```

In `newSession()` (L227):

```typescript
newSession() {
  // NEW: clear all session tracking to prevent reconnect from re-watching
  for (const sid of connection.getTrackedSessions()) {
    connection.clearSession(sid);
  }
  parserState.currentSessionId = undefined;
  // ... rest unchanged
}
```

Need to add `getTrackedSessions(): string[]` to `MitzoConnection` (returns `Array.from(this.seqBySession.keys())`).

**Client** — `packages/client/src/store.ts` L644-658 (event filter):

Current filter allows `session_id`, `session_end`, and `permission_request` when `currentSessionId` is null. Tighten to only `session_id`:

```typescript
if (!parserState.currentSessionId) {
  const isAssignment = msg.type === 'session_id';
  if (!isAssignment) return; // drop everything else
}
```

**Test contracts**:

- Server: Given connection watching sessions A and B, when `switch_session(C)` arrives, then connection watches only C (A and B unwatched).
- Client: Given `seqBySession` has entries for sessions A and B, when `switchSession('C')` is called, then `seqBySession` has only C. When `newSession()` is called, `seqBySession` is empty.
- Client filter: Given `currentSessionId = null`, when `session_end` event with `sessionId = 'foreign'` arrives, then it is dropped (not dispatched to store).

### 1.5 Fix Reconnect Storm

**What**: Close dead sockets immediately instead of falling through to v1.

**Where**: `server/index.ts` `routeWsClient` L234-263

**Current**: 5s timeout → fall through to `handleChatWs` (v1 handler).

**New**:

```typescript
const HANDSHAKE_TIMEOUT_MS = 1_000;

const timer = setTimeout(() => {
  ws.removeListener('message', onFirstMessage);
  // NEW: close dead sockets instead of routing to v1
  log.info('no hello received, closing dead connection', { connectionId: assignedId });
  ws.close(4000, 'No hello received');
}, HANDSHAKE_TIMEOUT_MS);

const onFirstMessage = (raw) => {
  clearTimeout(timer);
  ws.removeListener('message', onFirstMessage);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    // NEW: invalid JSON → close immediately (was: fall to v1)
    ws.close(4001, 'Invalid handshake');
    return;
  }
  if (isHelloHandshake(parsed)) {
    handleChatWsV2(ws, assignedId);
  } else {
    handleChatWs(ws, assignedId, raw); // genuine v1 client
  }
};
```

Also add 30s idle timeout to `handleChatWs` (after L455): if no message arrives within 30s after the first message, close the connection.

**Test contract**: Given a WS that connects but sends nothing, after 1s it receives close code 4000. Given a WS that sends invalid JSON, it receives close code 4001 immediately.

### 1.6 Validate Session Resumability

**What**: Before calling SDK `query()` with `resume`, validate the CWD is a real git directory.

**Where**: `server/chat.ts` — new function `validateResumable()`, called from `startChat()` before the `query()` call at L573.

```typescript
export function validateResumable(
  cwd: string,
  resumeId: string,
): { valid: boolean; recreated?: boolean } {
  // Check if CWD is a valid git worktree or repo
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--git-dir'], { stdio: 'pipe', timeout: 5000 });
    return { valid: true };
  } catch {
    // CWD is not a git directory — try to recreate the worktree
    const wtMatch = cwd.match(/\/(\.claude|\.cursor)\/worktrees\/([^/]+)$/);
    if (wtMatch) {
      const [, prefix, wtId] = wtMatch;
      const repoRoot = cwd.slice(0, cwd.indexOf(`/${prefix}/worktrees/`));
      try {
        createWorktree(wtId, repoRoot, { prefix: prefix as '.claude' | '.cursor' });
        return { valid: true, recreated: true };
      } catch {
        return { valid: false };
      }
    }
    return { valid: false };
  }
}
```

In `startChat()`, after `resolveResumeCwd()` and before `query()`:

```typescript
if (options.resume) {
  const validation = validateResumable(cwd, options.resume);
  if (!validation.valid) {
    log.warn('session not resumable, starting fresh', { sessionId: options.resume, cwd });
    send(transport, {
      type: 'error',
      error: 'Session workspace was cleaned up. Starting a new conversation.',
    });
    // Remove resume option — start fresh
    delete options.resume;
  }
}
```

Also wrap the `query()` call at L573 in a try/catch:

```typescript
try {
  const q = query({ ... });
} catch (err) {
  if (err.message?.includes('No conversation found') && options.resume) {
    log.warn('SDK rejected resume, retrying without resume', { sessionId: options.resume });
    send(transport, { type: 'error', error: 'Session expired. Starting fresh.' });
    // Retry without resume (recursive call or inline retry)
  }
  throw err;
}
```

**Test contracts**:

- Given a CWD that is a valid git worktree, `validateResumable` returns `{ valid: true }`.
- Given a CWD that was cleaned up but the repo root exists, `validateResumable` recreates the worktree and returns `{ valid: true, recreated: true }`.
- Given a CWD that cannot be recreated, `validateResumable` returns `{ valid: false }` and `startChat` sends an error and starts without resume.

---

## Phase 2: Bulletproof Worktree Isolation (separate PR, separate branch)

### 2a. Lazy Worktree Creation

**Where**: `server/chat.ts` `createSessionWorktrees()` L235-293, `packages/harness/src/worktree-guard.ts` `checkWorktreePolicy()` L80-143

**Change to `createSessionWorktrees()`**: Only create primary worktree. Remove the loop over `config.repos` at L271-285.

**Change to `checkWorktreePolicy()`**: When a write tool targets a configured repo that has no worktree:

1. Identify the repo from the path (check against `config.repos` values)
2. Call `createWorktreeAsync(session.wtId, repoPath)` — new async function in `worktree.ts`
3. Call `symlinkRuntimeDirs(repoPath, worktreePath)` — if opt-in
4. Add to `session.worktreePaths`
5. Broadcast `worktree_opened` event to client
6. Return deny with redirect (same as current behavior — agent retries with worktree path)

**Important**: The guard's `canUseTool` callback is async (`buildPermissionHandler` returns `Promise<PermissionResult>`), so calling an async `createWorktreeAsync` is safe. But `checkWorktreePolicy` is currently sync — it needs to become async or the creation needs to happen in the permission handler wrapper.

**System prompt change** in `buildWorktreeSystemPrompt()` (`chat.ts` L330-352): List secondary repos as available with a note like "Worktrees for secondary repos are created on first write. Use `$MITZO_REPO_<NAME>` env vars."

### 2b. Collision-Proof IDs

**Where**: `server/chat.ts` `generateWtId()`

**[Shipped in Phase 1]** Changed from `randomBytes(3).toString('hex')` (6 hex chars) to `randomUUID().replace(/-/g, '').slice(0, 12)` (12 hex chars). Added `.mitzo-session` lockfile inside each worktree containing the wtId and creation timestamp.

### 2c. Runtime Symlinks (opt-in)

**Where**: `server/worktree.ts` — new `symlinkRuntimeDirs()`, `server/repo-config.ts` — parse `runtimeSymlinks` from `.mitzo.json`

Default: **empty** (no symlinks). User opts in per repo:

```json
{ "runtimeSymlinks": [".venv", "node_modules"] }
```

Primary mechanism remains `PATH` injection via `sdkEnv()`. Symlinks are the escape hatch for CWD-relative tool resolution. The design doc and system prompt must warn: "Symlinked runtime dirs are shared mutable state across sessions."

### 2d. Resume-Aware Worktree Rebuild

**Where**: `server/worktree.ts` — new `discoverSessionWorktrees()`, `server/chat.ts` — integrated into resume path

On resume: scan disk for existing worktrees matching `<repo>/.claude/worktrees/<wtId>` across all configured repos. Rebuild `session.worktreePaths`. Recreate primary if gone. Don't recreate secondaries (lazy creation handles it).

### 2e. Cleanup Only on Close

**Where**: `server/chat.ts` L623-628 — remove `cleanupSessionWorktrees(session)` from the `finally` block.

Worktrees survive until explicit close or stale GC. Reduce `WORKTREE_STALE_HOURS` from 96 to 24 (configurable in `.mitzo.json`).

### 2f. Async Worktree Creation

**Where**: `server/worktree.ts` — convert `createWorktree` from `execFileSync` to async.

The on-demand path runs inside `canUseTool` which is async. `execFileSync` blocks the Node event loop, freezing ALL sessions during git operations.

---

## Frontend Changes

### Phase 1 Frontend

| #   | File                                                         | Change                                                                                                | Why                                                             |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| F1  | `packages/client/src/store.ts` `switchSession()`             | Call `connection.clearSession(oldId)` before switching                                                | Prevents `seqBySession` accumulation → reconnect re-watch       |
| F2  | `packages/client/src/store.ts` `newSession()`                | Clear all `seqBySession` entries                                                                      | Same reason; `getTrackedSessions()` method needed on connection |
| F3  | `packages/client/src/store.ts` `wsListener`                  | Add `onReconnected` callback that re-fetches messages                                                 | iOS eviction loses in-memory state                              |
| F4  | `packages/client/src/store.ts` `_foreground` handler         | Remove `messages.length === 0 && !current` guard                                                      | Always re-fetch, not just when empty                            |
| F5  | `packages/client/src/protocol-parser.ts`                     | Add `session_takeover` case → `SET_RUNNING: false` + `ERROR` with "Session resumed on another device" | Old device needs clean exit on takeover                         |
| F6  | `packages/client/src/protocol-parser.ts`                     | ~~Remove `active_elsewhere` case~~ (no-op: case does not exist in current parser)                     | Already absent — no action needed                               |
| F7  | `packages/client/src/store.ts` event filter (L644-658)       | When `currentSessionId` is null, only allow `session_id`                                              | Prevent foreign `session_end` from assigning wrong session      |
| F8  | `packages/client/src/protocol-parser.ts` `error` case (L344) | Change "Session expired" from silent wipe to recoverable error message                                | Better UX — show "Start fresh?" button                          |
| F9  | `packages/client/src/connection.ts`                          | Add `getTrackedSessions(): string[]` method                                                           | Needed by F2                                                    |
| F10 | `frontend/src/types/ws-messages.ts`                          | Add `session_takeover` to `ServerMessage` union                                                       | Type safety                                                     |

### Phase 2 Frontend

| #   | File                                    | Change                                                             | Why                                                                   |
| --- | --------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| F11 | `frontend/src/pages/ChatView.tsx`       | Dedicated `WorktreeError` component for worktree creation failures | Raw error string → recoverable "Retry" / "Continue without isolation" |
| F12 | `frontend/src/components/ChatInput.tsx` | Show dynamic worktree count from `activeWorktrees[]`               | Visibility into lazy worktree creation                                |
| F13 | `frontend/src/pages/SessionList.tsx`    | Worktree count indicator per session                               | Which sessions are multi-repo                                         |

---

## Test Plan (TDD per CLAUDE.md)

### Phase 1

| Test file                                           | Test description                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `server/__tests__/ws-handler-v2.test.ts`            | Stale session removed from registry on reconnect (not just local var corrected)                          |
| `server/__tests__/ws-handler-v2.test.ts`            | Send to foreign-owned session → takeover (update ~8 existing `active_elsewhere` tests)                   |
| `server/__tests__/ws-handler-v2.test.ts`            | Reconnect to foreign-owned session → passive (no takeover)                                               |
| `server/__tests__/ws-handler-v2.test.ts`            | `session_takeover` sent to old transport on send-takeover                                                |
| `server/__tests__/ws-handler-v2.test.ts`            | Old connection unwatched on takeover                                                                     |
| `server/__tests__/ws-handler-v2.test.ts`            | Pending permissions denied on takeover                                                                   |
| `server/__tests__/ws-handler-v2.test.ts`            | `switch_session(B)` unwatches previous session A                                                         |
| `server/__tests__/ws-handler-v2.test.ts`            | Dead socket (no hello) closed after 1s (not routed to v1)                                                |
| `packages/client/__tests__/store.test.ts`           | `switchSession()` calls `clearSession(oldId)`                                                            |
| `packages/client/__tests__/store.test.ts`           | `newSession()` clears all tracked sessions                                                               |
| `packages/client/__tests__/store.test.ts`           | `reconnected` event triggers message re-fetch for active session                                         |
| `packages/client/__tests__/protocol-parser.test.ts` | `session_takeover` produces SET_RUNNING false + ERROR message                                            |
| `packages/client/__tests__/protocol-parser.test.ts` | null-session filter drops foreign `session_end`                                                          |
| `server/__tests__/chat.test.ts`                     | `validateResumable` returns valid for good CWD, recreates missing worktree, returns invalid for dead CWD |

### Phase 2

| Test file                                           | Test description                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `server/__tests__/chat.test.ts`                     | Session start creates only primary worktree                                          |
| `packages/harness/__tests__/worktree-guard.test.ts` | Write to uncovered configured repo triggers on-demand worktree creation              |
| `server/__tests__/worktree.test.ts`                 | `symlinkRuntimeDirs` creates symlinks for existing dirs, skips missing               |
| `server/__tests__/worktree.test.ts`                 | `discoverSessionWorktrees` finds worktrees across repos                              |
| `server/__tests__/worktree.test.ts`                 | `createWorktreeAsync` does not block event loop                                      |
| `server/__tests__/chat.test.ts`                     | Resume rebuilds `worktreePaths` from disk                                            |
| `server/__tests__/chat.test.ts`                     | Collision-proof IDs: 100 concurrent `generateWtId()` calls produce 100 unique values |
| `server/__tests__/chat.test.ts`                     | `finally` block does NOT call `cleanupSessionWorktrees`                              |

---

## Verification Checklist

### Phase 1

- [ ] Start session on phone, send message from laptop → seamless takeover, phone shows "resumed on another device"
- [ ] Phone reconnects in background → passive (no takeover), laptop session uninterrupted
- [ ] Background iOS app 5 min, return → messages visible (re-fetched)
- [ ] Switch between 3 sessions rapidly → no bleed, connection watches only current session
- [ ] Resume session with cleaned-up worktree → worktree recreated or clean "starting fresh" error
- [ ] Grafana: `{app="mitzo"}` returns log data
- [ ] Jaeger: `session`, `session.turn`, `session.detach` spans visible
- [ ] Server restart → no 382-connection burst (dead sockets closed at 1s)

### Phase 2

- [ ] Start session → only primary worktree created
- [ ] Agent writes to secondary repo → worktree created on-demand, retry succeeds
- [ ] Agent runs `python` in worktree → found via PATH (or symlink if opted in)
- [ ] 3 concurrent session starts → no wtId collision
- [ ] Resume after stale GC → worktrees rebuilt from disk
- [ ] Work in 3 repos, disconnect, resume → all 3 worktrees survive
- [ ] Close session → all worktrees cleaned up, branches preserved
- [ ] 5 parallel sessions → zero conflicts, zero bleed

---

## Deferred

- **Session identity decoupling** (registry key = sessionId instead of `${connectionId}:${sessionId}`) — still deferred. Phase 1 auto-takeover with rekey addresses the user-facing bugs without it
- **Session state machine** (ACTIVE/SUSPENDED/CLOSED in EventStore) — still deferred, architectural improvement
- **Frontend session state UI** (dots, explicit close) — still deferred, separate concern
