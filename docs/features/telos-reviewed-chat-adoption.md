# Reviewed existing-chat adoption and safe recovery

Delivery candidate, 13 November 2026. This extends `TelosCreateSession` with an
explicit `existingConversationId`. The originating-chat transcript review uses
the existing `SessionLaunchCards`, `HomeDialog`, settings editor, work-context
review and named related-chat navigation. **Approve & adopt** retains the exact
ordinary chat, workspace, account, runtime selection, profile, prior history and
drafts. It creates no replacement, command, credential or execution grant.

For initial child creation/adoption the source caller still needs the current
parent lead assignment and an exact direct child/work revision. The selected target must have no existing work role
or immutable contributor context. Supported callers remain owned Codex Local Mac
and OpenShell, and Claude Local Mac. The target is either a compatible independent
Local Mac Codex ordinary workspace or an existing idle Local Mac Claude SDK chat
(see below). A proposal is not assignment or readiness.

## Existing Local Mac Claude chats

Since 19 November 2026 (PR #1395), `existingConversationId` and `replaceOwner`
also accept an idle Local Mac Claude SDK chat on a Vertex, subscription or API-key
account, as outcome orchestrator, feature lead or slice worker. The Claude SDK
engine owns repository workspaces, so the adoption records `workspaceKind:
repository` and the chat's claimed repository task. The same review card shows the
chat's retained account, model, thinking, permission mode and agent profile; the
proposal's `startupBlocker` uses the chat's own engine, not the Codex-only creation
route. Approval keeps the account, model, workspace, SDK session and history.
It copies, inherits or transfers no credential, grant or permission, and retains
former attribution exactly as for Codex.

The custody hash covers the session, repository task identity, retained SDK custody,
runtime binding and latest consumed command selection. Approval requalifies the
host's Claude route and the checkout identity instead of an ordinary preparation.
A Claude chat is idle when it has retained SDK custody and no running execution,
pending SDK input or uncertain command. A warm idle SDK owner is closed without
interrupting a turn; its next ordinary command resumes the retained SDK session
with the new role context. A cold Claude chat needs no retirement, because its
SDK process lives only inside the query loop that leaves the registry when it
finalizes. Proposal and approval refuse unsupported targets with named reasons:

| Reason                           | Meaning                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `existing_chat_busy`             | A turn, queued input or uncertain command exists, or the live owner is closing. |
| `existing_chat_openshell`        | The chat runs on OpenShell.                                                     |
| `existing_chat_foreign_operator` | Another operator login created the chat's SDK custody.                          |
| `existing_chat_incompatible`     | Not an executed Local Mac Codex ordinary or Claude repository chat.             |

A chat proposing itself for `replaceOwner` is mid-turn at proposal, so only
approval checks that it is idle. After approval `TelosManageItem` overview shows
the Claude chat as `currentLead` or `currentWorker`. An adopted Claude lead can use
`TelosCreateSession` for its direct children, including adopting further Claude
chats. New Telos children are still created only on Local Mac Codex.
`TelosStartSlice` cannot start a Claude worker: its first-command authority is
Local Codex only, so the overview reports `startExistingWorker.reason`
`claude_worker_start_unavailable` and the worker takes its first instruction in its
own chat or through AgentCommunication. Qualifying the Claude SDK owner for
TelosStartSlice first-command authority is a recorded follow-up.

Offline tests drive the real proposal, operator review, approval and canonical
assignment path with real EventStore command, SDK custody and role-context owners:
a Codex orchestrator adopts a Claude feature lead, that lead adopts a Claude slice
worker, an idle Claude chat replaces a current owner, and busy, OpenShell,
foreign-operator and busy-at-approval targets are refused without assignment.
Only the repository checkout ledger lookup is synthetic in those tests.

## Reviewed owner replacement

`TelosManageTeam` exposes the explicit operational roster to ordinary native and
Claude SDK chats. Read returns the team revision and current/former memberships;
link, replace and unlink use that revision and exact request-only approval.
Investigators, implementers, reviewers, merge agents and contributors keep their
independent settings. These operations use the canonical team journal and never
change runtime role assignments or transcript/execution authority. Native and SDK
adapters classify only its `read` operation as free of mutation.

An available ordinary chat can propose replacement through `TelosCreateSession`
with `replaceOwner: true`, the owned item's ID/current revision and the exact
`existingConversationId`. The target may be the proposing chat. It must satisfy
the same supported idle Local Mac Codex workspace or Local Mac Claude chat and
immutable-context checks.
The current owner need not be warm or the proposer. The host derives the role and
retains the previous canonical conversation and assignment revision for review.

The existing transcript review shows the previous and incoming chats and an
explicit **Approve & replace owner** action. Proposal text and roster membership
confer no role. Interactive operator approval composes the original role journal,
admission hold, retirement, context and release owners. The canonical replacement
and receipt commit atomically under the reviewed work/assignment revisions. It
preserves former links, assignment history, all prior attempts and old chat state.
Unfinished replacement reserves the role; competing assignments cannot bypass it.
New responsibility affects canonical role fences, with no inherited grants,
provider admission, implicit cancellation or model execution. Initial child
creation still requires the current canonical parent lead and its reviewed context.

Lost responses and partial context recover the original operation. Cancellation,
revocation, changed custody and unproved retirement retain visible uncertainty;
safe release still needs the original owners and durable absence/retirement proof.
An **Owner replaced · execution not started** receipt records assignment only.
Source merge and runtime activation remain separate from actual operator adoption.

## Canonical transition and recovery

The existing reviewed role intent owns the operation identity and immutable
selection. Its allocation operation ID also identifies the enduring command
epoch hold. Current account/workspace/settings custody is hashed; transcript
history is neither copied nor used as authority. Source visibility and immutable
material hashes are requalified through the real role host.

Before acquiring a hold, EventStore and native command owners must prove no
active, queued, preparing, uncertain or recovery work. An executed cold chat with
no retained exact runtime owner is refused before acquisition. Registry absence
alone never proves resource cleanup. A never-command-admitted ordinary workspace
can be adopted without manufacturing a runtime.

For a warm idle owner, retirement closes the exact native conversation without
interrupting a turn. It awaits all transport generations' process-close events,
host callbacks, native runtime cleanup, MCP/hook cleanup, shared query cleanup
and the outer prepared driver/operator release. First failures remain internal
causes; public errors and structured diagnostics expose only bounded stage/code
and operation/session identities. Cleanup does not replace the original error.
The host retains the exact session object for each operation across separate
authenticated recovery requests. A later adoption cannot inherit an earlier
operation's owner. Durable retirement proof is written only after those drains
settle.

Under the hold, the canonical assignment receipt commits **before** context is
appended. The hold prevents execution while context or its presentation remains
incomplete. This order permits recovery of partial context writes even when work
changes afterward: the original receipt and reviewed immutable material are
requalified, never replaced. The user-facing assigned receipt appears only after
context recovery and the committed transition-release receipt are both checked.

| Interruption                                    | Recovery                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Lost proposal/approval response                 | Reuse the original request and immutable review.                                                            |
| Retirement interrupted in the same host process | Await the retained exact owner again; preserve any original cleanup failure.                                |
| Restart after durable retirement proof          | Reuse that proof and the original role intent; never allocate or start a replacement.                       |
| Restart before proof, with no surviving owner   | Remains visibly uncertain and held; absence is not a release permit. Host-owner reconciliation is required. |
| Context partially stored after assignment       | Recover the original receipt/context through the role owner, then release the hold.                         |
| Assignment committed but release response lost  | Refresh reconciles the original transition before reporting assigned.                                       |
| Work changes before assignment/context          | Reviewed release may abort only after retirement is proved and no role context/assignment exists.           |
| Release response lost                           | Acknowledge exact historical release receipts without re-proving mutable chat settings.                     |

**Review release** is a separate originating-chat dialog. For create-only
reservations, canonical workspace and EventStore allocation owners must prove
absence. A durable allocator tombstone prevents an older pending request from
allocating later; then the role reservation is released without erasing its
journal. An existing allocation must be recovered. For adoption, release requires
the exact original review owner, unchanged target custody, no retained role
context/assignment and, if held, durable retirement proof. Stale command epochs
remain invalid even after abort. No timers or guessed fresh request IDs resolve
uncertainty.

## Dependency and verification record

Accepted main `fee7388ba9646f9104fa4aefd7725ca027aa0779` contains accepted #1302
and #1320. Integration commit `f5f2a5c58` preserves #1324 head
`ffe85071476cf5a6a10fbc63ece174feb9ed08c2` and all eleven recovered continuation
commits through `8f5ed6d731ca98825fd131e04461ca52f40b8548`. Conflicts were resolved
by retaining both main's learning behavior and the prerequisite context fences.
#1324 remained open, non-draft, conflicting against its historical base at the
13 November recheck. Its owner `88183026-8bf2-8467-a603-216ebae61688` was not
available through the session peer list; its branch was not changed. This is an
independent dependency-aware candidate, not authorization to merge #1324.

Before publication verification, main advanced to `9147f18ff` (#1328). The
accepted Symposium settings-context boundary and its tests/design rule were
preserved through a merge; only the shared source registry needed conflict
resolution, retaining both source sets at runtime revision 1112. This does not
change the adoption settings or runtime support matrix.

Focused tests cover real canonical stores/workspaces/role hosts, HTTP review and
failure consumers, transport/query/finalizer owners, cancellation, stale custody,
partial context, lost release responses and allocator tombstones. Tests use one
worker and a 1 GiB Node heap. Separate read-only reviews found and prompted fixes
for assignment-before-release reporting, request-scoped retirement custody,
missing outer driver cleanup, cleanup-only error delivery, partial context
recovery, and historical release acknowledgment.

Current local evidence: 242 tests across 11 focused owner/router/UI files passed,
then the two affected owner/adapter files passed all 47 tests after the final
operation-identity and completed-receipt fixes (45 overlap, two added). The three
transport/conversation/chat suites passed 777 tests. Protocol/harness/client
package compilation, selected-root semantic checks (22 roots, 2,130 loaded
files), scoped ESLint/formatting and source-artifact verification passed. These
are bounded checks, not a full server build or full suite.

The offline browser suite now covers adoption settings locks and named chat
navigation, review/receipt, release refusal, retained drafts, light/dark themes,
320px mobile and desktop. Local Chromium initially lacked an installed binary;
after a task-local install, macOS denied its Mach-port registration. No browser
retry followed that denial. Current-source visual screenshots remain a CI
requirement; component tests do not substitute for browser evidence.

The bounded TaskExecution selected-file commit service could not commit this
native clone (`e9d438d3-c558-4ac3-86cf-396766b45f45`, uncertain service receipt).
Read-only Git inspection established no staged/commit effect before using the
separately authorized native Git route. An earlier oversized read-only command
also retained an uncertain receipt (`df81f31e-a8ff-4c77-a653-12f951cb6894`); it was
not replayed. Neither record was erased or treated as success.

Parent `85e8444019a4ae4a`, S4/S5/S5b/S6/S9 identities, active state, assignments,
attempts and historical evidence remain unchanged. This implementation chat has
no claimed Telos role binding. The historical recovery document referenced by
the parent was not present in the enrolled Knowledge revision
`8ca45db12597353d2f3a245da0c2c3a5583feaf9`; retained branch history and the live
contracts were used without replaying historical operational instructions.

The original delivery above authorized source preparation only. Broader parity
remains with native harness owner `477c9d52d200c0f6` and readiness owner
`65129503d34b4bc3` for a later delivery.

## Landing takeover, 13 November 2026

Dimitri requested takeover and merge of #1330 in conversation
`b1b28524-e090-8e60-8e29-5408706fd02d`, explicitly after the EnMaaS work lands.
The prerequisite is #1329. The previous owner confirmed its stand-down and
preserved its checkout; this takeover uses a separate clone. Deployment and
live-model qualification remain outside this request. No landing request may
allow #1330 to overtake #1329.

GitHub confirmed #1329 merged at 10:30:55 UTC on 13 November as accepted
`cfa324ca72d72acee34dab816631b0c6e26df673`. The final integration retains its
approved EnMaaS setup, model visibility and model-less editable drafts, plus
current learning guidance on SDK query replacement. Only the shared source
registry conflicted; both source sets remain registered with combined hashes.
Both independent integration follow-ups found no blocker: Codex retirement and
provider-context fences remain intact, dispatch still requires a model, and
adoption retains the target's settings. Combined local checks passed 202 tests
across 14 files with one existing conditional design skip, including SDK query
replacement, adoption/role/delegation owners, hidden-model consumers and design
guards. All 2,395 source pins verify and a parent-union check finds no missing
registration. Current-base CI and the final Centaur report must cover this
combined candidate before merge.

Centaur review `5889479048` reported `CEN-5537E55B7984`: adoption could commit
and release admission yet remain unconfirmed when a chat's admitted thinking
selection differed from its original allocation. Confirmation now uses the
canonical reviewed adoption intent rather than requiring the historical
allocation settings to match. Create-only confirmation keeps its exact settings
check; assignment identity, original allocation custody, context, retirement and
committed release checks remain required. A real-store regression completes two
synthetic admissions with different supported thinking selections, adopts the
same chat, loses the assignment response and recovers its original receipt
without allocation or dispatch. It fails against the old comparison and passes
with the correction. All 57 focused owner/runtime/service checks pass; source
pins, ESLint and formatting pass at runtime revision 1123. New-head CI and
Centaur verification remain required.

CI `43412449835` exposed three migration-refusal regressions in unit shard 2:
the new allocation-release table survived a refused legacy custody migration.
All three reproduce locally. Custody initialization and migration now share an
outer SQLite transaction, so refusal rolls back every new auxiliary table.
The existing external-view, foreign-key and trigger tests now compare the entire
schema without excluding the preparation table. All 87 custody and ordinary
role-setup checks pass with the fix; existing successful migration, release
tombstone and custody protections remain covered. Runtime source revision 1124
records the correction. Hosted CI and Centaur must verify this later candidate.

CI `43397518370` failed server test compilation: the host callback fixture
returned `Promise<void>` instead of a JSON reply, and spread adoption inputs
widened `createOnly` from literal `true` to `boolean`. Commit `8811cc5e` fixes
both fixture types without changing production behavior. The affected suites
passed 103 tests; selected-file semantic checks loaded 2,249 files with zero
diagnostics. These checks do not replace full CI.

Commit `e76f5a89` integrates accepted #1326 at
`f08f01733fa5e722569203d90018b1853b909705`, preserving both source-registry sets.
Its shared owner/helper/delegation integration passed 98 focused tests. An
independent correctness review then found that the incoming worker-reservation
guard also blocked safely released reservations: retained setup rows have no
receipt after release. A regression reproduced the refusal after durable
allocator release and canonical-owner reopen. The guard now excludes canonical
release tombstones, consistent with role setup's existing exclusion. Active
reservations remain blocking; old setup replay remains rejected; delegation
allocates one worker and replays its original receipt. Both affected suites pass
74 tests, including the new regression.

An independent full permission/security pass found no blocking issue at
`e76f5a89`; its targeted follow-up approved the release-guard correction.
The independent correctness review also verified the correction with no remaining
blocker. Full hosted CI, current-source browser screenshot inspection and
exact-head Centaur final approval remain separate gates. Local review cannot
supply Centaur's trusted status.

Non-blocking resource follow-up from security review: the host-lifetime
`retired` map in `server/telos-adoption-runtime.ts` retains completed runtime
owners. Add a host-only forget operation after durable retirement proof and
canonical completion, preserving exact operation identity and strong ownership
for interrupted pre-proof recovery. Verify completed-owner collection and
uncertain-owner replay before changing this lifetime policy.

The new selected-file commit-service request
`6cf03919-f50f-426c-99c3-17ff10143306` targeted the enclosing MGMT repository.
Its unpublished accidental commit was removed with all source files preserved;
MGMT returned to its original `8ca45db1` head with no tracked payload changes.
Mitzo commits use the native nested-repository route. Read-only request
`ebcdd0ab-a1f6-402d-b16c-b35d5686fa1e` exceeded the tool output bound and retains
an uncertain receipt; it was not replayed or counted as successful execution.
