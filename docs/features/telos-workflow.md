# Telos work planning

Telos is the durable work contract and handoff between sessions. Each brief should
let a fresh agent understand the intended result, why it matters, scope, ownership,
dependencies, sources, next action and evidence of delivery. Use a concise title,
intent (what to achieve), rationale (why) and observable acceptance criteria (how to
verify it). Reference named artifacts for detailed plans and evidence.

Reach for Telos when the ask needs multiple independently deliverable slices or
handoffs between sessions. First propose the feature, session-sized slices and
session ownership. Several steps in a single implementation are not several slices.
Simple one-session work stays in chat unless the user requests Telos or an existing
item already governs it.

The intended work model is:

```text
Outcome: a shared result across features
  Outcome orchestrator: features, dependencies, integration, merge order and CI
  Feature item: one feature, standalone or under the outcome
    Feature lead: delivery and coordination of its slices
    Slice: bounded work fitting one dedicated working session
```

Propose Telos, reuse existing work, save approved contracts using supported creators,
then verify reviewed session setup separately. A standalone feature needs no outcome
wrapper. `TelosCreateFeature` saves a standalone feature's complete brief, acceptance
criteria and audit note using the canonical item writer and an exact approved request.
It creates no milestone children. Retry uncertain delivery with the identical request
and request ID. `TelosCreateChild` can describe a feature under an outcome or a slice under a
feature. New `TelosCreateOutcome` proposals save a shared outcome and ordered feature
drafts; inspect and complete their briefs before execution. Milestone strings alone
do not establish complete feature contracts.

New creators now connect these levels to the existing runtime: shared outcomes use
`coordinator`, features use `outcome`, and session-sized slices use `work_item`.
Classification is committed with the item and creation receipt, so a new feature
offers reviewed lead setup and its slice offers worker setup. It grants no role or
execution authority. Older reviewed outcome packets retain their original meaning
and replay identity; there is no automatic migration of existing work.

Use reviewed role setup and the exact assigned lead's `TelosStartSlice` only for an
eligible selected child. Runtime kinds (`coordinator`, `outcome`, `work_item`) do not
redefine the semantic levels or prove nested feature-lead support. A missing creator
or assignment path is a capability gap; retain the brief and report the pending step.
Item creation, originating-chat provenance and a plain `StartSession` receipt do not
establish a Telos role, task mapping or working session. Chat readiness does not mean
execution or delivery. Reconcile the original attempt after uncertainty.

## Parallel-feature example

> Two features are being worked on in parallel; set up a merge-queue orchestrator
> session between the feature owners.

Propose a shared outcome above the feature items with an independent orchestrator
session. Verify supported assignment/setup separately. Each feature lead coordinates
its slice sessions.
Implementation, tests, review and PR preparation remain parallel; actual merges are
coordinated sequentially under the existing CI/review and merge-authorization gates.
This adds no scheduler, global pause or implicit merge/deployment permission.

## Existing capabilities and attachment gaps

Source inspection of the integrated delivery candidate on 11 November 2026 found
these boundaries:

| Capability                               | Evidence and limit                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Related-work tree navigation             | `TelosChatWorkTree` and `TelosOutcomesTree` navigate existing work and linked chats. These are work trees, not proof of arbitrary session nesting.                                                                                                                            |
| Independent role sessions                | `TelosOrdinaryWorkRoleSetup` creates/replaces ordinary chats from reviewed settings and bounded context. `TelosStartSlice` allocates/recovers an eligible worker without starting a turn. These paths are independent sessions, not inherited runtime authority.              |
| Link/reparent and assignment foundations | `TelosWorkCommandSchema` and `TelosWorkStore` retain revisions and relationship/assignment history. `app.ts` requires retained context matching the exact item and role before assignment. A command schema is not an exposed agent tool.                                     |
| Post-fact attachment or handover         | No generic session-link/role-assignment mutation is exposed in the inspected agent catalog. `retainTelosWorkRoleContext` rejects replacement of existing immutable context; role setup does not accept any arbitrary existing chat for adoption.                              |
| Three-level orchestration                | New creation maps outcome/feature/slice to the existing coordinator/lead/worker hierarchy. Creation and ordinary role setup are tested together. Runtime `work_item` remains a leaf; worker scope cannot arbitrarily redelegate. Live execution still needs its own evidence. |

Creating independent sessions from an existing session is the intended orchestrator
workflow. Tree navigation should show current responsibility alongside separate
creation provenance. Nested relationships need not nest runtimes; each session keeps
its own selected account, model, thinking, workspace, permissions and execution receipts.
This PR updates guidance and retains reviewed launch choices; it adds no attachment
API, role transition, session-tree redesign or automatic runtime nesting.

Ordinary `StartSession` currently supports a selected Local Mac Codex account,
model, thinking level, agent, host and permission mode in an independent workspace.
Its runtime rejects repository-workspace reuse, disabled isolation, nonempty context
blocks and additional tools before workspace effects. The editor fix preserves edits
when capability observation completes; it does not expand supported launch settings.
Original-operation recovery retains the reviewed configuration and startup receipts.
The intercepted launch browser fixture proves submitted intent and retains screenshots;
separate owned-runtime tests prove admission and recovery without live model calls.

A bounded follow-up for post-fact attachment/handover should use the existing role
and relationship owners: explicitly select an existing session, item and role; review
bounded context at a safe point; retain prior assignments; prevent dual active leads
and cycles; and preserve in-flight attempts, receipts and original creation provenance.
An intentional context transition needs its own supported contract because current
role context is immutable. Then expose that operation through reviewed UI/tool setup
and test handover/recovery through real consumers. Linking must grant no permissions
and execute no chat. Private session-database edits or fabricated metadata are not a
supported substitute. This follow-up is a capability plan, not shipped support.

## Delivery and boundaries

One shared source, `server/telos-workflow-instructions.ts`, supplies the workflow
to backlog-capable Codex chats, Telos role chats and the ordinary artifact guidance.
Tool descriptions repeat the relevant proposal/creation/setup step. Existing reviewed
role-context bytes, canonical schemas, allocators, permissions and receipts remain
unchanged. This is agent guidance, not another persisted workflow engine or automatic
migration of existing trees. Existing history is preserved when repairing legacy work.

Direction: Dimitri's 8 November work-model clarification, accepted in MGMT #365
(`architecture/discussions/mitzo/telos-work-model.md`, selected knowledge revision
`88361124acc6c24aadca35c9f6e4595c4e0e8967`), and the 9 November coordinator direction
on independent orchestrator sessions and post-fact attachment.
Source changes, CI acceptance and delivery to running agents are separate evidence.
