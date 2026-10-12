# Conditional staging text and Read runner

This source prepares `profile-tools-v1`. It is **not live-proven**, is not full
profile parity, and currently has no installed staging owner or provider
enrollment. The canonical app returns 503 before planning or dispatch when the
qualified original owner is absent. No live model call was used to validate this
change. Do not publish a matching JSON result as evidence that a run happened.

The queue client is `scripts/lib/staging-profile-live-runner.mjs`. It accepts only
the canonical stage URL and fresh stage-owned authorization supplied by the
pipeline's private client configuration. There is no environment, credential,
model, account or production fallback. It reads the owner-selected enrollment,
obtains `{plan, planSha256}`, and announces the exact charged account and model
before `/run`. The pipeline must pin the immutable v2 request, accepted source,
actual original owner and plan hash under its existing singleton reservation.

The app installs no owner by default. The internal ordinary-owner constructor
fixes the actual app registry, event store and start/stop functions, and calls
`assertStagingPipelineFeatureDispatch` from the accepted queue implementation
before a fixture, process or turn action and before finalization. Missing queue
code is a refusal. The deployment must already match the plan's source; the
feature runner cannot deploy or manufacture an owner. A qualified launcher must
provide actual source/lifetime, fresh authorization and enrollment capabilities.
HTTP requests cannot install them.

Codex remains refused for planning in this phase: its automatic compaction route
has no accepted explicit model/disabled recipe proof. A small fixture is not a
compaction safety guarantee. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents a token threshold but does not establish disable semantics. Responses
uses an explicit model for each call, no `context_management`, and no standalone
`/compact` call in this actual adapter; see the [official compaction guide](https://developers.openai.com/api/docs/guides/compaction).

The plan exposes one main dispatch route, at most two model rounds, and disabled
auxiliary dispatches. The fixture exposes only Read for its exact nonce file;
MCP peers, project hooks, questions, automatic naming, images, subagents and other
tools are disabled. AccountProfiles validates the selected explicit model. A
non-Luna model requires an independently authenticated owner-held approval grant;
a caller's modelApprovalId or Boolean does not grant approval. Vertex remains
pending the exact fresh project, region, account, supported model and Dimitri's
explicit exception approval. The runner never selects an alternate model.

The ordinary adapter collector reads the actual durable account/model binding,
exact command execution generation, completed provider attempt, bounded streamed
text and successful Read result containing the nonce. Those facts are hashed
with the plan, source, original owner and run identity. The original owner retains
the full receipt in memory; the public queue receives only its hash/reference.
Restarting the owner loses verification authority. Persistent JSON cannot recreate
it. All tests use isolated offline fixtures and mocked provider boundaries.

Cleanup uses original retained adapter capabilities captured before initialization
or inference. Codex requires its original child's `close` acknowledgment including
stdio drain. `exit`, PID absence and an end event are insufficient. Responses
cleanup awaits its own completed request/turn and owned hook/MCP cleanup, in
addition to the separate durable completed-provider evidence; an idle runner or
SDK abort alone is not live proof. The cleanup wait is bounded at five seconds.
A failed or late acknowledgment keeps the original promises and fixture in the
owner for reconciliation and refuses another runner. No stronger signal, PID
lookup, sandbox adoption, lease release or queue replacement is attempted.

## Native replica follow-up

The ordinary local constructor deliberately refuses custodian and OpenShell
execution. It must not reinterpret a reference native profile as local to evade
uncertain capacity. Native personal ChatGPT `sandbox-chatgpt` has no host login
binding, and requires the actual native Codex factory. Native Responses uses the
same retained OpenShell custody. Claude Vertex uses its actual Claude native
factory and fresh gateway/project configuration. These are pending capabilities,
not completed enrollment.

The native feature owner must be constructed inside `runSymposiumCustodian` after
its actual `bootstrapConfiguredSymposiumHost` / `installSymposiumProductionHost`,
with that original host's current lifetime, attempt registry, resource ledger and
physical owner. Its fixture must use real session drafts, host-issued grants and
seat admission. The existing public session-create route currently restricts
providers to OpenAI and Codex despite a Claude Vertex executor; a reviewed Vertex
draft/grant path is required before selecting that adapter. The native collector
must verify claim/provenance/delivery facts and actual original controlled-target
`confirmStopped()` plus owned sandbox retirement acknowledgments. It must account
for intentionally retained session artifact volumes rather than invent deletion
or equate `query.abort`, `waitUntilIdle`, session end or suspend with physical drain.

Precise integration remains separate: pass fresh qualified source/enrollment
capabilities from the canonical launcher into the original custodian constructor;
add bounded feature operations to custodian HTTP/IPC; create the host-issued
fixture/grant; collect native event/claim evidence and retirement receipts; and
mount the owner only after that exact bootstrap. There is no live bootstrap
capability until accepted recovery/archive, fresh purpose authorization, reviewed
VM/config/provider enrollment and exact-source review are complete. This phase
adds no staging service, custodian, VM, provider enrollment or production action.

This two-feature suite does not claim acceptance for permission, reconnect,
cancellation, queue, MCP, hooks, images, compaction, subagent, integration, phone or
future-provider families. Their authentic bounded suites and cleanup receipts are
still required before the full replica can be reported complete.
