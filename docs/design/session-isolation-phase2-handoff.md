# Session Isolation Phase 2 — Handoff for Next Agent

**Context:** Phase 1 of the session isolation overhaul was merged in PR #278 (squash-merged to main, deployed via launchd). This document is the complete handoff for Phase 2 implementation.

**Design doc:** `docs/design/session-isolation-overhaul.md` — Phase 2 starts at the "## Phase 2: Bulletproof Worktree Isolation" section (L411). Read that first, then come back here for implementation specifics.

**Prior art:** PR #278 commit history shows the Phase 1 TDD pattern. The centaur + codex review findings and fixes are instructive for what reviewers will flag.

---

## What Phase 1 Already Shipped

These are done and deployed — don't re-implement:

- **2b (Collision-proof IDs):** `generateWtId()` in `server/chat.ts` now uses `randomUUID().replace(/-/g, '').slice(0, 12)` (strips dashes first, then slices — result is 12 hex chars). `.mitzo-session` lockfile written inside primary worktree at creation time.
- **Stale registry cleanup:** `registry.remove()` in all 3 handler stale-detection sites
- **Session bleed fix:** server unwatches on switch, client clears `seqBySession`, null-session filter tightened (allows `session_id` + `permission_request` only)
- **Auto-takeover:** send/interrupt from another device does full ownership transfer instead of `active_elsewhere` rejection
- **Reconnect storm:** 1s handshake timeout, dead sockets closed
- **Resume validation:** `validateResumable()` checks git dir before SDK query
- **Client recovery:** `onReconnected` + `_foreground` both go through shared `fetchAndRestoreMessages()` with in-flight dedup guard
- **OTel spans:** `session` span wraps query loop, `session.detach` span on WS close, LOKI_HOST enabled

---

## Phase 2 Scope: 5 Steps (2b is done)

### 2a. Lazy Worktree Creation

**Problem (P7):** `createSessionWorktrees()` in `server/chat.ts` L317-332 creates worktrees for ALL configured secondary repos at session start. With 11 repos and 5 sessions = 55 worktree dirs, most never used.

**Files to modify:**

1. `server/chat.ts` `createSessionWorktrees()` (L278-338) — remove the secondary repo loop at L317-332. Only keep primary worktree creation (L296-315). The function signature and return type stay the same.

2. `packages/harness/src/worktree-guard.ts` `checkWorktreePolicy()` (L80-143) — currently sync, returns `string | null`. Needs to become async or the on-demand creation needs to happen in the permission handler wrapper (`packages/harness/src/permission-handler.ts` L44-146, the `canUseTool` callback is already async).

   The on-demand flow when a write tool targets a configured repo with no worktree:
   - Identify the repo from the file path (compare against `config.repos` values from `server/repo-config.ts`)
   - Call async `createWorktreeAsync(session.wtId, repoPath)` (new, see 2f)
   - Add to `session.worktreePaths` Map
   - Broadcast `worktree_opened` event to client
   - On success: return deny with redirect message (existing behavior — agent retries with the worktree path)
   - On failure (disk full, git lock, branch conflict): hard deny with error — do NOT redirect, or the agent enters a retry loop

3. `server/chat.ts` `buildWorktreeSystemPrompt()` (L380-402) — update text to note secondary repos are lazy: "Worktrees for secondary repos are created on first write. Use `$MITZO_REPO_<NAME>` env vars."

**Key constraint:** `checkWorktreePolicy` is called from `buildPermissionHandler` which already returns `Promise<PermissionResult>`. The guard itself is sync — either make it async (changing the return type to `Promise<string | null>`) or do the creation in the permission handler wrapper before calling the guard.

**Test plan:**

- `server/__tests__/chat.test.ts`: Session start creates only primary worktree (verify `createWorktree` called once)
- `packages/harness/__tests__/worktree-guard.test.ts`: Write to uncovered configured repo triggers on-demand creation

### 2c. Runtime Symlinks (opt-in)

**Problem (P4):** `.venv`, `node_modules` don't exist in worktrees. `PATH` injection handles executables, but CWD-relative tool resolution (e.g. `./node_modules/.bin/vitest`) still fails.

**Files to modify:**

1. `server/worktree.ts` — new `symlinkRuntimeDirs(repoPath: string, worktreePath: string, dirs: string[]): void`. For each dir in `dirs`, if `join(repoPath, dir)` exists, create `symlink(join(repoPath, dir), join(worktreePath, dir))`.

2. `server/repo-config.ts` — add `runtimeSymlinks: string[]` to `RepoConfig` interface (L30-36) and parser (around L120). Default: empty array `[]`.

3. Integration: call `symlinkRuntimeDirs` after worktree creation (both eager primary and lazy secondary).

**Design decision (R3):** Symlinks are opt-in escape hatch, NOT the primary mechanism. `PATH` injection via `sdkEnv()` (L169-193) remains primary. System prompt must warn: "Symlinked runtime dirs are shared mutable state across sessions."

**Config example:**

```json
{ "runtimeSymlinks": [".venv", "node_modules"] }
```

**Test plan:**

- `server/__tests__/worktree.test.ts`: `symlinkRuntimeDirs` creates symlinks for existing dirs, skips missing
- `server/__tests__/worktree.test.ts`: `symlinkRuntimeDirs` idempotent on resume (symlink already exists)
- `server/__tests__/worktree.test.ts`: `symlinkRuntimeDirs` handles dangling symlinks (target deleted)
- `server/__tests__/chat.test.ts`: system prompt includes shared-mutable-state warning when symlinks active

### 2d. Resume-Aware Worktree Rebuild

**Problem:** On resume after server restart, `session.worktreePaths` is empty. The agent can't find its worktrees.

**Files to modify:**

1. `server/worktree.ts` — new `discoverSessionWorktrees(wtId: string, repos: Record<string, string>): Map<string, { path: string; wtId: string }>`. Scans `<repo>/.claude/worktrees/<wtId>` and `<repo>/.cursor/worktrees/<wtId>` across all configured repos.

2. `server/chat.ts` — in the resume path of `startChat()` (the block starting at L292 `if (!isIsolationEnabled(options.isolation) || options.resume ...)`), when `options.resume` is set, call `discoverSessionWorktrees` to rebuild `session.worktreePaths`. Recreate primary if gone. Don't recreate secondaries (lazy creation handles it).

**Note:** Phase 1 added `validateResumable()` (L116-157) which already handles the CWD validation and worktree recreation for the primary. This step extends that to populate `worktreePaths` for the system prompt and guard.

**Test plan:**

- `server/__tests__/worktree.test.ts`: `discoverSessionWorktrees` finds worktrees across repos
- `server/__tests__/chat.test.ts`: Resume rebuilds `worktreePaths` from disk

### 2e. Cleanup Only on Close

**Problem:** `cleanupSessionWorktrees(session)` in the `finally` block of `startChat()` destroys secondary worktrees after every query loop. The primary worktree is preserved (`if (repoName === 'primary') continue`), so resume itself is not broken today, but Phase 2 lazy-created secondaries would be lost on each turn boundary.

**Files to modify:**

1. `server/chat.ts` L694-697 — remove `cleanupSessionWorktrees(session)` from the `finally` block. Keep it in the `catch` block (L691) for failed sessions.

2. `server/constants.ts` L29 — reduce `WORKTREE_STALE_HOURS` from `96` to `24`. Optionally make it configurable via `.mitzo.json`.

**Current code (L693-698):**

```typescript
} finally {
    // Clean up secondary worktrees after query loop ends.
    cleanupSessionWorktrees(session);
}
```

**New code:**

```typescript
} finally {
    // Worktrees survive until explicit close or stale GC.
    // cleanupSessionWorktrees removed — see design doc 2e.
}
```

**Note:** Today both `catch` (conditionally via `if (failedSession)`) and `finally` call `cleanupSessionWorktrees`, resulting in a double-call. This is harmless (`removeWorktree` is idempotent) but worth knowing when removing only the `finally` call.

**Test plan:**

- `server/__tests__/chat.test.ts`: `finally` block does NOT call `cleanupSessionWorktrees`

### 2f. Async Worktree Creation

**Problem:** `createWorktree` in `server/worktree.ts` (L46-102) uses `execFileSync`, blocking the Node event loop during git operations. With lazy on-demand creation (2a), this blocks ALL sessions.

**Files to modify:**

1. `server/worktree.ts` — new `createWorktreeAsync(sessionId, baseRepo, opts?)` using `execFile` from `child_process/promises` (or `util.promisify(execFile)`). Same logic as `createWorktree` but async.

2. Keep sync `createWorktree` for the eager primary path in `startChat` (it runs before the event loop serves other sessions). Use `createWorktreeAsync` for the on-demand path in the worktree guard (2a).

**Test plan:**

- `server/__tests__/worktree.test.ts`: `createWorktreeAsync` does not block event loop

---

## Implementation Order

Recommended sequence (dependencies noted):

1. **2f (Async worktree)** — needed by 2a's on-demand path
2. **2a (Lazy creation)** — largest change, depends on 2f
3. **2e (Cleanup only on close)** — small, independent
4. **2c (Runtime symlinks)** — independent, small
5. **2d (Resume rebuild)** — depends on 2a being done (needs to know which repos are lazy)

---

## Key File Locations (post-Phase 1)

| File                                         | Symbol / Function                               |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------- |
| `server/chat.ts`                             | `createSessionWorktrees()`                      | L278-338 (secondary loop at L317-332) |
| `server/chat.ts`                             | `buildWorktreeSystemPrompt()`                   |
| `server/chat.ts`                             | `startChat()` finally block                     |
| `server/chat.ts`                             | `validateResumable()`                           |
| `server/chat.ts`                             | `cleanupSessionWorktrees()`                     |
| `server/worktree.ts`                         | `createWorktree()` (sync)                       |
| `server/worktree.ts`                         | `cleanupStaleWorktrees()`                       |
| `server/constants.ts`                        | `WORKTREE_STALE_HOURS` (currently 96)           |
| `server/repo-config.ts`                      | `RepoConfig` interface (`repos` field)          |
| `packages/harness/src/worktree-guard.ts`     | `checkWorktreePolicy()` (sync)                  |
| `packages/harness/src/permission-handler.ts` | `buildPermissionHandler()` (async `canUseTool`) |

---

## Frontend Changes (Phase 2)

| #   | File                                    | Change                                                                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| F11 | `frontend/src/pages/ChatView.tsx`       | `WorktreeError` component for creation failures (retry / continue without isolation) |
| F12 | `frontend/src/components/ChatInput.tsx` | Dynamic worktree count from `activeWorktrees[]`                                      |
| F13 | `frontend/src/pages/SessionList.tsx`    | Worktree count indicator per session                                                 |

---

## Test Plan (TDD per CLAUDE.md)

| Test file                                           | Description                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `server/__tests__/chat.test.ts`                     | Session start creates only primary worktree                       |
| `packages/harness/__tests__/worktree-guard.test.ts` | Write to uncovered repo triggers on-demand creation               |
| `server/__tests__/worktree.test.ts`                 | `symlinkRuntimeDirs` creates symlinks for existing, skips missing |
| `server/__tests__/worktree.test.ts`                 | `discoverSessionWorktrees` finds worktrees across repos           |
| `server/__tests__/worktree.test.ts`                 | `createWorktreeAsync` does not block event loop                   |
| `server/__tests__/chat.test.ts`                     | Resume rebuilds `worktreePaths` from disk                         |
| `server/__tests__/chat.test.ts`                     | `finally` block does NOT call `cleanupSessionWorktrees`           |

---

## Verification Checklist

- [ ] Start session -> only primary worktree created
- [ ] Agent writes to secondary repo -> worktree created on-demand, retry succeeds
- [ ] Agent runs `python` in worktree -> found via PATH (or symlink if opted in)
- [ ] 3 concurrent session starts -> no wtId collision (already shipped in Phase 1)
- [ ] Resume after stale GC -> worktrees rebuilt from disk
- [ ] Work in 3 repos, disconnect, resume -> all 3 worktrees survive
- [ ] Close session -> all worktrees cleaned up, branches preserved
- [ ] 5 parallel sessions -> zero conflicts, zero bleed

---

## Warnings for Next Agent

1. **Full test suite is slow** — worktree tests hit the filesystem. Use targeted runs: `npm test -- server/__tests__/worktree.test.ts server/__tests__/chat.test.ts packages/harness/__tests__`

2. **`checkWorktreePolicy` sync->async is the hardest part** — the guard is called from `buildPermissionHandler` which is already async, but the guard itself is sync. Either make it async (preferred) or do creation in the wrapper before calling the guard.

3. **`.mitzo-session` lockfile** was added in Phase 1 for primary worktrees. Extend it to secondary worktrees when they're created on-demand.

4. **Review findings pattern:** Centaur + Codex caught a real bug in Phase 1 (missing sessionId passthrough). Add the `openai` label to the PR for Codex review. If the centaur webhook fails, push an empty commit to retrigger, or redeliver via `gh api repos/{owner}/{repo}/hooks` to find the webhook ID, then `gh api repos/{owner}/{repo}/hooks/<id>/deliveries` to inspect and retry.

5. **Never push to main.** Branch + PR + CI + merge. See CLAUDE.md.
