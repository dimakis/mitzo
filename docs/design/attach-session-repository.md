# Attach a repository to the current Mitzo session

Status: proposed; implementation pending design approval.

The September 8 OpenShell incident shows a missing control-plane capability. Session 2842af94 persisted Auto correctly, but its host Bash could not create a second repository worktree. The current on-demand callback only matches configured repositories. Auto must not require a sandboxed command to expand its own filesystem authority.

## Contract

Expose `AttachRepository({ repository: string })` to agents and `/attach-repo <absolute-path-or-configured-name>` to users in existing chats. Both invoke the same trusted server operation, scoped to the current conversation. Never accept an agent-supplied target session ID, arbitrary branch, shell command, or destination directory.

Resolve configured names directly; resolve absolute local repository paths canonically and verify the Git root. An unconfigured repository requires a Mitzo approval for that exact root before attachment, including in Auto, because it expands the session workspace. Configured repositories use the existing session authorization. Ask remains read-only. Do not modify global repository configuration.

Use the existing session worktree identifier, verify or create the isolated worktree through `createWorktreeAsync`, and return its canonical path and environment variable name. Preserve existing work and handle repeated/concurrent requests idempotently. Do not fetch or run project hooks as part of attachment. Remote refresh, shared-object Git commits and authenticated network commands remain distinct capabilities; attachment alone must not claim to solve them.

Persist the attachment as trusted server-owned session metadata, including repository root/name/worktree/branch. Restore and validate it on resume; an absent worktree must not silently grant the original checkout. Recheck the live session and permission ceiling after asynchronous approval/creation before publishing authority.

Update the live workspace registry before returning success. Derive native Bash `MITZO_REPO_*` entries from the current registry for every invocation, rather than a startup snapshot. Return the absolute path to every provider. Claude subprocess environment cannot be mutated after launch: do not promise that its inherited environment changes live; use the returned path, and refresh the environment on resume.

## Integration points

- New `server/session-repositories.ts`: canonical validation, approval orchestration, serialized attachment, persistence and restore.
- `server/worktree.ts`: reuse existing validated creation; no shell-based fallback.
- `server/native-tool-executor.ts`, `server/codex-chat-session.ts`, `server/responses-chat-session.ts`: agent tool registration and execution across native providers; derive per-command workspace environment.
- `server/chat.ts`: session-bound Claude SDK MCP tool, shared callback, restore and provider instructions.
- `server/native-commands.ts`, `server/ws-handler-v2.ts` and the legacy dispatch path: `/attach-repo` invokes the same operation and returns a concrete result without sending slash text as an ordinary model task.
- Durable session storage and `packages/harness/src/session-registry.ts`: per-session attachment metadata and restoration.

Older Codex threads have immutable dynamic tool catalogs. The slash command must attach to the existing visible conversation without replacing provider history. Newly created Codex threads receive the agent tool. Do not tell existing users that restarting adds a new dynamic tool to an old provider thread.

## Verification (test first)

1. Reproduce an Auto session with only mgmt attached and another real local Git repository. The agent tool attaches it and a subsequent native Write/Bash writes inside the new worktree while the original checkout remains unchanged.
2. Confirm Ask rejection, unconfigured-root approval, denied/cancelled approval, session replacement/downgrade during creation, private roots, malformed paths and name/env collisions do not publish new authority.
3. Repeated/concurrent attachment creates only one worktree; persistence failure returns a truthful error and no live grant. Resume restores the exact validated attachment, including after server restart.
4. Existing-chat slash command works without a new Codex tool catalog; native tool paths work for Codex, Responses and Gemini; Claude receives a session-bound MCP tool and a truthful path result.
5. Verify changing Auto/Agent never bypasses workspace bounds; command failures identify the actual restriction rather than asserting that the mode did not propagate.
6. Run the full suite, builds, types, formatting/lint, and an actual macOS sandbox test for the newly attached worktree before PR review/deployment.
