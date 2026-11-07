# Staging profile enrollment and feature acceptance

This is a review-required proposal and a pure result contract. No profile is
enrolled, no provider/runtime has been activated, and no live feature acceptance
is recorded by this change. The canonical URL remains port 3190; production and
the retained native-capacity reservation are outside its authority.

## Supported ordinary routes

The current source has these ordinary routes. `account-profiles.md` records the
original Vertex-only slice; `account-profiles.ts`, `chat.ts`, and the selected
adapter are the current authority. The dormant ordinary capability catalog is
configuration metadata, not an installed execution endpoint.

| Reference profile                                | Provider           | Ordinary local runtime               | Fresh staging authorization                                                                                                               |
| ------------------------------------------------ | ------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Personal ChatGPT                                 | `openai-codex`     | Codex app-server, host-login profile | A new private staging-only Codex login; exact email/plan checked before queued turns; organizational accounts also pin workspace ID       |
| Work OpenAI API                                  | `openai`           | Responses runner                     | A separately issued staging key, separate staging Keychain reference, explicit billing account; available Luna selected from that account |
| Claude on Vertex                                 | `anthropic-vertex` | Claude Agent SDK                     | Fresh staging ADC, independently selected project and region, account-specific model allowlist                                            |
| Future Gemini on Vertex, if present in reference | `google-vertex`    | Gemini native session                | Its own fresh staging ADC and explicit project/region/model mapping                                                                       |

The local ChatGPT profile uses `credentialRef` and does not combine it with
`nativeAuth: sandbox-chatgpt` or broker credentials. The existing native Personal
device-login profile is an isolated Symposium route; ordinary admission explicitly
rejects it. Work API profiles can select the Responses route when no OpenShell
runtime is configured. Claude Vertex's SDK environment removes alternate-provider
credentials before setting the selected staging ADC/project/region.

Relevant gates are `chat.ts` account startup admission,
`codex-chat-session.ts:openCodexChatAdmitted`,
`custodian-ordinary-runtime.ts:requireCustodianOrdinaryRuntime`, and
`ordinary-session-runtime.ts:resolveOrdinarySessionRuntime`.

The current canonical custodian cannot use local OpenAI credential execution:
`requireCustodianOrdinaryRuntime` requires a dedicated OpenShell route and refuses
host fallback. Therefore these implemented ordinary paths do not authorize an
environment change. An accepted, independently reviewed canonical transition must
first establish the ordinary deployment with the existing original-owner and
retained-history fences. Alternatively the current native route needs its actual
owner/capacity recovery. An uncertain native slot cannot be disposed from process
absence or a new profile file. No second backend, custodian, VM or supervisor is
part of this proposal.

For native feature parity, keep one existing shared VM at 4096 MiB/2 CPUs and one
feature runner under the durable staging singleton reservation. Profile/provider
metadata is distinct; profiles do not require one VM each. Native sandbox creation
and teardown must remain serial and under the actual custodian. A local route is
only parity when the independently recorded reference uses that same runtime;
changing native references to local merely to pass the manifest is invalid.

## Enrollment record and future profiles

`evidence/staging-profile-enrollment-proposal.json` is credential-free and remains
pending. Its logical reference IDs must be replaced by IDs from an independently
recorded public reference snapshot. Do not obtain that snapshot by reading private
production profiles/configuration. Public provider, runtime and capability records
are sufficient. Fresh account identity and private credential references stay in
the stage owner's enrollment store and are never added to this proposal.

Every reference profile needs one distinct staging mapping. New profiles add a
mapping, a reviewed runtime adapter/capability matrix and required feature suite;
they remain pending until fresh authorization, exact account/model discovery and
actual-run verification complete. Unknown providers are not silently remapped to
OpenAI or Vertex. The public parity assessor and the feature plan must use the
same complete reference set. Extra profiles, missing profiles, runtime mismatch
or mismatched capabilities block replica acceptance. A matching manifest alone
grants no model/provider/runtime authority.

Vertex project and region are still unspecified. No default is guessed from
private host or production configuration. A Claude model requires explicit user
approval for this test because Luna is unavailable on that route. The approval
must identify the exact staging account, exact model, and reason; it is checked
against trusted user authorization, not only a JSON declaration. ChatGPT and API
must each discover a supported Luna in their freshly authorized account. Before
dispatch, announce the exact model and charged account. No inherited session model,
provider fallback, unattended login or credential copying is allowed.

## Bounded feature suites

The runner is not implemented or installed by this proposal. It must run only
inside the canonical stage's original reservation and use authenticated stage
APIs/WS plus isolated fixture state. One worker uses a 1024 MiB heap. A batch has
at most 12 provider dispatches, 10 minutes and 256 KiB public output; smaller
reviewed limits are preferred. Internal inference rounds in Codex/SDK are opaque,
so provider dispatches are measured at Mitzo's durable dispatch boundary rather
than reported as exact billable model-call totals. API/tool-loop limits must also
bound any observable internal rounds. No automatic retries are permitted after
uncertain dispatch. Split a larger profile set into serial bounded batches and
retain their evidence until the complete reference set is covered.

The reviewed suite catalog, pinned by `suiteRevision`, derives required features
from the exact route and complete public capability snapshot. Every advertised
feature requires a concrete assertion. The initial cross-provider lifecycle suite
has these operations; it does not prove unrelated feature families:

| Feature ID            | Operation and acceptance assertion                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `stream-text`         | Start a bounded prompt with the explicit profile/model; observe the actual turn's streamed text and one terminal event                  |
| `context-read`        | Provide a random fixture nonce in a stage-only file; receive a real Read event and a response containing that nonce                     |
| `write-edit`          | Permit Write then Edit of a fixture file; verify exact bytes and one durable execution per tool                                         |
| `permission-denial`   | Request Write with `require_approval`; deny through a real approval card and verify the sentinel file remains absent                    |
| `structured-question` | Receive the real question event/card, answer its exact request ID, and verify the answer is consumed by that turn                       |
| `sandbox-bash`        | Request a bounded harmless fixture command through Mitzo Bash; verify the OS sandbox/runtime identity and output without network access |
| `binding-refusal`     | Try an unlisted model or changed profile revision; require pre-dispatch rejection and no additional provider attempt                    |
| `interrupt`           | Interrupt an active bounded turn; require its original terminal/cancellation evidence and no automatic replay                           |
| `retry-dedup`         | Repeat the same command ID; require one durable provider attempt; altered content with the same ID must be rejected                     |
| `reconnect-resume`    | Reconnect to the exact retained conversation, verify account/model binding and preserved state, explicitly continue any paused queue    |

Codex exposes Read/Write/Edit/Bash/AskUserQuestion and owned MCP tools through
Mitzo's permission handler. Its native shell/agents/apps/plugin execution remains
disabled. Image input is now carried to `turn/start` and is covered by the current
adapter tests, despite older documentation describing it as unsupported. Add
`image-input` only when the exact selected model and catalog advertise it; use a
tiny deterministic fixture and assert its actual content, not mere request
acceptance. Restricted skill ceilings and Codex subagents remain rejected.

Responses supports the same host tool executor, question/approval boundary,
native hooks and configured MCP via its adapter. Its fixed conversation model
must remain fixed in reconnect assertions. Claude SDK retains its own tools,
restricted skills, image and lifecycle semantics; do not replace them with Codex
claims. Gemini's catalog does not advertise streaming or images; those assertions
must not be required or reported as passed for that runtime.

Where advertised, independently bounded supplementary suites are needed for
configured MCP, trusted project hooks, images, long-history/compaction, subagents,
managed connections, task orchestration, and physical-phone behavior. Repository
unit coverage or a lightweight lifecycle canary is not live proof of these
features. MCP fixtures must be deterministic and stage-owned; hooks must use
stage-only project fixtures and explicit trust. Managed external integrations
require fresh separate staging enrollment. A feature without an enrolled adapter,
fixture, authorization or actual runner stays explicitly unproven.

## Result and authority contract

`scripts/lib/staging-profile-features.mjs` validates bounded public plans/results.
Plans pin accepted source commit, suite/runner hashes, original owner instance and
reservation request/epoch. Each profile pins provider/runtime and their revisions,
charged account, supported/selected model, explicit exception approval if needed,
and required feature IDs. Results repeat these pins and carry unique run ID,
provider-dispatch/time/output counts, one finite observation and evidence hash per
required feature, and cleanup state/receipt hash. Credential paths, tokens, raw
transcripts and arbitrary fields are refused.

Matching self-declared results report `not-live-proven`. The optional synchronous
`verifyOriginalOwnerRun(result, plan)` is a trusted controller dependency, never
public JSON or an HTTP caller-supplied function. No authenticated consumer is
installed yet. It must read retained evidence from the actual original owner,
verify the complete reference set and code-owned suite revision, establish actual
dispatch/tool/event assertions and authentic fresh enrollment/model approvals,
and confirm original cleanup against its retained resource ledger. Evidence hashes
without matching retained bytes do not qualify. Returning `true` in an offline
test validates only the seam, not a real run.

Missing/skipped/failed observations, zero dispatch, stale source/profile/runtime,
changed reservation, budget excess or uncertain cleanup cannot pass. Private
verification errors stay bounded. An uncertain cleanup retains the shared
reservation and native custody; this assessor has no cleanup/release capability.
Future readiness consumption must require the authoritative persisted receipt,
not a report copied into a chat or a `configurationMatches` result. HTTP readiness
remains a separate suite and cannot establish feature acceptance.
