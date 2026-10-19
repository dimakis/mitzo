# Symposium native request preparation contract

Started 17 October 2026. The user selected the OpenAI Responses API account
route first and authorized implementation with Sol6.1 agents. The full native
contract and ordinary dispatch integration remain incomplete.
Parent: `c0851ba23fcc5d04`. This specifies an extension of ordinary Codex;
it does not qualify a runtime, install joining authority or authorize activation.

## Stop semantics clarified during continuation

Stop uses ordinary best-effort cancellation. A close that wins the native
one-use attempt decision prevents a delayed sender from starting it. Once the
attempt commits, dispatch may reach the provider even if Stop follows immediately;
the ordinary transport owner tries to cancel, retains uncertainty if acceptance
is unknown, and never permits replay. A crash after commitment but before socket
write is also consumed uncertainty. Stop does not acquire a new host revocation
barrier or wait for earlier admissions to settle. These are the selected semantics;
the ordinary dispatch integration remains incomplete.

This clarification is specific to Stop. Changes to source, access, account,
route, model, settings, or other dispatch authority still invalidate a stale
prepared request before a new attempt. Do not treat a caller epoch, prior host
check, or Stop semantics as proof that those authorities are ordered against
native consumption.

## Source baseline and evidence

This continuation started from accepted main
`d0b06dc200a154ef055a4e6f0eb386c4eb208607`, including #1000 and #1002, and refreshed
accepted main to `f5c1fd4b01e3d6f33cfaa7b950f77d5ef847e7d3` (#995) during independent reassessment. The checkpoints
below describe the earlier foundation implementation, not a replacement baseline.
The source bundle now composes retained formatter/attempt candidates; its exact
tree and check results are recorded independently from #1000 acceptance.

The accepted #990 checkpoint is `02196e5d8ad7ee0f253c23c831d3fc8540866336`.
GitHub main was freshly verified at
`447143681ef0a7f72704cf5d39e3134ac7e9fac9`; the checkpoint is its ancestor.
The intervening merges are #991–#994 (reviewed API tools). Existing preparation,
joining, delivery and ordinary Codex dispatch owners are unchanged across that
range. Retain the newer tool selection and revocation contracts when capturing
the actual tool inventory. Successful checks on main are source evidence only.

During implementation, accepted #974 advanced main to
`9554a4ea84634e55862d3e806dba92f8f8e8aa90`. The preparation branch integrates
that device-continuity change, including its ordinary approval and reconnect
owners and complete shared source manifest. It is not a runtime deployment.

The landing refresh also incorporates accepted #999, #1001, #998 and #1003 at
`43183584408db87a11d6b33809af63eea55f837c`. It preserves sandbox lifecycle,
Agent Library source delivery, the approved chat settings and design ledger,
and isolated API-account bootstrap. Those sources do not qualify Symposium's
native prepare/count/consume composition or authorize runtime adoption.

Native references below are to OpenAI Codex `rust-v0.160.0`, commit
`a956835d020762cb2b570053af06f643a11c0ecc`, the repository's OpenShell source pin.
The retained investigation checkout is read-only and is not an installed runtime.

The [prepared-request source bundle](../spikes/openshell-codex/prepared-request-native/README.md)
retains the first implementation boundaries: immutable public Responses bytes,
public input-token-count transport, explicit single-attempt HTTP, and durable native
one-use state. Existing review/compiler/EventStore owners now support a private
native witness and a public total-count assessment with stable original review
identity across incomplete retries. These source primitives do not expand native
context, expose app-server preparation, consume from actual `turn/start`, install
production joining authority or qualify a configured account/runtime. The bundle
records exact source and offline fixture evidence separately from those remaining
integration obligations.

| Boundary               | Inspected native source                                                                                                                       | Consequence                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Admission              | `codex-rs/app-server/src/request_processors/turn_processor.rs`, `turn_start_inner`                                                            | Currently loads a thread and calls `start_or_steer_turn`; prepared consumption must precede these effects and must never steer. |
| Prompt                 | `codex-rs/core/src/session/turn.rs`, `build_prompt`                                                                                           | Includes native instructions, expanded history, model-visible tools and output schema.                                          |
| Model expansion        | `codex-rs/core/src/client_common.rs`, `get_formatted_input_for_request`; `core/src/client.rs`, `build_responses_request`                      | Includes image normalization and Responses-lite framing; host RPC parameters cannot stand in for this expansion.                |
| HTTP finalization      | `codex-rs/core/src/client.rs`, `stream_responses_api` request construction                                                                    | Account metadata, item normalization, interceptors and `tool_metadata::bounded_input` run after prompt construction.            |
| HTTP serialization     | `codex-rs/codex-api/src/endpoint/responses.rs`, `stream_request`                                                                              | `EncodedJsonBody::encode` is the serialized request boundary.                                                                   |
| WebSocket finalization | `codex-rs/core/src/client.rs`, WebSocket request construction; `codex-api/src/endpoint/responses_websocket.rs`, `serialize_websocket_request` | Previous-response state, incremental input, metadata and bounded input differ from HTTP.                                        |
| Output limit           | `codex-rs/codex-api/src/common.rs`, `ResponsesApiRequest` and `ResponseCreateWsRequest`                                                       | Neither inspected request structure carries `max_output_tokens`.                                                                |

The official [input-token counting guide](https://developers.openai.com/api/docs/guides/token-counting)
documents an exact count for Responses input, including structural framing,
tools and images, using the same payload as generation. It also documents that
`max_output_tokens` limits invisible output, including reasoning. This supports a
candidate API measurement path; selected account/model support and ChatGPT backend
support are unestablished. No count endpoint or model was called for this proposal.

## Contract and selected first route

1. One native preparation owner captures and retains the complete final request;
   counting and dispatch take its opaque reference. Neither rebuilds the request.
2. The user selected an **OpenAI Responses API account** as the first route,
   explicitly distinguishing it from a ChatGPT subscription-backed native route.
   Use HTTP for the initial transport, full explicit input, and no provider-managed
   conversation reference. Reuse the existing ordinary Codex preparation, session
   and dispatch owners. This route choice does not select a concrete account or
   authorize live calls. ChatGPT subscription-backed routes, WebSocket and other
   providers remain unavailable for Symposium capacity until separately implemented
   and proven; never route subscription credentials through the public API.
3. A joining review measures its exact context candidate. A later explicit command
   requires its own complete prepared request, including that command and the
   retained joining context. Review readiness never certifies an unwritten prompt.
4. Consumption is durable and one-use. Any uncertainty after consumption blocks
   redispatch; recovery reconciles the original operation instead of replaying it.
5. Retain ordinary application, workspace, provider-session, command, acknowledgement
   and reply owners. No additional provider/session system or scheduler is added.

The existing native API candidate is OpenShell: `ordinary-openshell-codex-route.ts`
resolves an enrolled `provider: openai` account with `harness: codex` to `kind: api`.
Its entry, admission and runtime owners retain ordinary native custody. The local
`FrozenHostCodexLogin` instead requires ChatGPT credentials; the separate local
Responses SDK callback path creates queues and does not qualify silent native
preparation. This source inspection selects no configured runtime or account.

Accepted #1003 additionally provides `CodexAppServerClient.launchIsolatedApi`
under the existing private-home, frozen-executable and credential authority.
It bootstraps API authentication without enabling a chat route. It does not
replace `FrozenHostCodexLogin` or establish silent preparation, authoritative
capacity, cold continuation or prepared-request dispatch. Preserve that helper
when composing the selected API route rather than implementing another login.

## Existing owners and the native addition

| Responsibility                                             | Single owner / extension point                                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated operator, source/access/settings authority   | Existing authenticated router and `OrdinaryCollaborationJoiningAuthority`; compose real dependencies here.                                                                                                               |
| Review identity, edited brief, source pins, exact retries  | `OrdinaryCollaborationReview` and EventStore review compilation records.                                                                                                                                                 |
| Workspace and silent ordinary application session          | `RepositoryWorkspaces.prepareOrdinarySession`, existing preparation authority and receipt; retain its allocation operation ID.                                                                                           |
| Resolved host packet                                       | `codex-ordinary-packet.ts`, `openCodexChat`, `CodexConversation.threadOptions` and `dynamicToolsOption`.                                                                                                                 |
| Final immutable native request, count witness, consumption | One native core owner, exposed through the existing app-server protocol and backed by private native durable storage. Extend `codex-rs/state` for preparation/consumption records; keep rollout as conversation history. |
| Ordinary command admission and uncertainty                 | Existing ordinary admission/EventStore and `CodexConversationStore`; retain a private reference to the native operation, not a second command ledger.                                                                    |
| Context delivery and exact acknowledgement                 | `OrdinaryCollaborationDelivery`, `prepareSystemPrompt(signal, { commandId })`, existing dispatch barriers and `onApplicationContextAccepted`.                                                                            |
| Attributed finalized reply                                 | `OrdinaryCollaborationReplies` and original private command/provider-turn mapping.                                                                                                                                       |

The native records are request capabilities under the existing runtime's custody,
not provider sessions. They must be persistable before any native thread exists.
Raw requests, native identifiers and capability secrets stay private; client replay
continues to expose only the existing public projection.

## Preparation, then measurement

Preparation accepts a schema-cloned, host-authorized ordinary selection. It captures
actual base/developer instructions, repository documents, accepted knowledge,
application context fragments, edited brief, source/artifact bytes, history,
dynamic/native tool definitions, output schema, policy, model/reasoning settings,
runtime revision and account route. Native expansion consumes immutable captured
values rather than rereading mutable sources while constructing the request.

Capture uses bounded reads and before/after revision fences. Tool discovery must
have a complete authoritative inventory without starting tools, queues or sessions;
otherwise preparation refuses. No preparation path may create a thread, start or
steer a turn, write rollout/history, compact, infer, prewarm a provider response or
execute a tool. Writing private preparation records is permitted. Endpoint counting
is a separate non-generating operation, never a call to `responses.create`.

For a fresh session, use the real ordinary configuration without calling
`thread/start`. Any native identity needed by expansion is a private reserved value
inside the preparation record; it is not a created session or fabricated command.
At the first explicit command, the existing native thread owner must materialize
the reserved identity without changing the retained request. If it cannot, refuse
before mutation. Existing threads bind the precise durable history revision.

Review happens before silent workspace allocation. If the future working directory,
project documents, tool inventory or runtime selection cannot be captured and
validated from authoritative sources without allocating that workspace, review
remains unverified. An allocation may not silently replace a hypothetical path or
tool inventory in an already reviewed request. Renew the existing authority after
allocation; any model-visible difference requires another review on the same screen,
retaining the edited brief and original allocation receipt.

Run the ordinary native transformations on captured data: fragment application,
image normalization, model-specific framing, tool serialization, account/route
normalization, permitted interceptors, then bounded tool metadata. Interceptors
with effects or unresolved inputs cannot participate in pure preparation. Freeze
after the last request-body mutation and retain the encoded HTTP body as well as
the immutable structured request. Compression may wrap those same bytes; it must
not rebuild them. Metadata in the body is frozen too. Volatile body fields must
be resolved during preparation or cause refusal, not be restamped at dispatch.

The request carries an enforced positive integer `max_output_tokens`, validated
against the selected model's output limit. Disable server truncation; unsupported
parameters cause refusal, never parameter removal or silent fallback. Bind the
ceiling and its authority revision to the selected account, endpoint, model and
runtime. A catalogue ceiling supplies a bound, not an input count.

The API counter receives the frozen request's identical model, instructions, input,
tools, schema and other count-relevant settings. Construct a documented-schema
projection solely from that retained object; do not invent an input/tool schema or
ignore an unsupported field. Prove the projection covers every model-visible
field. Native-only Responses-lite or internal request shapes remain unsupported
unless the selected endpoint explicitly supports equivalent counting. Images and
files must use immutable retained content or provider-attested immutable versions;
mutable URLs cannot establish same-input measurement.

Persist the counter result against the preparation ID, exact request identity,
route/account authorization epoch, model/catalogue revision, output budget and
counter contract revision. Require safe nonnegative integer counts and bounds:

```text
input_tokens + max_output_tokens <= effective_context_ceiling
0 < max_output_tokens <= selected_model_output_limit
```

Equality fits; the next token refuses. Arithmetic overflow, unknown limits,
unsupported count responses, endpoint mismatch, expiry or failed authority renewal
leave the candidate unverified/refused. Do not infer readiness from a hash, byte
count, estimated component totals or post-response usage.

`CollaborationCapacityAdapter.measure` currently returns additive component counts
and explicitly excludes provider calls. Extend that existing contract and its
snapshot schema for a private authoritative-witness association plus a public
total/scope projection before installing a real counter. Do not split the exact
total into invented component counts or use `estimatorRevision` as an attestation.
Historical snapshots remain readable but cannot gain dispatch authority through
migration. Exact review retries must return the original snapshot before counting
again; confirmation always renews current authority.

## Review scope versus explicit-command scope

Use two scopes in the same native owner:

- `review_context`: the exact candidate joining context with native overhead and
  enforced output reservation. It has no command ID, creates no command, and is
  permanently non-consumable. It proves only that retained context's fit.
- `command`: the actual explicitly admitted command, complete combined application
  context, history, images and native overhead. It binds the real ordinary command
  ID and reviewed context identity, and may be consumed once after measurement.

The command request is newly prepared because the prompt is new; its count and
dispatch still share one exact request. This must not recompile or replace the
reviewed brief. A user prompt that no longer fits refuses before send. A source,
artifact, brief, settings or context change returns to editable/refrozen review
on Before joining; there is no extra Freeze step. Equivalent object-key ordering
preserves setup identity; ordered messages, tool lists and input items retain order.

Reader-only delivery needs a real non-generating ordinary context owner later.
Neither `review_context` nor a count response is a delivery acknowledgement.
Until that owner exists, reading alone retains pending context without sending.

## Proposed protocol surface

These names and shapes are proposed additions, not existing RPC methods. Schema
generation and runtime feature negotiation must land with the implementation.
Requests use the existing authenticated runtime channel; binding strings supplied
by a caller never establish account or operator authority.

```text
request/prepare {
  operationId, scope: review_context | command,
  ordinarySelection, capturedSourcePins, reviewedContextIdentity,
  command?: { ordinaryCommandId, exactTurnInput }, maxOutputTokens
}
  -> { preparationId, requestIdentity, scope, nativeRevision, state: prepared }

request/measure { preparationId, requestIdentity }
  -> { preparationId, witnessId, state: measured | unverified | refused,
       inputTokens?, maxOutputTokens?, effectiveContextCeiling?, reason? }

turn/start {
  ordinaryCommandId, threadId?: existingNativeThreadId,
  preparedRequest: { preparationId, requestIdentity, witnessId }
}
  -> { ...existingExactTurnAcknowledgement, preparedRequestReceipt }

request/read { operationId }
  -> { state, preparationIdentity?, consumptionReceipt?, exactTurnReceipt? }
```

For a prepared `turn/start`, the capability supplies the request body. Reject
conflicting input/config overrides, missing command identity, wrong session or
account, and `review_context` scope. The prepared branch validates before the
current `load_thread`/`start_or_steer_turn` effects. An active turn refuses instead
of steering. Omission retains the ordinary non-Symposium path; Symposium authority
must require the negotiated prepared-request feature and may never fall back.

The generated schema needs separate legacy and prepared branches: legacy requires
the existing thread/input fields; prepared fresh-session dispatch may omit the
thread ID only when the retained capability owns a reserved native identity.
The receipt returns that materialized thread ID and the exact command/preparation
association to the existing host mapping owner. Extend ordinary initialization to
defer thread creation for this branch until native consumption; do not call the
old `thread/start` early merely to satisfy its current required `threadId`.

Feature negotiation covers preparation, durable recovery, exact counter revision,
enforced output limit, transport and consumption at the final send boundary.
A version string or an advertised field alone cannot qualify an account/runtime.
`request/read` has no effects, does not dispatch or reauthorize, and must use the
same private owner/custody checks. Lost prepare/count responses recover by their
retained operation identity. Exact retries cannot replace bytes; different inputs
under the same identity conflict.

## Consumption and recovery

The native owner serializes consumption with ordinary thread/history/settings
mutation. Renew host source/access/settings authority after asynchronous work;
then verify native route/auth, history, model, tools, runtime, request and witness
epochs under the native consumption fence. Aborted/stale/unmeasured requests
refuse before ordinary execution mutation, queue insertion or provider send.
Any captured revision change invalidates, even if a later read looks similar.
The implementation must define the authority linearization point across host and
native processes: a private one-use host permit bound to the same operation and
current authority epoch, with revocation ordered against consumption. A caller's
epoch string, an old successful callback or a time-to-live alone cannot satisfy
this fence. If the channel cannot prove that ordering, consumption refuses.

Commit a durable compare-and-swap from `measured` to `consumed` for the exact
ordinary command before effects. Bind its operation to the existing ordinary
command's uncertainty record before the host submits `turn/start`. Losing either
response does not release consumption. Only the winning operation may materialize
the ordinary thread and issue the retained body. Cross-process and concurrent
retries must share the durable fence, not an in-memory lock.

| Durable boundary                                          | Recovery behavior                                                                                                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`, count incomplete                              | Recover same bytes; resume counting only, never generation.                                                                                   |
| `measured`, not consumed                                  | Reauthorize and validate all revisions before a possible single consumption.                                                                  |
| Invalidated or expired, not consumed                      | No send; obtain a new preparation under the original owners and refreeze any changed reviewed inputs.                                         |
| Consumed, no proven terminal outcome                      | Conservatively uncertain, including crash before a socket write; no automatic redispatch or new capability for the same command.              |
| Exact native turn receipt retained                        | Recover that turn and its ordinary acknowledgement; do not issue another `turn/start`.                                                        |
| Provider accepted, host acknowledgement projection failed | Reconcile original provider/command/context identities; preserve accepted outcome despite observer errors.                                    |
| Proven refusal after consumption                          | Retain a terminal refusal and consumption tombstone. A later attempt requires an explicit ordinary recovery decision, not an automatic retry. |

`turn/start` acknowledgement is the existing native admission boundary, not proof
that the upstream model completed. Retain a separate final-send receipt associating
the consumed request with its actual provider request/turn. Both must agree before
claiming complete prepared-request execution. Preserve existing exact context ACK
semantics and original observer error precedence; finalized attribution still waits
for the actual acknowledged turn. Notifications and post-response usage cannot
substitute for the response identity or make an uncertain send safe to replay.

After consumption, provider client retries, auth recovery, redirects and transport
fallback must not create another dispatch. For the first implementation, disable
automatic generation retries on this branch; classify ambiguous outcomes uncertain.
Refreshed credentials or route revisions require reauthorization before consumption;
they cannot silently modify a consumed request. Stop/disconnect cancel through the
ordinary owner and retain uncertainty whenever acceptance is unknown.

The source state owner now supports explicit per-sampling chains: one root per
command, one consumed successor per predecessor, fixed command model/settings,
and one original native turn acknowledgement. Legacy bindings are not upgraded
into continuation rights. These records do not prove the prior sampling completed
or authorize the actual tool loop; that remains the ordinary execution owner.

The initial capability covers one provider sampling request. A tool-using turn may
need subsequent requests: each requires fresh native prepare/count/consume under
the same ordinary turn owner and its current history, without replaying the initial
capability. Do not advertise full-turn capacity qualification until these paths
are covered. Existing explicit capacity recovery keeps its owner and cannot silently
compact or replay the measured first request.

WebSocket qualification additionally requires a retained logical full request and
its exact wire projection, binding previous-response ID, connection/auth generation
and bounded incremental input. Count the complete logical context, never just a
delta. Reconnection or HTTP fallback invalidates an unconsumed projection; it cannot
replay a consumed one. Until logical/wire equivalence and counting support are
proven, the selected WebSocket combination refuses rather than changing transport.

Private payloads use existing runtime custody and retention policies. Reclamation
must keep consumed/uncertain operation tombstones and acknowledgement associations;
deleting request bytes cannot make a capability reusable. A restart can recover only
if durable storage and matching runtime/account custody are available; missing
storage or an incompatible runtime means unavailable/uncertain, never reconstruction
under the old preparation ID.

## Test-first implementation boundaries

Each step starts with failing regressions against the actual owner, then the
implementation, committed together. Fixtures intercept counting and transport;
none call a real account or model. Local tests use one worker and
`NODE_OPTIONS=--max-old-space-size=1024`; broad suites and builds belong in CI.

1. Build native immutable expansion (test-first). Assert no thread, history, queue,
   tool or inference effects through the real preparation entry point. Prove final
   HTTP serialization equality with image detail changes, bounded metadata,
   instructions, schema, tools, additional-context chunking and account framing.
2. Build native measurement and output enforcement (test-first). Compare the captured
   count projection with the retained generation body. Exercise exact ceiling,
   next-token overflow, invalid counters/limits, unsupported schemas and credentials,
   changed artifacts/model/tools/route, count cancellation and lost response recovery.
   Exercise `review_context` refusal at consume. No test obtains readiness from
   heuristic component sums.
3. Build native consumption/recovery (test-first). Exercise the real `turn/start`
   branch and a recording transport, concurrent processes, restart, final validation
   before mutation, crash before/after consumption/write/ACK, Stop, late events,
   admission versus final-send receipts, retries and active-turn steering refusal.
4. Build ordinary application composition (test-first). Extend existing
   `collaboration-review-owner`, `collaboration-joining-owner`,
   `collaboration-ordinary-delivery`, `codex-conversation`,
   `codex-ordinary-packet`, preparation and router suites. Exercise exact retained
   brief, review and operation recovery, crash after preparation commit before join
   recording, independent sessions on a shared account, first explicit command,
   exact context ACK and finalized attributed reply. Preserve partial recipient
   outcomes and multiple context receipts with at most one reply-origin delivery.
5. Build subsequent-request and supported transport coverage (test-first). Qualify
   tool loops and each advertised route/runtime separately. Add silent reader
   delivery only through a real non-generating native/context owner. Keep unsupported
   combinations unavailable throughout.

Retain existing 512 KiB page/selection/witness/final fences and refuse the next byte
before hydration. Preserve source prefix completeness, unsupported-artifact refusal,
source-save auth renewal/keyset pagination, durable host mappings, private replay
projection, ordinary approval/Stop/reconnect and browser hard-reload response fences.
This proposal changes no UI. Later integration still requires the approved design,
independent design audit and actual web/native inspection; builds do not establish it.

## Runtime source delivery and agreement checkpoint

The image currently installs published `@openai/codex` from
`docs/spikes/openshell-codex/runtime-codex-version` via `Dockerfile.mgmt-runtime`.
A Mitzo host change or local native fork cannot add this protocol to that binary.
Implementation therefore needs reviewed upstream native support or a maintained,
reproducibly built native fork with an immutable source/binary pin, protocol schemas
and shared source-manifest changes. Local Mac and OpenShell consumers must be
verified separately. Merely changing the package version does not establish support.

The first-route decision is resolved: an OpenAI Responses API account, with HTTP
as the initial transport. No further route confirmation is needed. The remaining
native contract and source-delivery mechanism are still proposals; the route choice
alone does not approve all protocol/storage details or establish runtime support.
No concrete account or live qualification is selected. This checkpoint implements
the handover's instruction to agree the native contract first. It creates no tracker
milestones and reserves no landing slot. The existing merge queue owner must
coordinate any future landing; all CI/Centaur/App gates remain required.

Canonical staging remains stood down. No staging, live/model test, deployment or
activation is authorized here. Future live qualification needs a separately selected
target and supported Luna model, with the exact model and charged account stated
beforehand; any non-Luna test needs explicit approval.
