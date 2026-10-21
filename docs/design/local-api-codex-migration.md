# OpenAI API migration to embedded Codex

Use the existing Codex App Server integration for new ordinary OpenAI conversations
with either API billing or ChatGPT subscription authentication, on Local Mac or
OpenShell. Agent guidance, account identity and execution environment retain their
existing separate controls. The primary engine change is Local Mac plus OpenAI API;
the existing OpenShell API route already uses Codex.

Dimitri approved this direction on 17 October 2026. Telos migration item
`2c57d6a14b01eda3` belongs under runtime outcome `2f58567a6c487079`.

## Source audit, 21 October 2026

The migration is incomplete on accepted main `afc86b36`. This is a source audit,
not an observation of the activated release or a measurement of account usage.

| Ordinary conversation                               | Current implementation                                                  | Retirement consequence                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| OpenAI API on OpenShell                             | Codex, through the existing ordinary OpenShell owners                   | Keep this route; it already uses the intended engine.                                                               |
| ChatGPT subscription on OpenShell or the local host | Codex, with separate broker/host-login configuration                    | Preserve its account and login ownership.                                                                           |
| OpenAI API on Local Mac                             | `NativeResponsesRunner`, through the ordinary local Responses owner     | New local API dispatch must move to Codex before disabling this creation path.                                      |
| Retained local Responses conversation               | Original private Responses history, checkpoints and queue custody       | Preserve original-owner continuation and inspection until explicit retirement; these records are not Codex threads. |
| Google Vertex/Gemini                                | Gemini adapter using the shared Responses runner/session infrastructure | Preserve or extract the Gemini dependency before removing shared code.                                              |

The relevant source owners are `ordinary-session-runtime.ts`,
`ordinary-local-codex-capabilities.ts`, `ordinary-local-codex-entry.ts`,
`frozen-host-codex-bootstrap.ts`, `chat.ts`, `responses-chat-session.ts` and
`native-responses-runner.ts`. `launchIsolatedApi()` provides the accepted private
API authentication primitive, but the ordinary local bootstrap still requires
`openai-codex` host-login custody. Source acceptance of that helper did not complete
local API dispatch, restart or credential-renewal ownership. The recent Local API
command-networking work improves the existing Responses route; it is not a Codex
migration.

The recommendation remains to use Codex for all **new OpenAI agent conversations**,
retiring the duplicate OpenAI agent loop after the local dispatch and retained-history
slices pass. First prove selected API billing, Library/tool/MCP/context behavior,
images and model/thinking changes, queue/Stop, reconnect/restart and credential
loss through the actual ordinary owners. Then stop new Responses conversation
creation while retaining legacy history and recovery. Remove only the unused
OpenAI loop after auditing retained callers and separating Gemini. Account/model
discovery, key management and bounded direct API helpers have separate purposes
and are not removed merely because agent orchestration moves to Codex.

## Implementation boundaries

Reuse the existing account store, credential owner, command admission, workspace
reservation, Codex transport, conversation queue and Mitzo tool executor. Accounts
retain their opaque IDs, provider and billing identity. New API conversations must
not acquire a ChatGPT login or another API credential as a fallback. Concurrent
accounts need separate private credential homes; sharing an engine implementation
does not mean sharing mutable process authentication.

The approved picker remains Agent, Account, Model, Thinking and Run on, with
software derived from the supported route. Work OpenAI must remain selectable
throughout rollout. Preserve current activation holds until their compatibility
conditions have been met; migration source acceptance does not activate a route.

Old Responses conversations stay with their original history and engine. A future
explicit context transfer can create an independent linked Codex conversation;
Responses checkpoints cannot be relabeled as Codex threads. Preserve Gemini's
shared runner and direct API helpers that do not implement an agent loop.

## Test first delivery slices

Each slice starts with failing offline regressions, implements the required
behavior, and commits tests and implementation together in a small PR. CI and
Centaur review cover the actual final head.

1. **API authentication**, milestone `5179befbe1f9a4c4`. Extend the existing
   isolated Codex transport with private API login. Preserve executable pinning,
   private-home ownership, account revocation and cancellation checks. Test
   separate accounts, missing credentials and refusals without inference. The
   initial bootstrap is dormant until ordinary owner integration.
2. **Agent context and tools**, milestone `b57a4c179d1d9e68`. Preserve Library
   profiles, compiled context, configured tool selection, MCP and approvals through
   Codex. Replace the assumption that configured tools require the Responses loop
   with actual supported route capabilities. Cover images and supported future
   model/thinking changes. User image serialization is independent of MCP results:
   non-text blocks returned by configured MCP tools currently become unavailable
   placeholders, so user-image coverage does not establish multimodal tool-result
   parity.
3. **New local API dispatch**, milestone `04e660858b274b27`. Extend
   `ordinary-session-runtime.ts`, account capability projection and existing local
   admission/dispatch owners. Reuse existing credential authority and durable
   command/workspace stores. Verify first send, exact retries, frozen queued
   settings, Stop and original-owner continuation; no new registry or scheduler.
4. **Retained history and rollout**, milestone `f72068073befbbaf`. Test new/old
   session dispatch, reconnect and restart, credential loss and original-workspace
   recovery. Preserve old Responses authority and complete separately authorized
   live qualification before production activation.
5. **Legacy OpenAI cleanup**, milestone `2cfd18b88ed4b32d`. After retained OpenAI
   usage no longer requires it, remove unused OpenAI agent-loop branches. Audit
   callers first and retain Gemini and bounded API helpers.

## Initial authentication slice

`CodexAppServerClient.launchIsolatedApi()` starts a new private Codex process with
API authentication forced, file credential storage and the existing constrained
tool configuration. The captured executable must belong to that private home.
Existing authentication or configuration, including dangling symlinks, refuses
bootstrap. The caller must hold the existing exclusive home and admission claim.

The caller supplies the original account binding, selected credential resolver and
current-authority check. The binding is copied and frozen. After initialization,
the selected key reaches `account/login/start` through private stdio RPC, followed
by an API authentication-mode check. Keys do not enter process arguments, the
process environment, public bindings or public error diagnostics. Codex persists
its login inside the caller's private home. This creates a private credential copy
whose later lifecycle remains the owning runtime's responsibility.

API `account/read` reports an authentication mode, not the identity of the billing
credential. The existing credential owner must establish that identity before
bootstrap and after awaited operations; API mode alone cannot establish it.
The returned transport's public RPC allowlist cannot perform another login.

This slice does not wire new chat dispatch, establish durable API credential
custody, implement refresh/cold resume, enable configured tools on Codex or enable
a production switch. The following slices must compose those existing owners
before a user can select the migrated route.

## Verification and rollout

Use one local test worker and a 1 GiB Node heap. Leave broad checks to hosted CI.
Canonical staging and its pipeline remain stood down. A live test requires a
separately selected authorized target; real model tests explicitly use a supported
Luna model and announce the exact model and charged account. Production deployment
and activation require a separate explicit user action.

PR #970 repairs account compatibility and adviser credential recovery. It is not
the migration. Evaluate its reusable account changes against the selected owners;
adviser fixes can be accepted independently. Do not import the entire PR solely to
enable API Codex.

## References

- [App Server authentication](https://learn.chatgpt.com/docs/app-server#authentication-modes)
- [Codex authentication configuration](https://learn.chatgpt.com/docs/auth)
- [Existing runtime contract](session-runtime-selection.md)
- [Retained Responses continuity](local-responses-continuity.md)
- [Runtime and picker foundation PR 930](https://github.com/dimakis/mitzo/pull/930)
- [Account compatibility repair PR 970](https://github.com/dimakis/mitzo/pull/970)
