# Symposium: current direction and source guide

Updated 16 October 2026. Start here for Symposium product work.
Existing Telos item: `c0851ba23fcc5d04`; reuse it rather than create another parent
or a task for every document. Tracker closure and source landing do not prove
runtime acceptance or authorize deployment.

## Product direction

The user approved the revised fresh-agent flow on 16 October. Start ordinary chat,
then configure a fresh ordinary agent with Conversation so far or Selected context,
a purpose and a reviewed frozen joining brief. Existing-chat import and cross-group
enrollment are deferred. Fork remains a separate optional follow-on. The compact
header and one Agents view retain inline Reads future discussion / Replies by
default controls; explicit `@` selection chooses responders for one prompt.
Setup, joining and reading alone invoke no model.

[Slice 2 conversation contracts](symposium-conversation-contracts.md) extend accepted
PR943 membership with policy revisions, durable message/delivery identities,
immutable review objects, pending fresh allocation, authenticated API reads and
offline client projection. Public preparation/send routes remain explicitly disabled;
application wiring and account-by-runtime qualification remain outstanding.

Canonical staging and its pipeline were stood down by the user on 15 October.
Historical staging procedures below do not authorize checks, enqueue, recovery,
restart, recreation or deployment. Use offline tests, review and CI. Live work
requires a separately selected authorized target; production activation is separate.

Keep this item related to existing Telos outcome `4f55b423d0731750` (conversation-first
work, durable outputs and access). They have separate acceptance criteria and a
shared identity contract: ordinary chat comes first; work/artifact/Telos identity
can outlive any contributing session; sessions and work can have explicit
many-to-many associations. Similar titles or shared participants never imply work
membership. This source records the relationship; it does not update the live tracker.

Artifacts are the enduring pieces of work. Agents and their sessions contribute
to selected artifacts; they do not define those artifacts' lifetime. Begin with
ordinary chat, without mandatory profile, outcome or artifact setup. Register
useful work when requested, then associate it with a Telos outcome when appropriate.
Registration, independent retention, review, publication and outcome verification
are separate facts.

An artifact set may contain a planning document, an inline draft, an external
document and a code change set. Hundreds of changed files belong to a change set,
with Git as the canonical source and exact revision/snapshot evidence for review.
An external link does not establish retained content, current revision or agent
access. Findings attach to the exact package and revisions inspected.

Contributors use explicitly selected accounts, models, context and permissions.
Reuse the existing Mitzo ordinary chat/resume route and existing session identities,
while keeping each contributor's thread, context and execution binding independent.
Enabling collaboration must not require a new account, login or execution environment.
The bounded Codex candidate below covers an earlier output-contributor adapter;
it does not yet join arbitrary existing sessions through all ordinary command drivers. The native
Symposium adapter remains a separate execution boundary. Preserve credential
boundaries, admission, cancellation, provenance and uncertain-operation reconciliation.

Reuse existing membership, directed delivery, attribution, findings and review
history. Do not introduce another account store or scheduler. Basic collaboration
must not depend on completing the broader automated review/fix/publication workflow.

The October 7 **Design Session UX for Approvals** discussion
(`01a1182e-922e-7533-a627-9afab2ec77ad`) supplies the artifact-centered direction;
the October 10 **Explain Symposium Account Separation** discussion
(`01a123b1-df7a-7082-a0ef-7480820b07c8`) adds ordinary account/session reuse and
guidance cleanup. Mockups and reviewed plans do not establish live capabilities.
The candidate's transcript references do not establish independent content retention
or artifact migration; preserve existing storage restrictions.

## Bounded candidate and next validation

### Existing-session association slice

`/api/session-collaborations` persists revisioned associations between existing
ordinary sessions in the EventStore database. A collaboration has its own stable ID,
independent of a parent session, work item or artifact. It carries participant IDs,
not copied transcripts, account credentials, runtime configuration or execution grants.
Each session retains its original account, model, workspace and provider history.
One session can participate in several collaborations without combining their work.

Interactive operators can create or revise membership with an expected revision,
read it after restart, and rediscover it from a participant session. Exact last
mutation retries do not append revisions; competing updates conflict. Missing,
hidden, internal helper and legacy native Symposium identities cannot be added.
Existing unavailable references remain visible until explicitly removed. Unlinking
does not stop or delete any session. Future links to artifacts or Telos must use the
existing work association owner and explicit revisioned targets, not infer work
identity from a group or its first participant.

This is backend association only. It does not dispatch turns, merge context, expose
a new chat UI, retire legacy paths or prove any account/runtime ready. The remaining
slices are directed ordinary execution, unified attributed chat, stop/reconnect/resume,
then live account-by-environment qualification. Those slices reuse existing execution,
delivery and lifecycle owners rather than build another session system.

### Earlier output-contributor adapter

[PR #837](https://github.com/dimakis/mitzo/pull/837) records the bounded implementation
for exact finalized transcript references and independently admitted
ordinary Codex-backed contributors per selected output. Child-thread continuity,
attributed replies, optional durable guidance and Stop/recovery have offline test
coverage. The shared service permits multiple contributors, including reuse of one eligible
account, with separate allocation receipts, child conversations and directed messages.
Each child still passes ordinary account, dispatch and runtime admission; output
membership does not grant runtime capacity. Independent content retention, output
revision editing and Vertex contributor adapters remain outside this bounded slice.

The ordinary contributor adapter also admits existing OpenAI API accounts when
the normal dedicated OpenShell Codex route is configured and the selected account
already has its sandbox provider binding. Select Agent or Auto mode, as required
by that ordinary route. Responses execution and named retained sandboxes do not
provide this contributor admission. Account and route compatibility are checked
again before dispatch; no Symposium-specific account or target registry is added.
Offline tests cover startup, independent continuation, replay, attribution and
uncertain Stop. These checks do not establish live provider enrollment or runtime
adoption. Ordinary chat remains free of automatic output-workflow setup; this
backend capability does not add that workflow to the composer. An explicit
Workspace Collaborate action opens the bounded work view on request; it does not
establish standard owned-driver parity or dedicated native setup retirement.

PR #899 records the ordinary OpenAI API admission extension. The independent
contributor extension must also pass its own exact-head CI and review before
source acceptance. Source acceptance and review evidence remain separate from live proof.
Verify freshly accepted main before selecting a runtime candidate. The next work
is validation against the actual runtime, followed by separately authorized live
qualification; do not reimplement the already-written adapter.
Canonical staging enrollment and live qualification remain unproven. Source
acceptance, runtime adoption and live acceptance are separate; no deployment
is established by this guide.
Use the [current acceptance checklist](symposium-integrated-acceptance.md) and
[ordinary entry-point map](symposium-ordinary-entry-map.md).
The UI follows the [shared design contract](../design/ui-design-system.md): show
the work prominently, with discussion, contributors and Access in supporting roles.

## Profiles and reusable reviewer recipes

Reusable guidance remains separate from credentials and session-specific grants.
The Agent Library and existing profile draft/catalog controls are source features;
saving a profile does not activate it or prove provider availability. Profiles are
optional guidance. Select account, model, context and authority for the contributor.

Native Codex Symposium API and subscription seats reject pack recipes before provider setup, and native Claude seats reject all context recipes. Choose a profile without a context recipe for either native seat. Native Gemini Symposium dispatch is unsupported. Ordinary Claude SDK, OpenAI Responses and Gemini/Vertex chats support packs. Native pack delivery integration is preparation: Codex requires a reviewed native build and enrollment with a trusted source-authority barrier before every provider continuation. Application tool callbacks or project-instruction settings alone do not establish that barrier.

Ordinary chat's context-recipe compiler is accepted source. The candidate contributor
adapter does not compile or authorize recipe context sources and explicitly rejects
recipe-bearing saved profiles. Use Default Mitzo or a compatible saved profile without
a context recipe. Accepted compiler source does not prove runtime context adoption.

## Artifact route composition ownership

`server/symposium-artifact-route-composition.ts` owns the publication, review and
source mounts between ordinary GitHub publication and the Director. It uses the
existing stores and resolves the current host, source capability, review runtime,
publication registration and repository configuration at request time. `app.ts`
retains store lifetimes, host/runtime installation and publication approval hooks.
Reviews retain their own operator middleware and request-action authority;
publication and source retain their outer operator middleware and existing
reauthorization/JSON checks. No native or legacy path is retired by this extraction.

## Director route composition ownership

`server/symposium-director-route-composition.ts` owns the Director mount directly
after the artifact routes, with the existing outer operator middleware. It adapts
current account validation, grant operations and event-store perspectives for the
Director. Host readiness, account catalogs and verified runtimes are resolved at
request time; the safety orchestrator remains available independently of a verified
runtime. `app.ts` retains construction, installation and teardown of all borrowed
stores, grants, registry, hosts and runtimes. Unbound Director selections retain
their existing validation behavior; host grant construction still requires a binding.

The configuration family is owned by `server/symposium-director-configuration.ts`:
draft, selection, activation, seat revision, configuration updates and operation
receipts. The Director router registers these handlers directly in their existing
positions. Operator-bound receipt replay precedes current runtime/account/revision
checks, preserves exact canonical requests and returns the original committed
configuration without minting new grants. The legacy identical-config retry remains
separate from keyed operation proof. Mutation-started flags retain their existing
uncertainty semantics. Membership uses the same cross-account predicate; safety,
recovery, perspectives and dispatch remain in the Director router.

## Reference map

| Question                                                    | Read                                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current direction, candidate and next validation            | This guide and the current acceptance checklist                                                                                                                        |
| Live staging or enrollment                                  | [Canonical staging](../operations/canonical-staging.md), then [Symposium singleton staging](../operations/symposium-singleton-staging.md) for the selected operation   |
| Existing native credentials, mounts, artifacts or ownership | Relevant `docs/operations/symposium-*` contract and current code owner                                                                                                 |
| Prior implementation and acceptance evidence                | [Archived feature snapshot](../archive/symposium/2026-09-symposium.md) and [archived acceptance plan](../archive/symposium/2026-09-symposium-integrated-acceptance.md) |
| Full review, fixes, criteria or publication                 | Relevant authority contracts when selected; not prerequisites for the first collaboration slice                                                                        |

Operating documents describe narrow contracts, not competing roadmaps. Read only
what the selected operation needs. Historical pins, inventories, candidate hashes
and receipts must be freshly reconciled before use.

## Superseded tracking and evidence

`6403fb22f9bb743c` and its seven children were superseded as execution instructions
on October 3 by `c0851ba23fcc5d04`. Their records and completed foundation work remain
historical. Old phases and task hints do not create current work or authorize
replaying diagnostic recipes. Administrative closure is not feature completion.

The former PR #678 checklist and larger package sequence are archived. PR #750
consolidated source and #806 added diagnostics; neither establishes this new
integration or a current working release. Consult exact receipts for prior claims.
The existing native implementation still has a dedicated host/account path; the
shared route has not been accepted by this documentation change.

Production activation, provider enrollment and retained-owner/resource settlement
remain separate, operation-specific requirements. Live model tests explicitly
use a supported Luna model with the exact charged account announced beforehand.
