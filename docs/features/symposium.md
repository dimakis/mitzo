# Symposium: current direction and source guide

Updated 10 October 2026. Start here for Symposium product work.
Existing Telos item: `c0851ba23fcc5d04`; reuse it rather than create another parent
or a task for every document. Tracker closure and source landing do not prove
runtime acceptance or authorize deployment.

## Product direction

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
Reuse the existing Mitzo ordinary chat/resume route while keeping each contributor's
thread and context independent. The bounded Codex candidate below implements this
adapter; it requires no new account category or Symposium sign-in. The native
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

[PR #837](https://github.com/dimakis/mitzo/pull/837), reference `62d40d16`, is the
written candidate for exact finalized transcript references and one additional
ordinary Codex-backed contributor per selected output. Child-thread continuity,
attributed replies, optional durable guidance and Stop/recovery have offline test
coverage. Independent content retention, output revision editing and API/Vertex
contributor adapters remain outside this bounded slice.

Current-head CI and final Centaur LGTM remain pending. The next work is source
acceptance and validation against the actual runtime, followed by separately
authorized live qualification; do not reimplement the already-written adapter.
Canonical staging enrollment and live qualification remain unproven. Source
acceptance, runtime adoption and live acceptance are separate; no deployment
is established by this guide.
Use the [current acceptance checklist](symposium-integrated-acceptance.md).
The UI follows the [shared design contract](../design/ui-design-system.md): show
the work prominently, with discussion, contributors and Access in supporting roles.

## Profiles and reusable reviewer recipes

Reusable guidance remains separate from credentials and session-specific grants.
The Agent Library and existing profile draft/catalog controls are source features;
saving a profile does not activate it or prove provider availability. Profiles are
optional guidance. Select account, model, context and authority for the contributor.

Ordinary chat's context-recipe compiler is accepted source. The candidate contributor
adapter does not compile or authorize recipe context sources and explicitly rejects
recipe-bearing saved profiles. Use Default Mitzo or a compatible saved profile without
a context recipe. Accepted compiler source does not prove runtime context adoption.

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
