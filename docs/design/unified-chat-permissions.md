# Unified in-chat permissions

## Problem and evidence

The reported chat displayed Agent while its Codex runtime reported `read-only` and `never`, and the assistant concluded that it could not edit files. The screenshot has no reliable incident date or session ID; this investigation reproduces the underlying implementation defects rather than claiming a production-log reconstruction.

At the starting revision, `90937f7`:

- `server/codex-conversation.ts` explicitly sets read-only/never at thread start/resume and every turn. This is intentional containment: `server/codex-runtime-policy.ts` disables provider-native execution and registers Mitzo host tools instead.
- `server/native-tool-executor.ts` already provided Read/Write/Edit. Thus the sandbox label did **not** establish that all file editing was unavailable. There was no Bash host tool, so tests, directory creation and Git execution were actually unavailable.
- `server/chat.ts` injected a blanket instruction to request confirmation before every mutation into every mode, even after the user had authorized implementation.
- `SessionRegistry.setMode()` changed only a field. The WebSocket handler announced the change without changing Claude's running SDK mode. Initial SDK allowlists also bypassed the shared permission callback.
- `shouldAutoAllow()` allowed commands in both Agent and Auto despite the documented difference. Ask's shared callback could prompt for and execute unknown tools, and cached grants could survive a downgrade.
- Native adapters omitted the lazy worktree-creation callback used by Claude. This affected edits targeting sibling repositories.

## Product contract

Permissions belong to the running Mitzo session, independent of the selected model or billing account. Ask/Agent/Auto are presets with the same meaning on every interactive provider path. They are edited in the existing chat control, on desktop and mobile.

| Capability                               | Ask       | Agent     | Auto      |
| ---------------------------------------- | --------- | --------- | --------- |
| Known read-only tools                    | Allow     | Allow     | Allow     |
| Workspace file edits                     | Deny      | Allow     | Allow     |
| Commands                                 | Deny      | Approval  | Allow     |
| Unclassified integrations and delegation | Deny      | Approval  | Approval  |
| Structured user questions                | Available | Available | Available |

Internal TodoWrite is an edit; TaskStatus is read-only. Task-board mutations and delegated Task execution are not silently classified as reads. Explicit session grants remain subordinate to Ask, skill restrictions and workspace checks. Approval requests are rechecked when the answer arrives, so a pending approval cannot defeat a mode downgrade.

The control displays the acknowledged effective mode, not an optimistic selection. Successful changes are saved and restored on switch/reconnect. If saving fails after the runtime accepts a change, clients still receive the effective mode and a separate persistence error. Requests to a running session serialize. Changing a mode does not undo an action already executing.

A preset is authorization policy, not a promise that a provider supports every tool. Concrete unavailable capabilities must return a specific explanation, while independent authorized work continues.

## Provider mapping

| Runtime                                                     | Ask                                  | Agent            | Auto             | Enforcement                                                                      |
| ----------------------------------------------------------- | ------------------------------------ | ---------------- | ---------------- | -------------------------------------------------------------------------------- |
| Claude Agent SDK, including configured Vertex chat accounts | `plan`                               | `default`        | `default`        | Mitzo PreToolUse gate and shared handler; `setPermissionMode()` for live changes |
| Codex app-server / ChatGPT account                          | Provider remains read-only/never     | Same containment | Same containment | Mitzo dynamic host tools enforce the current registry policy                     |
| OpenAI Responses API                                        | No native filesystem permission mode | Same             | Same             | Mitzo host executor gates function calls                                         |
| Gemini on Google Vertex                                     | No native filesystem permission mode | Same             | Same             | Shares the native host executor and session policy with Responses                |
| Other future model APIs                                     | No universal SDK permission enum     | Same             | Same             | Must implement the host policy contract before advertising interactive execution |

Claude's native `acceptEdits`, `bypassPermissions`, `dontAsk`, and classifier-based `auto` do not mean the same thing as Mitzo presets. In particular, Mitzo Auto is not unrestricted access and does not select Claude's native classifier mode. `allowedTools` grants approval rather than restricting the tool catalog. A PreToolUse hook is needed to enforce a live policy even when provider or project settings would auto-approve a tool. See [Claude SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

Codex separates sandbox capability from approval policy, and supports per-turn sandbox overrides. This adapter intentionally retains containment because native execution would otherwise bypass Mitzo's host checks. Host tool descriptions now explicitly explain why read-only provider status does not prevent Mitzo Write/Edit/Bash. See [Codex app-server](https://learn.chatgpt.com/docs/app-server).

A model's reasoning level, plan/collaboration mode, subscription, and model family are separate from permission policy. Direct model APIs request tool calls; the application owns execution authority.

## Command execution

Codex, Responses, and Gemini now have a Mitzo Bash tool. It uses a separate process of pinned `@anthropic-ai/sandbox-runtime`, with an immutable policy per invocation. No global sandbox configuration is shared between chats. The maintained runtime uses macOS Seatbelt or Linux bubblewrap; missing dependencies and degraded isolation fail closed. See [Sandbox Runtime](https://github.com/anthropics/sandbox-runtime).

The executor scrubs inherited credentials, creates a temporary HOME and scratch directory, limits output and runtime, terminates the process group on cancellation, and denies writes outside canonical workspace roots. Known provider and Mitzo credential stores are protected from native file and command tools. It never falls back to an unsandboxed command. This is protection for enumerated credential stores, not a claim that every arbitrary secret file on a workstation can be discovered automatically.

Linked Git worktrees receive narrow, validated permissions for their own index and branch metadata, while the shared object database and base checkout stay read-only. File edits, tests, and Git inspection remain available. `git add` and `git commit` that create objects are blocked and report this limitation explicitly: granting shell write access to shared objects would also allow deleting or corrupting other branches. Safe Git object creation requires a future trusted append-only operation; there is no unsandboxed fallback. Arbitrary worktree markers cannot grant access to another repository. Network access remains blocked for native Bash. Publishing, fetching dependencies, and more complex Git operations may need configured integrations or further explicit capabilities; Auto does not lift these execution boundaries.

## Validation and rollout

Regression coverage includes policy tiers, Ask downgrade and pending approvals, provider acknowledgment/failure/racing changes, persistence failure, reconnect, client state, both chat layouts, SDK hook authority, native files and commands. Real macOS tests exercise allowed writes, denied outside writes, protected reads through symlinks, command cancellation/output limits, network denial, and linked-worktree shared-object protection.

Run real OS tests with `MITZO_SANDBOX_INTEGRATION=1`; ordinary CI avoids assuming the runner permits nested sandboxing. Linux sandbox execution requires its documented dependencies and still needs a platform acceptance run. No live authenticated Claude/Codex/Gemini model turn or production deployment is implied by adapter/unit tests.

Existing Claude runtimes must restart/resume after deployment to acquire the new PreToolUse gate and host-tool surface; the same user-visible conversation can be resumed. Mode changes within those updated runtimes then apply in chat without another restart. Codex retains the dynamic tool catalog from thread creation: start a new Codex chat after deployment to obtain Bash. Resuming an older conversation still permits its existing host file tools.

Shared-object regression coverage uses disposable linked worktrees under the real OS sandbox: direct deletion, chmod-and-overwrite, object creation with `git add`, and empty commits are denied; workspace edits and Git reads continue to work, and `git fsck --full` verifies the base repository remains intact.
