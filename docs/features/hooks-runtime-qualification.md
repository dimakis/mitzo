# Hook support and runtime qualification

Observation date: **13 November 2026**. Source baseline: `778c55bcc` (accepted
main); bridge repair: `aded988` and review corrections: `988d7810a`. Telos slice: `0dd9bb6a-c919-4c07-9599-7b5c594f2168`.
This is an inventory and offline qualification increment. It does not establish
live provider acceptance, complete hook parity, deployment or adoption.

Reuse the [runtime readiness contract](../runtime-readiness.md), Telos
`65129503d34b4bc3`, and native harness work `477c9d52d200c0f6`. The former's
accepted slice provides scoped observations; its remaining qualification work and
the native harness feature remain active. Configuration, exposed tools, callable
handlers, approval, execution and provider acceptance are distinct evidence states.
Keep these owners; this document creates no capability registry or admission grant.

## Pinned source and interfaces

| Component              | Pin / owning source                                                                                                    | What the pin establishes                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK             | `@anthropic-ai/claude-agent-sdk` **0.3.322**, exact package/lock pin                                                   | Callback types and declared `HOOK_EVENTS`; event firing still needs route evidence                                                                                                  |
| Bundled Claude engine  | manifest **2.1.322**, darwin-arm64 declared SHA-256 `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450` | Installed package metadata inspected; executable was not launched or rehashed in this increment                                                                                     |
| Claude process sandbox | `@anthropic-ai/sandbox-runtime` **0.0.75**                                                                             | Existing outer process boundary, independent of SDK tool decisions                                                                                                                  |
| Codex native Mac       | **0.160.0**, qualified artifact SHA-256 `112fae7a5a1223e673c8a1791d32338f37df8b527ff1159bb8adac6c4dbf1b4b`             | Existing [native permission contract](codex-native-permission-protocol.md) and [alias qualification](codex-native-alias-qualification.md); no claim about arbitrary installed bytes |
| Mitzo adapters         | `server/hook-bridge.ts`, `server/native-hooks.ts`, `server/chat.ts`, `server/codex-chat-session.ts`                    | Product-specific wiring and eligibility, described below                                                                                                                            |

Dependency or binary upgrades require their own source/behavior assessment and
fresh qualification; an upstream feature flag does not add product support.

## Extension contract

Project commands come from the selected workspace's `.claude/settings.json`.
They are repository-controlled shell code. Tool consent is not permission to
install or run a hook, and a hook's `allow` is never a Mitzo permission grant.
The existing runtime, account, workspace, skill and cancellation owners remain
authoritative after rewrites and before effects.

The Claude bridge accepts synchronous `type: "command"` entries grouped by
event, optional regex `matcher` (`*` means all tools in the PreToolUse consumer),
and optional group `timeout` in seconds (positive, maximum 300; default 60).
Unsupported event names/types/options, invalid JSON, invalid regexes and invalid
timeouts fail configuration loading visibly before callbacks are constructed.
Prompt/agent/HTTP and asynchronous hooks are unsupported by this bridge. This
does not describe every configuration feature of standalone Claude Code.

Callbacks use `/bin/sh -c`, the selected cwd, JSON stdin and bounded stdout/stderr
(256 KiB each). Empty stdout is an explicit successful no-op. Nonempty stdout
must be a JSON object. Canonical `hookSpecificOutput` is preserved, including its
matching `hookEventName`; legacy flattened event fields remain supported. Mixed
conflicting fields, an event mismatch, invalid common permission fields or async
output fail visibly. Canonical PreToolUse denial blocks the host decision; ask
requests the existing approval owner; rewritten input reaches that owner before
approval. Hook allow cannot override Ask mode, workspace limits or revocation.

Command errors, timeouts, cancellation and malformed output return
`continue: false` with a safe stage/recovery reason. Post-tool diagnostics say the
tool may already have run. Do not replay an effect to recover hook output. Logs
record a stable code, stage and session/event identity without command text,
stdout, stderr or environment values. The protected runner retains existing OS
fences; an unavailable protection owner must not cause a host-execution fallback.

Every registered bridge matcher and the merged PreToolUse permission callback set
`onFailure: "block"`. The pinned SDK validates the remaining event-specific fields
and refuses startup if the engine cannot honor this policy or the retained session
did not register the hooks. Stop, SubagentStop, TaskCompleted and TeammateIdle are
SDK exceptions: this option is ignored. Their supported specific output is
validated locally (only additionalContext for Stop/SubagentStop, none for the other
two). Command/output failures still produce the explicit stop result, but an SDK
callback transport failure or SDK-level timeout on these four events has **no
qualified blocking guarantee**. Do not use them as sole authorization gates.

Environment handling differs: the Claude bridge filters specific controller
secrets from the supplied SDK environment, and does **not** promise a credential
allowlist. The Codex compatibility factory creates a temporary HOME and permits
only PATH, temporary-directory and locale variables plus CLAUDE_PROJECT_DIR.
Neither interface grants an internal API token. Full account isolation depends on
the owning process/credential boundary, not these environment transformations.

## Events and route limitations

The pinned SDK declares these events, which the bridge recognizes for callback
registration. Recognition does **not** establish that every event fires in a
particular Mitzo route:

| Family                    | SDK-declared event names                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Tool and permission       | PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest, PermissionDenied       |
| Session and turn          | SessionStart, SessionEnd, UserPromptSubmit, UserPromptExpansion, Stop, StopFailure                    |
| Agent and task            | SubagentStart, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted                                 |
| Context and configuration | PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Setup, ConfigChange, InstructionsLoaded     |
| Workspace and display     | WorktreeCreate, WorktreeRemove, CwdChanged, FileChanged, DirectoryAdded, MessageDisplay, Notification |
| Elicitation               | Elicitation, ElicitationResult                                                                        |

| Route / adapter                                     | Effective project-hook behavior                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK bridge                                   | `chat.ts` skips project callbacks for adviser scope or SDK credential isolation. An agent context recipe suppresses bridge SessionStart callbacks. Guarded ordinary SDK and accepted-pack routes use `settingSources: []`; legacy SDK routes may load project settings independently and need separate duplicate-dispatch qualification. No new eligibility is enabled here. |
| Codex enrolled Local Mac                            | Project commands remain disabled even if MITZO_TRUST_PROJECT_HOOKS=1. The empty NativeHooks adapter still qualifies supported host/MCP tool results. Native execution tools do not inherit compatibility hook callbacks.                                                                                                                                                     |
| Codex selected agent-tool catalog                   | Project commands remain disabled. Selecting tools does not authorize repository command extensions.                                                                                                                                                                                                                                                                          |
| Legacy local Codex compatibility                    | Explicit operator trust via MITZO_TRUST_PROJECT_HOOKS=1 is required. Supports only SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd command hooks. Unsupported event/type configuration fails. This route is bounded compatibility, not full SDK parity.                                                                                                              |
| Codex OpenShell                                     | Host project-hook runtime is not created. Do not run host hooks as a sandbox substitute.                                                                                                                                                                                                                                                                                     |
| Native Codex engine hooks / plugins / legacy notify | `codex-runtime-policy.ts` disables hooks/plugins and clears notify, including when native shell execution is enabled. Native flag availability does not establish supported extensions.                                                                                                                                                                                      |

The compatibility adapter checks regex matchers against tool name/source/reason;
it does not implement all SDK matcher semantics. PreToolUse updates are checked by
the existing tool/permission consumer; ask forces its prompt, deny blocks. Only
successful tools reach PostToolUse. Startup context is used only where the legacy
startup path invokes SessionStart; an existing context owner may skip it. Stop
hooks gate completion but nonblocking Stop context does not trigger another model
turn. SessionEnd is asynchronous cleanup, cannot retroactively block completed
effects, and currently has no user-visible failure receipt. Its discarded failure
diagnostic is a retained gap, not qualified parity.

SDK-only event-specific output fields outside the common permission/context
contract are delegated to the pinned SDK's blocking validation path, except for
the four strictly validated exceptions above, without a general product support claim.
In particular, this increment adds no independent notification implementation:
approval/notification preferences, quiet hours, preview privacy and deduplication
continue to belong to the existing shared owners. `terminalSequence` output is
explicitly unsupported; hooks cannot enable an independent SDK terminal alert.

## Account / engine / target matrix

These are account **classes**, not an inventory of configured credentials. The
selected current chat identifies Host Mac Personal ChatGPT; that observation
does not qualify its account or model for a separate live test. No credential
profiles or private provider histories were read. Every live cell below is
**unverified in this increment**.

| Account class                                                                                            | Engine          | Target              | Source support decision                                                                              | Offline evidence / current limitation                                                              |
| -------------------------------------------------------------------------------------------------------- | --------------- | ------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ChatGPT subscription, verified host login                                                                | Codex           | Local Mac           | Supported with enrolled native owner and qualified artifact                                          | Routing/protocol checks pass; owned-runtime fixture blocked by Git metadata fence                  |
| OpenAI API / qualified Responses provider                                                                | Codex           | Local Mac           | Supported through existing enrolled API owner; arbitrary gateways need their own qualification       | Routing checks pass; owned API fixture blocked by Git metadata fence                               |
| ChatGPT subscription, brokered OAuth pinned to target                                                    | Codex           | Dedicated OpenShell | Supported under existing account/target custody                                                      | Owner fixtures pass except one HTTP-listener-dependent check; Ask mode unsupported                 |
| OpenAI API, provider identity pinned to target                                                           | Codex           | Dedicated OpenShell | Supported only for explicitly enabled, authorized target/provider tuple                              | Routing and OpenShell owner fixtures; live gateway/model behavior unverified; Ask mode unsupported |
| Claude subscription / personal sign-in                                                                   | Claude SDK      | Local Mac           | Supported through its existing SDK account owner                                                     | SDK query lifecycle fixtures pass; owned account fixture blocked by Git metadata fence             |
| Anthropic API / Messages account                                                                         | Claude SDK      | Local Mac           | Supported through existing API credential owner; syntax alone does not qualify an arbitrary endpoint | SDK query lifecycle fixtures pass; owned account fixture blocked by Git metadata fence             |
| Anthropic Vertex / ADC                                                                                   | Claude SDK      | Local Mac           | Supported through existing Vertex account owner                                                      | SDK query lifecycle fixtures pass; owned account fixture blocked by Git metadata fence             |
| Any Claude account                                                                                       | Claude SDK      | OpenShell           | Unsupported tuple; must refuse before allocation                                                     | Ordinary routing negative fixtures pass                                                            |
| Unbrokered sandbox ChatGPT identity, legacy Responses engine for new work, arbitrary unqualified gateway | Selected engine | Either              | Unsupported or requires separate qualification; never fall back to another account/provider          | Ordinary routing/auth negative fixtures pass                                                       |

The routing matrix is owned by `resolveNewOrdinarySessionRuntime` and account
admission, not by this table. Custodian deployments may require OpenShell even
where Local Mac is otherwise supported. Gemini remains outside this slice.

## Dated evidence and repeatable checks

All results below are **13 November 2026**, single worker, 1 GiB Node heap, no
inference, production configuration, staging or deployment. Tests reused the
already installed matching SDK 0.3.322, Vitest 4.1.12 and Zod 4.6.6 through local
dependency links; a fresh lockfile install was not performed. Test temp files and
raw logs remain under ignored `test-results/hook-runtime/` in this checkout.

| Evidence                                         | Result                                                                                          | Scope                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial hook contract red run                    | 18 failed, 24 passed                                                                            | Reproduced canonical decision loss, silently ignored configuration and fail-open callback errors                                                                                                                                                                       |
| Additional malformed-output red run              | 3 failed, 43 passed                                                                             | Reproduced invalid common permission fields                                                                                                                                                                                                                            |
| Hook/consumer/adapter regression run             | **279 passed, 5 files**                                                                         | hook-bridge, session-permission-policy, native-hooks, codex-chat-session, chat-sdk-query-adapter                                                                                                                                                                       |
| Final hook/consumer/SDK lifecycle regression run | **315 passed, 6 files**                                                                         | The five suites above plus ordinary-local-vertex-sdk-query; verifies review corrections, safe diagnostics and ignored-event output handling                                                                                                                            |
| Runtime qualification run                        | **729 passed; 82 failed/blocked, 11 files**; one listener error                                 | Seven suites pass entirely. 81 failures stop at disposable `git init` under TaskExecution's metadata fence; the remaining OpenShell check cannot bind supertest's local listener under `network: none`. No product assertion result is inferred from blocked fixtures. |
| Focused TypeScript command                       | **Blocked: 1 GiB heap exhausted**, exit 134                                                     | noEmit produced no compilation artifact; full type/build validation remains for CI                                                                                                                                                                                     |
| Lint / formatting / source artifacts             | **Passed** on the corrected source; runtime revision **v1.0.1135-hook-failure-policy**          | Registered sources retained and regenerated; not a replacement for hosted CI or exact-head review                                                                                                                                                                      |
| Independent local read-only reviews              | Two reviews; callback failure-policy and diagnostic findings fixed and rechecked on `988d7810a` | Development reviews, not Centaur final approval                                                                                                                                                                                                                        |

Reproduce the focused hook run after installing the lockfile dependencies in an
authorized development checkout:

```sh
mkdir -p test-results/hook-runtime
TMPDIR="$PWD/test-results/hook-runtime" NODE_OPTIONS=--max-old-space-size=1024 \
  npm test -- server/__tests__/hook-bridge.test.ts \
  server/__tests__/session-permission-policy.test.ts \
  server/__tests__/native-hooks.test.ts \
  server/__tests__/codex-chat-session.test.ts \
  server/__tests__/chat-sdk-query-adapter.test.ts \
  server/__tests__/ordinary-local-vertex-sdk-query.test.ts --maxWorkers=1
```

The runtime run selects `ordinary-session-runtime`, `session-harness-routing`,
`runtime-readiness`, `ordinary-local-codex-owned-runtime`,
`ordinary-local-api-codex-owned-runtime`, `ordinary-local-vertex-owned-runtime`,
`ordinary-local-vertex-sdk-query`, `ordinary-openshell-codex-owned-runtime`,
`codex-conversation`, `query-loop`, and `codex-runtime-policy` from
`server/__tests__/*.test.ts`, using the same environment and worker limit.
Run the Git/listener fixtures in CI or a separately admitted fixture environment;
do not retry an unchanged fence or weaken an assertion to produce a pass.

| Behavior          | Offline evidence                                                                                            | Still required for live operation verification                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Streaming         | query-loop and Codex conversation event fixtures                                                            | Selected account/model produces ordered provider streaming events                            |
| Tool continuation | permission consumer, SDK query lifecycle and Codex conversation fixtures                                    | Approved tool executes once and its exact result continues on the same account/thread        |
| Cancellation      | SDK query retirement/interrupt and Codex conversation fences                                                | Stop reaches selected runtime; no late effects or silent replay                              |
| Resume            | SDK query continuation, Codex retained queue; account-specific local fixtures currently blocked             | Cold resume preserves account, task root, provider thread and uncertainty                    |
| Account isolation | routing/auth mismatch fixtures and retained owner guards; account-specific local fixtures currently blocked | Independent selected accounts/targets cannot share credentials, authority or private history |

Live tests require a separately selected and authorized target, an explicitly
named **supported Luna model** and its **charged account** before execution. No
model is selected by this document. If the chosen engine/account has no supported
Luna model, the live cell remains blocked pending the user's explicit exception.
Do not substitute the current chat's model, staging or production.

## Remaining acceptance

Qualify event firing and failure display through each enabled real SDK route,
resolve the legacy project-setting duplicate-dispatch question and SessionEnd
diagnostic gap, then rerun the final matrix after source acceptance, required CI
and exact-current-head Centaur review. Permission changes require the independent
review specified by the landing policy. Integration, deployment and runtime
adoption receipts must be recorded separately. This slice remains active until
those required delivery and qualification decisions have evidence.
