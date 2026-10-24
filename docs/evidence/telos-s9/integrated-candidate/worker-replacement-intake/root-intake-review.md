# S9 worker replacement intake

**Bounded functional PASS, with one P3 evidence-wording correction.** No actionable production or selected-journey assertion defect found. Reviewed frozen `e4ef207b418b46e9a650422c1d9ee0fcb3541fad`, tree `d6b6b13fe45b599b4b4b0ac581d840b48de749da`, direct parent `fcd7da5e94eb7ca8833fef97c0d4b83ffd766734`. No tests/compiler/browser/services/network/models were run; no producer/index edits or owner messages occurred.

## P3 — correct accessible-name attribution

`S9-WORKER-REPLACEMENT-RESULT.json`, `visualInspection.accessibleNames`, incorrectly says the buttons have duplicate `OpenOffline restart` aria-labels. Its own final raw `chooserRows` records these three distinct names twice, before/after restart:

- `Open Previous conversation: Offline restart`
- `Open Additional worker: Offline restart`
- `Open Assigned worker: Offline restart`

Frozen `frontend/src/components/TelosChatList.tsx:82` builds the accessible name from the role plus optional title. The earlier exact `Open Assigned worker`/`Open Additional worker` locator omitted the appended `: Offline restart`; the title text repeats, but the role-prefixed accessible names do not. Correct this report field and the corresponding diagnostic explanation, retaining all original raw evidence. No production/test change is required. Full accessibility qualification remains pending; this correction does not supply it.

## Source and actual owner path

Read all four new dedicated files completely, reused loaders/fakes and relevant real setup/assignment/history/delegation/context owners. Relative to baseline `99a8ab4ec03a83c62c11875468fa092d0b3cc5cc`, only those four files are added. All 85 prior S9 files, production72+f47, strict-nine runner/cases and workflow are unchanged. Independently verified all 667 actual source hashes and 13 protected references.

The dedicated fixture/child follow the retained task-review fixture/child: differences are names/paths/type and omission of the unavailable unadmitted-native read/commands. Provider-tool transport remains the reused, uninvoked seam. Snapshot `nativeOwnerObservation: not_read_no_native_admission` describes an omitted read; it is not an empty native ledger or zero-command assertion. Actual session, workspace, preparation, role-context, events and task-binding readers remain. The selected snapshots also omit the unavailable command admission; their unused nonnullable fixture annotation is not admission evidence.

The initial delegation genuinely creates a linked worker and pending execution task, **without current assignment**. The test checks that absence, then explicitly selects the linked worker through signed `api.execute(assign)` with revision0. Actual routes require the retained reviewed role context (`telos-work-routes.ts:208–217`, `app.ts:2443`); the work store requires a matching link and exact revision, increments assignment and appends history (`telos-work-store.ts:1213–1248`). This is an authorized owner mutation, not fixture assignment fabrication.

Actual UI setup produces two recorded POST200 responses. New chat uses worker/null assignment revision and leaves current revision1/original attempt intact. Change worker uses expected revision1 and advances current assignment to revision2. All three links remain. The current-first/history-backed label projection agrees with Previous/Additional/Assigned worker labels; six row selections assert exact opened IDs and independent drafts across restart. Three distinct workspaces/cwds and retained role contexts/events agree before/after. Original task remains pending, completedAt null, with original immutable worker/attempt binding; lead and unrelated drafts/work also remain.

The real historical-delegation replay returns the exact original receipt while the typed work view remains the replacement revision2 view. The actual delegation owner reuses the retained allocation and exact task/context binding; it does not convert historical receipt execution data into a new assignment or dispatch. Raw before/after session inventories also agree, with no duplicate session observed.

Published `ordinary-worker` revision1 profile snapshots and account bindings are present and identical before/after for all three workers; actual preparation receipts retain the selected local runtime binding. These are retained observations and owner validation, not an explicit `getSessionRuntimeBinding` snapshot assertion or evidence of native admission/provider activity. No unsupported `SessionMeta.runtimeBinding` comparison is used by this new journey.

## Evidence and boundaries

Raw final result: **1 PASS, 0 FAIL, 0 SKIP, 24.975 s**, SHA-256 `d4147cd6897e674bce91c92ad1be62e2c1b290a4e85b5f066c801bd8d2ac526d`. Its observations match the producer report. Verified 28 claimed hash/size entries. Source archive has 270 exact immutable tracked members plus five exact custody documents/Git patches; diagnostics archive has 47 exact retained members. Zero integrity mismatches. Full hashes/checks are in the companion JSON.

- Source ZIP: `419e6bf619ae086fb6871cbeb0581541c05370410d06d211a4b2134e8ca19811`
- Diagnostics ZIP: `48879e0bcff7118238782cd0a8c4e7c0156559498f018eb29b607a71416ba89d`

Retained lifecycle shows both selected and all five diagnostic App PIDs ready/exited; fixture kill awaits exit and checks absence. The fresh selected App has a distinct PID, same signed auth/private paths and stable browser origin. Selected effects are two synthetic metadata-only preflight closes; four diagnostic runs total five, with no recorded native launch/thread/turn/resume/interrupt/tool effect. The reviewed loader forbids external model/network use and does not replace role/setup/state owners. `h.http` logs cover fixture requests; actual browser setup bodies/statuses are separately recorded.

All three failed diagnostics remain: unavailable native snapshot, mistaken delegation-implies-assignment assumption, then incomplete exact accessible-name selector. Corrections preserve actual owner assertions and add explicit guarded assignment/visible-role-to-ID-and-draft verification; only one final pass is counted. No product failure or receipt/state fabrication is inferred.

Inspected captures show assigned/additional rows and actual replacement setup. The two named three-row captures are identical chat/draft transition images, not stable three-row chooser screenshots; the report correctly retains that visual limit. Full UX14/15/21/CT15, device/keyboard/theme/accessibility, native inference/history/output, superseded-worker command refusal, task/outcome completion, accepted-main/CI/trusted review and live qualification remain separate. Accepted main `65863c3d…` is a reference only. Parent/S9 acceptance remains active.
