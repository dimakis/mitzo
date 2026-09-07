# Native OpenAI execution foundation

This is an internal server execution slice built on the Responses adapter. It is not wired into `startChat()` and does not enable OpenAI in the mobile catalog. The existing Vertex SDK route, ContexGin boot-context fetching, MCP configuration and production service are unchanged.

## Delivered boundary

`server/native-tool-executor.ts` supplies Read, Write, Edit and Bash definitions and execution. It accepts a registered session and an explicit child environment, normalizes file paths and worktree roots, and calls the existing permission handler. Skill restrictions, worktree redirects, tier overrides and permission responses remain authoritative. Ask mode explicitly rejects mutating tools because there is no SDK plan-mode guard in native execution.

Sessions intentionally configured without worktree entries use the existing unisolated permission policy; the executor does not invent a worktree requirement.

Current executable policy auto-allows elevated tools including Bash in both agent and auto modes; older documentation describes a different matrix. This slice preserves executable policy. Unknown-tier overrides exercise permission prompting and cancellation. Shells run in the registered cwd with the supplied environment only, with a 60-second default timeout and 64-KiB combined output limit. Stderr is returned in a labeled section. Cancellation kills the shell process group. File tools accept SDK-compatible field names; Edit requires exactly one match. Parent directories must already exist. Read and Edit consume at most the configured byte limit plus one sentinel byte (64 KiB by default), rejecting larger files before loading them in full.

The worktree shell guard is the existing heuristic, not an OS sandbox. File normalization catches traversal and existing symlink redirects, but it is not a race-proof filesystem sandbox. Background shell jobs, filesystem races, richer file tools and SDK hook parity require further work before broad activation.

`server/native-responses-runner.ts` connects `ResponsesSession` to `runAgenticLoop` and a caller-supplied executor. It accepts the final system prompt and tool definitions, preserving the caller's context. Every wrapper event uses the supplied application conversation ID; provider response IDs are not SDK session IDs. Each `run()` handles one explicit text prompt. Sequential calls restore history; overlapping calls for the same stored conversation are rejected. The caller must exhaust or close the iterator and owns queueing and transport.

The loop's optional `onHistory` callback persists completed model output before tool execution and each tool outcome before subsequent execution. Callback failure stops the loop. Each callback clones and persists the full history; cost grows with history length and tool count. Differential persistence and a bounded-history policy remain integration work. Existing callers without the callback retain their behavior. The runner reports interruption and loop-limit exhaustion as errors rather than successful completion.

## Private continuation and recovery

`server/native-responses-store.ts` stores continuation in a separate SQLite database, outside public event-store session metadata. The caller supplies a server-only path in an existing private directory. The database is created with mode 0600 and full synchronous durability; do not expose it through transcript, file-browser, backup-download or catalog endpoints.

Records bind the application conversation ID to account ID, provider, model and credential-reference revision. Credentials are constructor inputs only and are never serialized. Checkpoint fields are explicitly allowlisted with a compile-time completeness check; new fields require a persistence review. Saves enforce the binding atomically in SQLite. The stored `ResponsesCheckpoint` contains private history and opaque encrypted reasoning continuation, alongside tool results and running/idle/interrupted status. The upstream adapter continues using `store: false` and explicit API billing.

One server process owns the database. During startup, before accepting work, call `recoverAtStartup()` to mark previously running turns interrupted. Recovery never automatically executes tools. On an explicit follow-up, unanswered calls receive an error result saying their outcome is unknown and current state must be inspected before retrying. A crash between a side effect and result persistence cannot prove whether that effect occurred. This is conservative recovery, not exactly-once execution or multi-process fencing.

## Required next integration

1. Add server-only OpenAI account credential references and dispatch in `server/account-profiles.ts` and `server/chat.ts`. Validate binding before worktree creation; never resolve native IDs through SDK resume APIs. Keep catalog exposure gated until acceptance passes.
2. Give native conversations canonical identity before the first stream event and connect event persistence, registration, reconnect and restart state. Prevent SDK auto-rename/history fallback from crossing providers or billing boundaries.
3. Connect follow-up queues, skill-policy changes at turn boundaries, interrupt/stop/closeout, pending permissions, retry deduplication and detached-session behavior. The runner currently rejects concurrency; it does not own the server queue.
4. Pass the existing assembled ContexGin/worktree/task context and explicit sanitized environment to the runner/executor. Connect configured MCP clients and lifecycle cleanup; do not silently drop MCP servers. SDK project hooks and additional tools remain unimplemented for native execution.
5. Exercise the complete route with a real personal API credential and physical phone. Verify approvals, tool execution, cancellation, sleep/disconnect, reconnect, retries, restart/resume and private checkpoint isolation. No live API or phone validation is claimed here.
6. Images, long-history compaction, reasoning-summary UI and ChatGPT Pro remain separate unsupported/unverified capabilities. No provider, credential or billing fallback is permitted.

## Validation

Test-first executor and runner modules initially failed to import before implementation. Twenty-eight executor and runner tests cover real native file execution driven by mocked Responses streams, permissions, skill/worktree denial, shell cancellation, explicit environment isolation, binding mismatch, sequential continuation after database reopen, encrypted continuation, concurrent rejection, uncertain effects, crash recovery, loop limits and persistence failure before side effects. The streams are fixtures, not live-provider evidence.

Full local suite: 208 files, 3,249 tests passed. Server/frontend types, lint, formatting and production builds passed. Existing lint and bundle-size warnings remain. One initial unrestricted suite run had an isolated socket hang-up; subsequent full runs passed. GitHub CI is verified separately on the published PR.
