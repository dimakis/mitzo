# OpenAI API migration to embedded Codex

New ordinary OpenAI conversations use the existing Codex App Server integration
with either API billing or ChatGPT subscription authentication. Agent guidance,
account identity and execution environment retain their separate controls.
Dimitri approved this direction on 17 October 2026. Telos migration item
`2c57d6a14b01eda3` belongs under runtime outcome `2f58567a6c487079`.

## Source status, 21 October 2026

[PR 1087](https://github.com/dimakis/mitzo/pull/1087) implements the local dispatch
and workspace changes below against accepted main `3f6c6aea`. This describes source
behavior and offline qualification; it does not establish production activation or
measure which account the user uses most.

| Conversation                                                            | Engine and ownership                                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| New OpenAI API on Local Mac                                             | Codex is preferred when the configured local Codex route is available. The selected API account owns an isolated private login home. |
| ChatGPT subscription on Local Mac                                       | Existing Codex engine and host-login custody.                                                                                        |
| OpenAI API or ChatGPT on OpenShell                                      | Existing Codex engine with its separate sandbox and authentication owners.                                                           |
| Retained local Responses conversation or explicit saved Responses route | Original Responses engine, account, history, checkpoints and queue.                                                                  |
| Claude Vertex on Local Mac                                              | Existing Claude SDK engine with the shared local workspace owner.                                                                    |
| Gemini on Local Mac                                                     | Existing Gemini adapter and shared Responses infrastructure with the same local workspace owner.                                     |

The runtime picker derives Codex for new local OpenAI API selections. It does not
rewrite a retained session or saved explicit Responses route. Existing enablement
and target configuration gates remain in place; this PR does not activate a host.

## Existing local repositories and worktrees

Every local account can send its first command without selecting or preparing a
repository. The capability inventory advertises this only when a local base repo
is configured. Admission resolves the server-owned `primary` repository, allocates
through the existing workspace ledger and creates an isolated linked Git worktree.
The Repository editor also lets the user select a different configured checkout.
Neither route imports the local repository through GitHub or prepares a sandbox.
OpenShell retains its sandbox repository preparation requirement.

New local worktrees fetch and pin the upstream main/default branch. A trusted
agent-specified start point takes precedence. Existing worktrees return before
fetching and retain their branch, commits and dirty files. Upstream failure blocks
a new default worktree instead of silently starting from stale main or running in
the shared source checkout. A repository without a remote uses its local default
branch. Source checkouts and local main are never reset or pulled in place.

This behavior lives in shared `worktree.ts` and the existing repository workspace
owner, not a Vertex-only dispatch branch. Existing configured `runtimeSymlinks`
remain opt-in. Local source and linked/common Git identities are pinned and
revalidated through reservation, task claim and original-workspace continuation.
Import checks for independent sandbox checkouts remain separate and strict.

## Local API authentication and dispatch

`FrozenHostCodexBootstrapAuthority` now supports both OpenAI account types through
the same native conversation owner. `FrozenHostCodexApiLogin` composes the existing
API credential authority with a private, exclusive per-bootstrap home and retained
custody in the existing conversation store. It pins the selected account, physical
home, credential-file identity and key digest. The subscription path continues to
use its existing host-login owner.

`launchIsolatedApi()` sends the selected key through private stdio login RPC with
API mode forced and file credential storage. Keys do not enter arguments, the
process environment, public bindings or diagnostics. API `account/read` proves
authentication mode, not billing identity; the original credential owner remains
authoritative before and after awaited operations. Resume reuses the retained home
through `launchIsolatedApiResume()`, after custody checks. Missing, replaced or
rotated credentials fail closed and retain history; transparent key renewal is
not implemented by this slice.

API commands use the existing Library context, local admission, linked-worktree
reservation, native conversation queue and tool transport. The actual composer
entry/startup regression uses real authentication, SSE connection ownership,
SQLite admission and native session startup with only provider RPC replaced. It
proves that the command is consumed before the first provider turn and that an
exact retry returns the same session without another bootstrap or turn.

## Responses retirement

Prefer Codex for new OpenAI agent conversations. Do not delete the shared Responses
implementation yet: retained OpenAI sessions still require their original owner,
and Gemini still uses its infrastructure. Responses checkpoints cannot be renamed
as Codex threads. An explicit context transfer may later create a separate linked
conversation. Account discovery, key management and bounded direct API helpers
also remain useful independently of the agent loop.

Full retirement still requires retained-history and restart qualification,
credential-renewal behavior, configured MCP multimodal-result coverage and a caller
audit separating Gemini. Ordinary user-image serialization does not prove MCP
image-result parity. Keep these rollout milestones open until their own acceptance
criteria pass; source integration alone does not close every migration milestone.

## Verification and activation

Focused offline checks cover account routing, private API custody and reopen,
native bootstrap, actual API composer startup and exact retries, existing dirty
worktree continuation, fresh upstream bases and explicit refs. Browser checks use
the real responsive chat, settings, picker, composer and application shells with
all network requests intercepted. They cover all four local account types, phone
WebKit/Chromium and desktop Chromium, dark/light themes and alternate fonts.
These checks make no model calls.

Use one local test worker and a 1 GiB Node heap. Broad frontend build/type and
combined-result checks run in CI. Canonical staging remains stood down. Any live
qualification requires a separately authorized target and an explicitly supported
Luna model, announcing the exact charged account and model first. Production
deployment and activation require a separate explicit user action.

## References

- [App Server authentication](https://learn.chatgpt.com/docs/app-server#authentication-modes)
- [Existing runtime contract](session-runtime-selection.md)
- [Retained Responses continuity](local-responses-continuity.md)
- [Repository editor and UI evidence](ui-design-system.md#repository-settings-editor)
- [Account compatibility repair PR 970](https://github.com/dimakis/mitzo/pull/970)
