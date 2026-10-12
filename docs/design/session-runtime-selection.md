# Session runtime selection

Status: incremental design and source audit. Dormant infrastructure includes
versioned EventStore bindings, configuration resolution, local Codex account
projection and V2 configured-target persistence. This document does not establish
live, staged or deployed support for any selectable route.

## Separate account identity from execution choice

An account answers which provider identity pays for and authorizes inference.
A harness answers which agent loop interprets prompts and invokes tools. An
execution target answers where that loop runs. A model selection answers which
model the account permits. These are related constraints, not interchangeable
identities.

Today ordinary chat dispatch couples those choices in
[`startChatImpl`](../../server/chat.ts): account provider, OpenShell environment
configuration and account profile fields determine the adapter. Consequently,
the same `openai` provider can select either the native Responses loop on the
host or Codex in OpenShell. Changing global runtime configuration is not an
explicit per-conversation choice.

[`AccountBinding`](../../packages/protocol/src/account-binding.ts) already pins
account ID, provider and routing profile revision, plus the initial model and
display label. [`AccountProfiles.resolve` and `resume`](../../server/account-profiles.ts)
validate the selected account and reject routing profile changes.
`resolveAccountSelection` rejects changing a bound conversation's account and
rejects enrolling an existing unbound legacy conversation. Model and reasoning
selection have their own validation and durable selection fields. They must
remain independent of an immutable runtime binding.

## Existing source routes

This matrix describes code paths and their admission requirements. It is not a
catalog of routes available on a particular installation. Runtime configuration,
feature gates, current account authorization and reviewed ownership evidence
still determine whether a path can execute.

| Route                                           | Account and inference authorization                                                                               | Harness and location                                 | Creation and continuity                                                                                                                             | Tool permissions and cleanup                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary Codex, host                            | `openai-codex`; explicit host login profile; preflight initializes app-server and verifies the configured account | Codex app-server, local                              | `openCodexChat` / `CodexConversation` use the private conversation ledger, `thread/start` or `thread/resume`, queued command IDs and account checks | Provider thread uses a read-only sandbox by default; Mitzo dynamic host tools use the shared permission handler. Transport/MCP cleanup is distinct from host worktree retention                              |
| Ordinary Codex, brokered OpenShell subscription | `openai-codex`; complete `openai-codex-oauth` provider identity and grant; no API billing substitution            | Codex app-server in OpenShell                        | Sandbox manager, retained artifact runtime, lifecycle record and conversation thread remain existing continuity authorities                         | OpenShell built-in tools run in its workspace; restricted external sandbox policy and explicit host bridges. Ask mode is rejected. Closing transport marks lifecycle idle rather than deleting the workspace |
| Ordinary OpenAI API, host                       | `openai`; selected credential reference and enrolled/managed key readiness gates                                  | `NativeResponsesRunner`, local                       | Initial/cold-resume command admission precedes runtime/queue effects; private Responses history and checkpoint store                                | Shared host tool executor, hooks, MCP and permission handler; abort closes input/MCP/hooks and records queued cancellation                                                                                   |
| Ordinary OpenAI API, OpenShell                  | `openai`; explicit sandbox provider; environment enables API OpenShell dispatch                                   | Codex app-server in OpenShell                        | `chat.ts` constructs an API Codex profile and uses the Codex route and its private continuation ledger                                              | Same OpenShell ordinary restrictions and lifecycle as above; Responses checkpoints are not Codex thread state                                                                                                |
| Ordinary Anthropic Vertex                       | `anthropic-vertex`; explicit project, region and ADC reference                                                    | Claude Code Agent SDK `query`, local                 | SDK resume ID/CWD mapping and EventStore transcript/state; ordinary SDK input queue                                                                 | SDK `canUseTool` applies Mitzo mode, skill ceiling and worktree checks. Query/queue close separately from host worktree cleanup                                                                              |
| Ordinary Google Vertex                          | `google-vertex`; project, region and token getter                                                                 | Gemini adapter under `NativeResponsesRunner`, local  | Native command admission, private history/checkpoint and Gemini prefix checks; unsupported images fail explicitly                                   | Shared host tools and permission handler; the Responses runner owns cancellation and disposal                                                                                                                |
| Symposium OpenAI API seat                       | `openai`; pinned OpenShell provider name and ID, seat admission and authority                                     | Native Codex seat in a seat sandbox                  | Separate session/configuration, membership generation, delivery, attempt and artifact admission; private native continuation                        | Seat read-only enforcement must be verified; exact attempt cleanup must be confirmed before retry                                                                                                            |
| Symposium native ChatGPT seat                   | `openai-codex`; `nativeAuth: sandbox-chatgpt`, isolated native provider and independent authentication proof      | Native subscription Codex launcher in a seat sandbox | Separate seat runtime, reviewed launcher/build identity and native account attestation                                                              | Host/brokered/API credentials are rejected; exact native cancellation and attempt custody remain authoritative                                                                                               |
| Symposium Claude Vertex seat                    | `anthropic-vertex`; pinned OpenShell provider identity and project/region                                         | Native Claude launcher in a seat sandbox             | Separate seat admission/attempt; continuation uses explicit host history and provider receipts                                                      | Verified seat authority/read-only contract and confirmed native cleanup                                                                                                                                      |

Evidence for ordinary dispatch and lifecycle:

- [`chat.ts`](../../server/chat.ts): `startChatImpl`, native initial admission,
  `openCodexChat` / `openResponsesChat` / SDK dispatch, resume permission
  revision checks, worktree registration and `cleanupSessionWorktrees`.
- [`codex-chat-session.ts`](../../server/codex-chat-session.ts):
  `selectedOpenShellAccountRoute`, `openCodexChatAdmitted`, Ask-mode rejection,
  retained runtime restoration, host-vs-OpenShell client creation and tool sets.
- [`codex-conversation.ts`](../../server/codex-conversation.ts) and
  [`codex-conversation-store.ts`](../../server/codex-conversation-store.ts):
  provider-thread validation, pending dispatch ownership, queued commands,
  capacity recovery, runtime migration and artifact runtime retention.
- [`provider-execution.ts`](../../server/provider-execution.ts): account-bound
  command fingerprint, exact retry detection and durable execution admission.
- [`responses-chat-session.ts`](../../server/responses-chat-session.ts),
  [`native-responses-runner.ts`](../../server/native-responses-runner.ts),
  [`native-responses-store.ts`](../../server/native-responses-store.ts) and
  [`gemini-session.ts`](../../server/gemini-session.ts): continuation state,
  account/model checks, checkpoint restoration and cancellation.
- [`custodian-ordinary-runtime.ts`](../../server/custodian-ordinary-runtime.ts):
  custodian mode refuses ordinary OpenAI host fallback when dedicated ordinary
  OpenShell configuration is absent.
- [`openshell-lifecycle.ts`](../../server/openshell-lifecycle.ts) and
  [`openshell-lifecycle-service.ts`](../../server/openshell-lifecycle-service.ts):
  existing sandbox lifecycle fencing and recovery responsibilities.

Evidence for separate Symposium admission:

- [`symposium-session-create.ts`](../../server/symposium-session-create.ts):
  explicit draft creation, idempotency and saved profile revision; its creation
  router currently permits OpenAI API and Codex providers. This is distinct
  from the broader native seat admission support.
- [`symposium-seat-runtime.ts`](../../server/symposium-seat-runtime.ts):
  `admitSymposiumSeatDispatch` checks configuration, seat authority, membership,
  admission, delivered content and account before selecting a native route.
- [`symposium-openshell-seat-executor.ts`](../../server/symposium-openshell-seat-executor.ts):
  read-only verification, final synchronous dispatch fence and exact cancellation.
- [`symposium-session-runtime.ts`](../../server/symposium-session-runtime.ts),
  [`symposium-codex-native.ts`](../../server/symposium-codex-native.ts),
  [`symposium-subscription-native.ts`](../../server/symposium-subscription-native.ts)
  and [`symposium-claude-native.ts`](../../server/symposium-claude-native.ts):
  native route composition, authentication, provider receipt and cleanup contracts.

Ordinary `openCodexChat` and `selectedOpenShellAccountRoute` explicitly reject
`nativeAuth: sandbox-chatgpt`. Symposium native support does not authorize
ordinary native subscription dispatch or reuse of a Symposium-owned gateway.

## First increment: dormant immutable metadata

Introduce a strict, versioned session runtime binding alongside account binding.
Its account reference contains account ID, provider and exact profile revision;
its harness identifies `codex`, `claude-sdk`, `responses` or `gemini`; its
execution reference identifies `local` or `openshell` location. The binding contains
no credentials, credential paths, prompt/history, model selection, mutable
permission mode, provider thread, sandbox resource ownership or lifecycle state.

The protocol validates these implementation/provider combinations: Codex with
`openai-codex` or `openai`, Claude SDK with `anthropic-vertex`, Responses with
`openai`, and Gemini with `google-vertex`. Both location enum values are
descriptive metadata; this first increment does not validate that every
implementation/location combination has an executable adapter.
Accepting a metadata value is not proof of authorization, isolation, provider
enrollment, readiness or dispatch support. Physical target/resource identity
stays in the existing provider/lifecycle ledgers. A future concrete target
selection needs its own validated server configuration reference; it must not
accept client-supplied executable paths or gateway endpoints.

Persist a nullable binding on the existing EventStore session row. Existing
rows remain null. A dedicated atomic creation operation writes a new ordinary
session and its binding together, requiring the matching valid account binding,
repository workspace identity and CWD. Ordinary session upserts do not enroll
legacy rows. An exact creation retry may return the existing immutable record;
conflicting account, runtime, workspace or CWD identity must fail before metadata
mutation. The dedicated APIs are `createSessionWithRuntimeBinding` and
`getSessionRuntimeBinding`, using `SessionRuntimeBindingV1Schema`.
Historical events without a session metadata row also block creation: absence
of a row is not proof that a conversation ID is new.

Read the binding through an explicit accessor. A missing session and a legacy
session without binding are distinct results (`undefined` and `null`,
respectively); malformed JSON, unknown schema version and inconsistent account
identity must fail closed. Runtime-bound
session upserts must preserve the binding and refuse account identity/profile
or workspace/CWD replacement. This protection must run before changing any other
fields, so a rejected update leaves the row intact.

No ordinary creation, send, resume, command admission, provider dispatch,
permissions, cleanup or UI code consumes this infrastructure in this increment.
Existing `getSession`/list/protocol output remains compatible. In particular,
no request field or selector claims the new choice is actionable.

## Second increment: dormant configuration resolver

[`resolveOrdinarySessionRuntime`](../../server/ordinary-session-runtime.ts) is a
pure check of an explicit credential-free selection against an injected server
configuration catalog. It requires exact account ID, provider and profile
revision, an explicit harness and configured target ID, mutable permission mode,
and an optional skill ceiling. Missing, ambiguous or unavailable identities
fail with finite rejection codes; the resolver never chooses a default or falls
back to another account, harness or target. Unknown fields are rejected without
echoing parser errors or supplied values.

The catalog declares enabled harnesses and configured local or OpenShell
targets. Enabling a harness does not extend the existing ordinary route matrix
above: only those six ordinary tuples are compatible. New OpenShell selection
requires a dedicated ordinary target. Shared or retained targets remain outside
this new contract; existing legacy dispatch is untouched. OpenShell Ask mode
and any Codex skill ceiling, including an empty array, are rejected. Custodian
configuration additionally excludes ordinary OpenAI/Codex host selection and
requires enabled API dispatch for an OpenAI API sandbox route. This restriction
does not extend to local Vertex routes.

Provider-specific auth kinds describe configured profile classes only. Host
ChatGPT requires an exclusive host login profile; brokered ChatGPT requires a
complete `openai-codex-oauth` provider/type/ID/grant profile without host login.
Its nonempty target references must identify the exact configured provider
route. OpenAI API sandbox references require an explicit provider configuration
and enabled API dispatch on the target; an empty mapping permits host-only API
configuration. Vertex requires its configured project, region and ADC profile.
These descriptions contain no credential references, provider/grant IDs or
readiness booleans. They do not prove current authentication, authorization,
isolation or readiness. Trusted projections from existing validated server
configuration are prerequisites for adoption; the local Codex slice below is
the first such projection.

Ordinary native `sandbox-chatgpt` selection remains unsupported; Symposium
admission is separate. Legacy `openai-codex` profiles permit `planType: api`,
which existing OpenShell code can interpret as API billing. This resolver
conservatively rejects that value after trimming and case normalization. It
neither treats it as a subscribed ChatGPT identity nor substitutes an `openai`
account or billing route.

A compatible result contains `SessionRuntimeBindingV2`, including the selected
target's ID and revision from the injected catalog. Every catalog target requires
a bounded non-empty opaque `targetRevision`; a request selects an ID and cannot
supply its revision. Changing a catalog revision changes the resulting binding,
not any previously persisted session. The separate result `targetId` is removed.
Activation still requires trusted target loading/revision provenance, atomic
new-session admission, exact retry/resume validation and command fingerprint
checks before any runtime effects. The resolver has no loader,
environment/filesystem/network/process access, credential reads or runtime
consumer. Startup, API/WS/UI, enrollment, queues and lifecycle authorities retain
their existing behavior.

## Third increment: dormant local Codex account projection

[`AccountProfiles.ordinaryLocalCodexAccounts`](../../server/account-profiles.ts)
returns independent account metadata entries for the injected resolver catalog
from its constructor-validated profile snapshot. The Codex gate must be enabled.
Only ordinary host-login `openai-codex` profiles are included; native
`sandbox-chatgpt`, brokered-only profiles, other providers and trim/case-normalized
`api` or empty plans are excluded. Legacy account IDs outside the runtime
reference schema are also excluded, so they cannot invalidate the projected
catalog. A legacy sandbox provider name alone does not replace the validated
host-login class.

Entries contain only account ID, provider, exact routing profile revision, the
configured plan type and `auth: { kind: 'host-login' }`. A shared routing digest
calculation preserves the persisted revisions used by `resolve` for every
provider and native profile. Label or model changes do not affect that identity;
routing changes invalidate the old reference. The projection selects no model
and performs no credential, environment, filesystem, network, process,
authentication, discovery or runtime lookup. Existing constructor private-root
protection remains intact and separate from projection effects.

This method has no runtime consumer, target loader or catalog wiring. It supplies
configuration metadata only; trusted target loading, admission and readiness still
require their own reviewed increments.

## Fourth increment: dormant versioned target persistence

`SessionRuntimeBindingV1Schema` retains its strict original shape and provider/
harness constraints. `SessionRuntimeBindingV2Schema` adds required `targetId` and
`targetRevision` fields under `execution`. `SessionRuntimeBindingSchema` and its
shared type discriminate both versions. Neither version includes credentials,
configuration paths, endpoints, models, reasoning selection or authorization
claims. V2 target references describe logical routing configuration; physical
resources and their ownership remain in the existing lifecycle ledgers.

EventStore's explicit create/read APIs and existing runtime-bound guards accept
both versions in the same nullable `runtime_binding` JSON column. No schema
migration or backfill is needed. A V2 target ID/revision change, or a V1/V2
replacement, is a conflicting retry rather than an upgrade. Exact retries remain
read-only under the immediate creation transaction. Generic upserts cannot enroll
or replace a binding. Cold reads preserve V1 without inferring a target, preserve
null legacy absence and reject corrupt or inconsistent V2 values.

The pure resolver now produces V2 bindings using explicit revisions in its
injected target catalog. These revisions are test/configuration input, not a
deployed loader's verified digest. Before activation, implement and review a
server-owned target projection and revision derivation tied to routing-relevant
configuration. Clients must not supply executable paths, gateway endpoints,
credentials or revisions. A compatible catalog entry does not establish login,
readiness, isolated resources or dispatch authority.

Tests cover both versions' account/workspace and ordinary/internal/Symposium
fences, reopened V2 identity, exact retries across two stores, target and version
drift, failed-write rollback, corrupt V2 metadata, required catalog revisions and
request rejection of a supplied target revision. The increment has no startup,
resume, command, HTTP/WS, permission, lifecycle or UI consumer.

## Fifth increment: dormant trusted local capability snapshot

`loadOrdinaryLocalCodexTarget` reads only an explicitly selected
`MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE` in the operator-owned server environment.
It is dormant: startup, HTTP/WS, discovery and dispatch do not call the loader.
Missing configuration is disabled. Relative paths, symlinks, non-regular files,
invalid UTF-8/JSON, content over 64 KiB and unknown fields fail with a fixed error
that does not disclose the path or content. Neither account files nor Symposium
or OpenShell settings supply a fallback.

The strict version-1 file declares one local Codex target:

```json
{
  "version": 1,
  "targetId": "local-mac",
  "label": "Local Mac",
  "hostId": "operator-declared-host-id",
  "runtimeContractRevision": "reviewed-local-runtime-contract-r1"
}
```

These are operator declarations, not observed host/runtime evidence. The operator
must name the owning host and reviewed local runtime contract; future admission
must independently verify that the selected runtime matches both declarations.
The file cannot supply a target revision, executable, credential, gateway or
another execution location. A canonical SHA-256 routing revision includes the
schema/route version, target ID, host ID and runtime contract revision; file
formatting and the presentation label do not change it. `descriptor()` exposes
only ID, label, revision, local location and Codex harness. Private snapshot fields
and returned copies prevent mutation from changing the retained target.

`AccountProfiles.ordinaryLocalCodexInventory` reuses the accepted exclusive
host-login projection and existing configured/cached Codex model metadata. It
performs no sign-in check, general account catalog lookup, discovery refresh or
provider launch. Credential references, email, workspace, provider/grant data and
raw profiles never enter the projected inventory. Cached discovery source,
recorded update time and its existing stale/error flag remain explicit; they do
not authorize dispatch or claim fresh provider availability.

`OrdinaryLocalCodexCapabilityCatalog` retains that metadata and target together
as one independent snapshot. Its existing pure resolver checks the exact account/
harness/target reference. It advertises configured modes from that resolver and
Codex's unsupported restricted skill ceiling, not permission or tool parity.
Callers must explicitly classify the server deployment; missing or invalid classification fails rather than defaulting to ordinary execution. Custodian deployments keep local routes unavailable. The response retains
`defaultLocation: "openshell"` and reports `openshell_projection_pending`; it does
not select a local replacement. Missing targets and absent eligible accounts have
finite local unavailable reasons. Native/brokered/API/Vertex profiles are not
projected by this increment.

Inventory validation bounds 64 accounts, 256 models per account, 16 thinking
values per model, reference/label lengths and a total encoded payload of 1 MiB.
Duplicate account/model IDs or thinking values, unsupported default thinking and
invalid metadata fail with one non-sensitive error rather than returning a
partial selectable catalog. No model IDs or thinking values are invented.
`capabilityRevision` binds routing identity, model/thinking choices and discovery
source/stale state separately from target and account routing revisions. Labels
and discovery timestamps do not change capability identity. Responses are deep
copies; subsequent cache updates cannot rewrite an existing snapshot.

This completes the first local configuration projection within plan Step 2, not
the full picker API or route qualification. Other provider/OpenShell projections,
published-agent composition, authenticated inventory delivery, host/runtime
verification, live authorization and create/turn admission require subsequent
reviewed increments. No session model setting, runtime selection, provider
continuation or existing API/UI behavior changes here.

## Invariants for subsequent adoption

1. A new conversation chooses an authorized account, validated model and
   supported harness/target tuple explicitly. Server configuration resolves
   target IDs; inference credentials stay in the existing account authority.
2. Persist the binding before any worktree, sandbox, provider thread, transcript
   or queue effect. Exact retries reuse that binding; they cannot select a new
   target through changed environment defaults.
3. Resume and every provider admission check the persisted account, harness,
   location and future target reference against available supported configuration.
   An unavailable target is an error; it never silently falls back to host,
   another provider or account.
4. Provider thread, checkpoint, pending command, migration and lifecycle stores
   retain their existing ownership. Descriptive location and any future stable
   logical target reference must not replace physical-resource generation fences.
5. Command replay is an execution-admission problem, not a metadata operation.
   Future runtime selection must be included in a versioned command fingerprint
   or checked against the originally admitted immutable binding before effects.
   A consumed or uncertain command never becomes replayable by changing runtime.
6. Permission mode remains revisioned mutable policy. Runtime selection must
   preserve each harness's supported mode and tool restrictions; admission must
   reject unsupported ceilings rather than advertise parity. Native seat
   authority and verified read-only enforcement remain separate Symposium rules.
7. Closing a provider transport is not confirmed termination of a native
   attempt or permission to delete files. Retain provider history, primary host
   CWD, dirty worktrees and OpenShell task state under their owning lifecycle.
8. Legacy conversations retain legacy dispatch. Conversion requires a separate
   reviewed migration with continuity and rollback evidence. A global setting
   change or resume is not enrollment.

## Ordered test-first increments

Each code increment begins with failing tests, follows with the minimum
implementation, runs the targeted checks and commits tests and code together.
Use temporary/in-memory stores and mocked providers for this work.

1. **Dormant protocol and EventStore contract.** Test strict version and tuple
   rejection, credential/unknown-field rejection, immutable atomic creation,
   exact retry and conflicts, legacy non-enrollment, durable reopen, corrupt
   reads, account/workspace mismatch and rejected-upsert atomicity. Implement
   protocol export, additive nullable storage and dedicated APIs. Assert ordinary
   session read/write behavior stays compatible. No runtime consumer is added.
2. **Server capability resolution.** Test an injected configuration catalog that
   relates account capabilities to harness/target references. Reject unavailable
   targets, unsupported tuples and native subscription ordinary enrollment.
   Implement a pure resolver before adding runtime effects. Catalog availability
   must never be presented as an isolation or authentication receipt.
3. **New-session admission for one existing route.** Test binding creation and
   command fingerprint ordering before resource effects, idempotent retries,
   profile/target drift and exact resume behavior. Adopt one existing route under
   an explicit server gate; leave legacy and other routes unchanged. Do not
   introduce cross-harness continuation.
4. **Continuity, permissions and cleanup on that route.** Test restart/cold resume,
   stale admission, cancellation, pending commands, permission revisions and
   retained workspace ownership using mocked runtime transports. Reuse existing
   provider/lifecycle stores and verify no fallback or unacknowledged replay.
5. **Additional reviewed routes and eventual UI.** Repeat the admission and
   continuity tests for each existing compatible adapter. Only expose a selector
   after the supported combinations have a working server contract. Ordinary
   native subscription support requires its own reviewed authentication,
   ownership and cleanup implementation; Symposium is not its implicit adapter.

Any later test that makes a real model call must explicitly select a supported
Luna model, announce its exact model and charged account first, and obtain
approval if Luna is unavailable or another model is required. Development-agent
model choice does not relax this test restriction. Live Mitzo testing uses the
canonical staging procedure; this design adds no staging or production service.

## Compatibility and rollback

The first increment is an additive nullable database migration with no backfill
and no dispatch change. Legacy rows remain readable and writable using the
existing contract. Removing the dormant APIs/consumer code while retaining the
unused nullable column is the safe compatibility boundary; deleting or clearing
bindings is not a rollback mechanism. Older binaries ignoring this field are
not safe executors once future increments admit actively bound conversations.

Before activation, define an explicit gate that stops admitting new bound
sessions and preserves existing bindings. Rolling back execution after
activation must either retain an implementation that can validate/resume the
bound route or refuse its admission while preserving files and provider history.
Never reinterpret a bound conversation as legacy, map a different harness onto
its checkpoint, force lifecycle cleanup, or erase an uncertain attempt to make
a rollback appear successful.

The runtime metadata is not a second account registry, command ledger, sandbox
ownership journal or Symposium seat record. Changes to those authorities need
their own tests and review, separately from this first dormant increment.
