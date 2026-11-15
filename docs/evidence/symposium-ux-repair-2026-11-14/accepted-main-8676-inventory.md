# Accepted-main integration and source coverage inventory

**Successor observation, 2026-11-15:** own approval `e2e7a1db-7ef6-4caa-9560-b9eae72d5bcd`
admitted grant `a134d5a5-81bc-45ee-b76a-2d30ebdb98c4`. Local merge
`4cc9130d86652d835b76e9af1c08a4418de52448` now includes accepted main8676.
The initial read-only inventory below remains a dated baseline. The successor's
conflicts, source union and validation are recorded in
[main integration evidence](main-8676-integration/STATUS.md). The source-preserving
1354 → 1356 → residual1355 sequence remains required.

Slice3 acknowledged sole1347 recovery ownership, subject to its separate host
scope. Original writer, four commits and review5900149863 were read before any
write. Scope request `77e53885-2e3d-45aa-b2b8-664ad95c7276` expired at approval,
effect `not_started`; no checkout, source change or test ran for1347. No automatic
reprompt or use of1355's grant to bypass that boundary. The14-anchor gap remains.

Read-only inventory after parity PR1362 was accepted as
8676db5788f24e818f2c997da2011029ae11c68d. PR1355 and the local assigned branch
remain at707f7c13cf5491360a7d4adec39045b43ee08ba0, previous accepted base416faccb366f64ab858897f5b4bfa465e91ef385.
GitHub reports the PR conflicting with current main. No local merge or tests ran:
TaskExecution renewal a0e48374-8c7f-4f24-ae21-a367c82f1cbf expired at approval,
effectStatus not_started. The operation remains held until the user returns and
fresh bounded approval is available; no automatic reprompt or alternate executor.
Native GitHub reads used their separately authorized existing route.

The global coordinator's public source was read directly: conversation
9d3d439f-8e94-87c6-b00d-16f030dbdba3 event6128861 says the user wants the others
merged after parity; event6130690 records1362 accepted. This is coordination
context, not a released merge turn or inherited execution grant. Slice3 remains
the sole1355 writer/review owner and intended eventual residual landing executor,
conditional on current host authority, exact gates and global serialized release.
No actual merge/deployment turn is released.

| PR                                              | Exact inspected source                                  | Relationship to1355 / next action                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1354 participant grouping/search                | 7bdb364c0711746d0c9e3eec21c870b44111a772, base0ad803cda | Production/navigation and search-review corrections integrated in1355, including01887. Of28 changed production files,21 blobs exactly match1355; no file is missing. Seven combined owner files differ and require final integration review. Preserve standalone1354 provenance/landing.                                                                                  |
| 1356 continuous conversation/recovery           | 54437d9e8e8c3dc7fbe0454c0df87c6d4ae4c971, base416faccb3 | Production through6807 integrated as27ba and prior owner commits; of34 changed production files,28 blobs exactly match1355 and none is missing. Six combined owner files differ.54437 adds native-login cleanup test/pins/evidence, absent from1355; it was not needed to explain1355's capture failure. Preserve standalone1356 provenance/landing.                      |
| 1347 phone joining/readiness/permissions/dialog | 4f5dd94981c9c4bd4b9b31e639a3fae7f560772f, basee6411780b | Still open/unmerged.14 specific added source anchors across8 files are absent from BOTH main8676 and1355.1355 does not supersede1347. A verified current owner/refresh/review is still required; no phone/setup repair inclusion claim.                                                                                                                                   |
| 1355 independent integrated acceptance          | 707f7c13cf5491360a7d4adec39045b43ee08ba0                | Contains both production slices for verification plus independent real ordinary-chat/application/SSE tests, owner omissions, transfer controls, responsive fixtures/workflow and immutable evidence. Reconcile against accepted standalone sources so its eventual landing diff contains only remaining harness/evidence and any explicitly reviewed residual correction. |

Source blob comparisons are an inventory, not proof that differently composed
files are semantically complete or approved. Exact records:
`.cache/1354-1356-combined-scope-coverage.json`,
`.cache/1347-blob-coverage.json`, `.cache/1347-critical-anchor-coverage.json` and
the original1347 patch in `.cache/pr1347-original-files.jsonl`.

The combined files differing from both production PRs are ConversationAgents,
SharedConversation, protocol conversation store/source-setup owner/EventStore
and server/chat.1354 additionally differs in server/app due accepted-main
integration. Retain both owners' contracts and parity guards; resolve differences
through exact final trees/tests/review rather than overwriting with one branch.

## Explicit1347 gap

| Required change from1347                                                      | Direct source observation at main8676 and1355-707f                                                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions picker, explicit fresh-agent permission default and settings page | PermissionModePicker, initial permissionMode and permissions-page anchors absent from ConversationAgents/quick-settings context.                                      |
| Repository preparation readiness                                              | repositoryBlocked propagation from picker, review UI block and application-owner refusal anchors absent. Retained workspace identity alone is not checkout readiness. |
| Actionable stage/status failure                                               | conversationJoiningFailure consumption and HTTP diagnostic display anchors absent.                                                                                    |
| Sanitized owner diagnostics                                                   | joining_settings_failed, retained failure.cause and settings-stage reporting anchors absent from application review.                                                  |
| Phone dialog bounds                                                           | shared safe-area-aware dialog max-height token and scoped home-dialog selector absent. Current header layout changes do not replace these dialog changes.             |

These14 anchors exist in1347's exact source and not in either inspected target.
They do not establish the original phone freeze root cause or runtime acceptance.
Original phone chat/request/client build/operation identifiers remain missing.

## Proposed source-preserving sequence and gates

Both implementation owners agree on1354 then1356 then1355 residual acceptance;
1353 is already accepted and is not an additional candidate. No technical
dependency requires landing combined production through1355. Keep1347 as explicit
required work:1354 may remain first, then qualify/retain1347 before final
1356/1355 convergence, or leave its setup/phone gap explicitly open if it lands
separately later. The global coordinator chooses and releases actual turns after
owner readiness. Do not close/supersede1347 or duplicate1354/1356 production blindly.

After the relevant standalone sources are accepted, integrate their exact main
commits into this same assigned branch, verify the remaining diff against accepted
trees, retain original failures/provenance, rerun affected deterministic integrated
acceptance and browser/design checks, then obtain exact-head Centaur follow-up
and combined CI. Every conflict resolution and residual edit needs review. Old
unchanged-source qualification is evidence, not approval for new main integration.

At1355-707f, focused43621524389 passes19 checks (14 authenticated application,
five client/portal) and62 browser tests/probes. Full43621524457 is terminal FAILURE:
only native repository workflow132528812848 fails; other jobs succeed. Original
capture diagnostics d9e0925a-53bd-4be1-b5eb-ed884d88e281 and
ec49acc6-ddc9-4dca-9a7b-c3cfc7694f87 retain unknown cause/effect, without a verified
capture owner/fix or safe replay. Exact logs/account artifacts/current matrix remain
under `current-707f7c13c/`. Own Centaur7522 still has no terminal attributed verdict
at this observation. The prior12-check timer is completed and was not restarted.
Main8676, standalone1354/1356 successes and an accepted review request do not
qualify the combined successor. No staging/live-provider/device/deployment work.
