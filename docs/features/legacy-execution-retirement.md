# Legacy execution retirement and linked native continuation

This implements the execution boundary under existing Telos milestones
`0d7dbc820e14e56d` and `fda22e426299398b`, parent `477c9d52d200c0f6`.
It does not complete deployment, live acceptance, gateway qualification or performance work.

## Execution boundary

New supported OpenAI work uses the existing Codex owner. Claude/Vertex keeps the
Claude Agent SDK. The OpenAI `ResponsesSession` and unused direct
`AnthropicSession` implementations and their runtime exports are removed. There
is no adviser exception to bring those engines back.

Old OpenAI Responses sessions remain readable. Their private checkpoint data,
public transcript, workspace, dirty files, queue identities and interrupted or
uncertain outcomes remain retained. They cannot execute an in-place next turn,
resume a queue or acquire a new custom runner. The old generic HTTP/WS startup,
owned runtime entry and direct wrapper reject before credentials, workspace
claims or provider effects. Stop remains available to cancel existing work.

`NativeResponsesStore` is still the historical data owner. Its original table and
checkpoint shape are retained; the extracted `ResponsesCheckpoint` type is a
historical/deferred-Gemini data contract, never a Codex thread identifier.

Gemini replacement remains deferred. `openResponsesChat`,
`OrdinaryLocalResponsesOwnedRuntime`, `NativeResponsesRunner` and the retained
native file/shell executor continue to serve Gemini only. Both runner admission
and `runDeferredGeminiLoop`/its event emitter enforce the provider discriminator
at runtime. Old names identify retained data and compatibility ownership; they
do not authorize new OpenAI execution. The duplicate host tools cannot be
removed until the deferred Gemini caller is migrated separately.

## Deliberate linked continuation

The interactive operator closes the original live execution and chooses an
unused prepared Local Mac native repository workspace, account, model, target,
agent, permissions and a separate new request using the normal runtime picker.

1. `POST /api/sessions/:id/native-continuation/preview` accepts
   `{ command: OrdinaryCodexFirstCommand }`. It requires the source OpenAI account
   and profile revision and an explicit prepared repository workspace. It returns
   the exact new command, context and review hash plus the original selection,
   new session ID, omitted-content counts and retained uncertainty/pending-command
   counts. A selected native model, permission or logical target change is
   displayed explicitly. Location remains Local Mac and normal native admission
   qualifies the actual configured host/account; no automatic target fallback is
   performed.
2. `POST .../commit` accepts `{ reviewHash, acknowledgeUncertainOutcomes,
acknowledgeSelectionChange }`. Commit rechecks the source revision, operator
   and actual absence of a live source owner. Displayed uncertainty and selection
   changes require explicit acknowledgement. The exact reviewed command is
   admitted through the existing ordinary first-command handler, including its
   SSE, capability, account, workspace and permission checks.
3. `GET /api/sessions/:id/native-continuation` reads persisted source/native
   lineage for the reviewing login. The same private history owner stores these
   receipts; there is no second session registry, scheduler or native-history
   implementation.

The context contains only public user/assistant text, bounded to the last 48,000
characters. The preview reports prefix truncation and omitted non-text blocks.
It excludes tool arguments/results, images, thinking, boot configuration,
credentials and private provider checkpoints. Historical text is quoted as data;
it authorizes no repetition of previous requests. The separately entered new
request is the only new instruction. Pending commands remain with the source;
they are never copied into the native queue.

Acknowledging an unknown historical outcome does **not** reconcile, clear or
rewrite that outcome. The new conversation is instructed to inspect actual
state before new changes and never repeat an earlier request or tool action.
Original histories and uncertainty records remain intact.

The link is claimed durably before native admission. A lost commit reply,
ambiguous native admission or restart is observed by the original command and
new session IDs. Exact commit retries never dispatch again. A positively
consumed existing ordinary command receipt may settle the link as consumed;
otherwise it stays uncertain for inspection. No checkpoint is renamed, no tool
is replayed and no source worktree is reset or deleted.

## Caller and retention inventory

The source inventory uses actual imports/call sites rather than the word
“Responses” alone:

| Source/caller                                                                                                    | Disposition and evidence                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terminal-adviser-model.ts`, `terminal-plan-adviser.ts`; app wiring into TerminalAdviser and AgentLibraryAdviser | Migrated to the selected scoped native harness owner. The former direct OpenAI/Vertex constructors are removed by the adviser slice. Output/tool/context policy remains feature owned.                                                                                                 |
| `ordinary-task-worker.ts`, `ordinary-scoped-command.ts`, `task-orchestrator.ts`, `session-spawn-handler.ts`      | Worker slice uses ordinary runtime owners and explicit inherited/reviewed selection. Selection-free spawn is unavailable rather than a billing/account fallback.                                                                                                                       |
| `chat.ts:startChat/_startChatInner`                                                                              | Local unguarded OpenAI execution rejects before credentials or preparation. Supported OpenShell API Codex routing remains intact. Retained local private history cannot be adopted in place as a native checkpoint.                                                                    |
| `chat.ts:start/sendOwnedLocalResponsesCommand`, cold queue continuation and `canResumeOwnedLocalResponsesDriver` | Gemini-only execution. Legacy OpenAI cold/queue continuations refuse; cancellation and historical reads remain available.                                                                                                                                                              |
| `responses-chat-session.ts -> native-responses-runner.ts -> sdk-adapter.ts`                                      | Runtime-discriminated deferred Gemini compatibility only. No OpenAI constructor, credential fallback or custom OpenAI loop remains.                                                                                                                                                    |
| `packages/harness/src/providers/responses-session.ts`, `anthropic-session.ts`                                    | Removed unused/custom engines and public runtime exports after consumer migration. Claude SDK integration remains.                                                                                                                                                                     |
| `legacy-provider-checkpoint.ts`, `native-responses-store.ts`, historical admission/ack/queue readers             | Retained historical data, exact binding, private checkpoints, queue receipts and never-replay semantics. Linked lineage is stored beside retained history.                                                                                                                             |
| `native-tool-executor.ts`, host hooks, owned Responses capability/custody helpers                                | Retained for genuine deferred Gemini tools, policies and saved data. They are not reachable as a supported OpenAI execution fallback.                                                                                                                                                  |
| `web-search-adapters.ts:searchOpenAI`                                                                            | Removed unused direct Responses search after its only wrapper caller became Gemini-only. Codex owns supported OpenAI native search. Approved account-bound Claude SDK search and deferred Gemini grounding remain.                                                                     |
| `account-session-name.ts`, `auto-rename.ts`                                                                      | Account-bound conversations use deterministic naming fallback; they do not send task text to an implicit naming account. Legacy unbound naming inference remains a separate metadata consumer, not an agent loop.                                                                      |
| `account-profiles.ts`, model catalog, credential resolution and key-management helpers                           | Retained provider configuration/catalog/authentication. Names containing Responses do not make them agent execution.                                                                                                                                                                   |
| `openai-key-gateway.ts:validateOpenAIKey`                                                                        | Retained **diagnostic inference**, not non-inference metadata: attended credential save discloses the bounded `gpt-6-luna` check and billing account. It is not a conversation/tool loop and was not run during implementation.                                                        |
| `native-commands.ts -> deliberate-admission.ts/fusion-admission.ts -> reasoning/*`                               | Paid-reasoning consumers were audited separately; their selected phase/account/model/target and real usage/budget migration is a coordinated remaining slice until its final regression evidence is recorded. No claim of completed full retirement is made from this inventory alone. |

## Offline regression evidence and moved coverage

New linked-continuation regressions use actual SQLite storage and the production
Express router with controlled ordinary-admission callbacks. They cover the
reviewed public context, account/profile/source fencing, live-source refusal,
explicit selection/uncertainty acknowledgement, private history retention,
lineage, bounded context and accepted/uncertain lost replies across restart.

Actual old ingress regressions exercise `startChat`, the generic HTTP owner,
`openResponsesChat`, the owned runtime constructor and the native runner. They
verify rejection before credential resolution, workspace acquisition, model
requests or tool effects, while preserving old transcript/private state and
dirty source files.

The retained Gemini regressions exercise signed history, tool outcomes persisted
before further effects, FIFO/cold queue continuation, cancellation, account/model
binding, source revocation, unsupported images, private credentials, crash
uncertainty and no effect replay. Shared wrapper lifecycle tests use explicit
Gemini fixtures. Their conservative networking policy stays unavailable; Gemini
failures keep their retained failure behavior. OpenAI image and sanitized-error
behavior belongs to existing native Codex owner regressions; old direct-engine
response parsing/tracing tests were retired with the removed implementations.

No live model test, staging operation, deployment or production configuration
change is part of this evidence. Local checks use one worker and a 1 GiB heap;
broad checks and combined review remain the integrating owner's CI/review work.
