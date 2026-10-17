# Symposium integration acceptance evidence

Living map owner: workstream C, `01a14bdc-d152-7912-84d4-c0012e9d5206`.
Milestone `358d56cb7e4352ff`, parent `c0851ba23fcc5d04`; both remain active.
This map succeeds core's frozen `requirements-and-reassessment.json` seed. Core
owns the shared implementation plan/checkpoint; this is scoped acceptance evidence.

Latest independently observed checkpoint (18 October local time): exact core
`cb32e03fda3babb9fe14fd3e486175e5b881f4d6`, production tree
`9a33fd7693392147f5871ac4dff8ed49fc127d66`, plus scoped C overlay
`713fb30e9e5b499c2466bd821b4c9b41f09e8fdf`, tree
`d5aa7bde9169acc3917ed62defc9752cf3802779`: **116 passed / 1 required failure /
zero skips**, 117 cases / 12 files. Public authenticated begin, committed-response
loss/concurrent retries/restart, actual review200/unverified and review recovery
pass. Required joining remains503. All561 source fingerprints match, with no C
production changes. [Latest result](symposium-acceptance/cb32-current-owner-envelope/result.json)
and [composition proof](symposium-acceptance/cb32-current-owner-envelope/composition.json).
Historical source-specific entries retain their original outcomes; `bd3aa8ab` is
a prior mixed-source checkpoint. Accepted-main `13669901` scoped evidence remains
**7 passed / 4 files**. This PR owns tests/evidence only.

## Source and authority

Accepted remote main was freshly fetched on 17 October 2026:
`189289da78d971497deaa9cc4ca29365ba9c6e56`. This happened to equal the historical
review snapshot; it was selected from remote main, not assumed from the handover.
Accepted main then advanced to `fea33e215b0d1bcf29604aa13e793329588a2980`
(PR #1006); it was fetched and combined without replacing earlier evidence.
[Refreshed owner result](symposium-acceptance/accepted-fea33e21/result.json) and
[output](symposium-acceptance/accepted-fea33e21/output.log) record **106 passing
checks across 12 files**, 15.84 seconds, against local combined source
`0a6155a66e4d5fe83d2f8c813db9378d0541ea8a`. This includes the new migration and
no-listener transport checks.

C branch: `test/symposium-integration-acceptance`. No production files or shared
CI configuration are owned or edited here. New harness source is not merged.

Canonical records were independently inspected using SQLite `mode=ro`, without
constructing the write-capable artifact owner. The milestone has 16 criteria.
Latest artifact bytes, stored size and SHA-256 agree with core's exports:

| Record                                           | Revision | SHA-256                                                            |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| Plan `dad6534e91551b3e375a57307df729a1`          | 12       | `8f3a3411aa93816ffb54f3545595e64e2ede7a7bb9222bc6f5bc312e556e6b67` |
| Acceptance `4c8cef1b18a2e14db03b301fdef01c4c`    | 2        | `459c32e9c2ad66fd33c71706c0816da66c90467041ff787b75637236657a217c` |
| Mock approval `d2b5bce4090c39a595457335763271b5` | 1        | `cf87dbd06bff52b788cbb2dbfff13ad15e889a36d89e7958568764781e31c1ea` |

The approval retains fresh agents and reviewed full/selected context. Existing-chat
import is deferred; fork is separate. No new plan or milestone tree was created.

## Ownership and exact candidate boundaries

| Owner                                   | Agreed files/contracts                                                                                                                        | Current source and evidence classification                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core — Continue Symposium after #1000   | Native capture/count/consume; application construction/auth/join/recovery/delivery/reply wiring; ledger/call sites; canonical plan/checkpoint | Foundation draft [PR #1012](https://github.com/dimakis/mitzo/pull/1012), reported head `5e81b9a1`; joining branch `fix/symposium-approved-joining-ui`, reported `2c1255bb`. Neither is accepted main. Exact later receipts must supersede these checkpoints.                                                                                   |
| A — Implement Symposium UI Workstream   | Shared transcript adapter, stable recipient controls, focused UI behavior/captures                                                            | Reported `a8e7550e` plus uncommitted source preview fix; schema-derived fixture only. Actual route draft responder persistence remains a core integration gap.                                                                                                                                                                                 |
| B — Implement Symposium Workstream      | Exact forwarding selection, retained-version adapter and artifact fixture                                                                     | Host forwarding reported 15 passing tests; source-dependent transcript references explicitly distinguished from independent saved bytes. Canonical synthetic artifact backup comes from actual MGMT TodoStore initialization, then TelosArtifactStore initialization; no invented items columns. Exact saved-version delivery remains pending. |
| C — Build Symposium Integration Harness | New scoped fixtures/tests, runner, this single map and independent defect reports                                                             | This branch; uses accepted actual owners. No second dispatcher, native algorithm, scheduler, account catalog or artifact engine.                                                                                                                                                                                                               |

Core accepted the two concrete defects/dependencies reported by C: missing reply
reader deliveries, and unsafe application import/teardown. Core is implementing the
production fixes. Its teardown audit also found terminal maintenance on import and
notification flush/badge work that must settle before closing SQLite. C must verify their exact combined revision before updating status.

## Commands and retained results

Run from the repository root after installing lockfile dependencies. The scoped
runner always selects one worker, disables file parallelism and sets a 1 GiB Node
heap. It records HEAD/tree, tracked-diff hash, untracked source hashes, versions,
command, output hash and exit status. A failing required run returns nonzero.

```sh
node scripts/run-symposium-acceptance.mjs --evidence-dir /tmp/symposium-scoped
node scripts/run-symposium-acceptance.mjs --owners --evidence-dir /tmp/symposium-owners
node scripts/run-symposium-acceptance.mjs --required --evidence-dir /tmp/symposium-required
```

`--owners` reuses the eight named existing owner/client/protocol suites in
`vitest.symposium-acceptance.config.ts`. On this Mac their supertest listeners need
approved outside-sandbox execution. They create disposable in-process HTTP sockets,
not a normal server or deployed stack. New `requestApplication` dispatch needs no
listener. The normal repository suite discovers the new `.test.ts` checks. Required
`.repro.ts` cases are an explicit working-branch gate and stay red until dependencies
land. Excluding them from a scoped green run is not milestone acceptance; do not
merge a permanently failing required suite or mark a skipped/blocked case accepted.

| Evidence                                                                                                                                                             | Observed result                                         | Meaning and limits                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Baseline owner result](symposium-acceptance/baseline-owners-outside-sandbox/result.json), [output](symposium-acceptance/baseline-owners-outside-sandbox/output.log) | 104 passed / 10 files, exit 0, 19.79 s                  | Includes 5 new checks and 99 reused checks. Actual store/workspace/restart/client/owner behavior; not complete app composition.                       |
| [Sandbox attempt](symposium-acceptance/baseline-owners/result.json), [output](symposium-acceptance/baseline-owners/output.log)                                       | 92 passed, 7 failed, 7 unhandled errors                 | Loopback `listen EPERM`; environment failure, not an accepted router result or a product defect. Preserved rather than erased.                        |
| [Required baseline](symposium-acceptance/baseline-required-no-skips/result.json), [output](symposium-acceptance/baseline-required-no-skips/output.log)               | Required regressions fail; exact counts in receipt      | Reader reply has no authorized readers. Actual-app prerequisite blocks before import while safe seam is absent. No required case is counted accepted. |
| Source-alias TypeScript and focused ESLint                                                                                                                           | Passed on initial new fixture/policy/coexistence source | Final changed-file validation is recorded with the final run below. Broad application builds remain CI work.                                          |

Local dependencies are borrowed through task-local symlinks; observed Node
`v24.10.0` and Vitest `4.1.11` are in receipts. CI must install the repository lockfile;
local results do not claim lockfile-install CI. Counts overlap and must not be added.
The initial fixture red phase failed on its missing helper module; implementing the
actual-owner fixture made the scoped checks green. The no-listener transport also
started with a missing-helper red and now exercises real Express JSON/cookie handling.

## Requirement-to-evidence map

Numbers match the canonical milestone criteria. “Partial” means only the stated
bounded behavior was observed, never completion of the full criterion. Visual,
native/live and application evidence remain distinct.

| Criterion                                                                                                  | Contract owner                               | Exact source / command evidence                                                                                                                                                                                                                                                                                          | Current state and open gap                                                                                                                                                                                                                                                                                                                                                                             | Visual evidence                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Existing chat → Add agent → edit/refreeze → silent join → explicit prompt → attributed finalized answer | Core + A + C                                 | Exact core `cb32e03f` + C `713fb30e`; `--required --artifacts`; [current app/owner result](symposium-acceptance/cb32-current-owner-envelope/result.json)                                                                                                                                                                 | REQUIRED RED at actual joins503. Authenticated public begin, unchanged revision1 source receipt through response loss/concurrent retries/restart, real HTTP READY unused target and review200/unverified pass; no session/command allocation. Selected API/OpenShell native capacity/dispatch and full Add agent journey remain open.                                                                  | Final combined application captures pending.                                                                                                                                                        |
| 2. Membership change re-review links the same allocation                                                   | Core                                         | Candidate backend `7e184d0407429f0de95c055dbf82b838a75f62f0`; 54 owner tests reported by core                                                                                                                                                                                                                            | OWNER-REPORTED. Accepted-main baseline owner cases do not prove the candidate fix or actual app reconciliation.                                                                                                                                                                                                                                                                                        | Recovery comparison pending.                                                                                                                                                                        |
| 3. Lost review/confirmation survives close/remount/reload/restart with original operation                  | Core                                         | Exact core `cb32e03f` + C `713fb30e`; [current app/owner result](symposium-acceptance/cb32-current-owner-envelope/result.json); existing core allocation recovery remains separate                                                                                                                                       | PARTIAL GREEN: dropped committed HTTP begin response, concurrent exact retries and same-cookie/root restart recover one immutable source receipt. Source/policy and review restart preserve identity/snapshot/settings/workspace. Allocation/confirmation loss, dialog remount/reload and different-login lifecycle remain open.                                                                       | UI fixture hard reload remains separate from allocated-agent recovery.                                                                                                                              |
| 4. Approved Add agent copy/order/repository, Before joining and drafts                                     | Core                                         | Candidate UI `6fdcc3df`, repository checkpoints `9d9d8bb9` + `3b29e179`; exact combined head not accepted                                                                                                                                                                                                                | PENDING combined-source independent comparison; no design change authorized here.                                                                                                                                                                                                                                                                                                                      | Compare canonical HTML/PNG, not regenerated references.                                                                                                                                             |
| 5. Approved-design ledger and combined light/dark/mobile/desktop/focus/refusal checks                      | Core ledger + A captures + C inspection      | A `d127103b` / pushed `2ae799a` seven corrected renders plus A `153fbe4` four policy-confirmation recovery renders; [corrected-render receipt](symposium-acceptance/ui-correction-independent/inspection.json); [policy-recovery receipt](symposium-acceptance/ui-policy-recovery-independent/inspection.json)           | PARTIAL visual: eleven exact committed images inspected. Corrected320/390 counts, partial outcomes, pending/refusal footer and saved-policy/failed-confirmation feedback observed. Final combined app UX/ledger, interaction matrix and physical iOS remain open.                                                                                                                                      | Both receipts retain exact image hashes; static inspection does not prove focus, request counts or recovery completion.                                                                             |
| 6. Readers retain authorized prompts AND replies before next explicit turn; no read-triggered inference    | Core + C                                     | Exact core `cb32e03f` + C `713fb30e`; unchanged reader-reply reproduction through the actual ordinary recording driver                                                                                                                                                                                                   | PARTIAL GREEN on exact core candidate: authorized prompts and finalized replies precede the next explicit turn; reading alone does not invoke a model. Accepted-main reader support and full routed application delivery remain separate open gates.                                                                                                                                                   | No full-app UX claim from owner composition.                                                                                                                                                        |
| 7. Defaults/@ stable recipients, same-account isolation, partial failures, ordinary Stop                   | Existing policy/delivery/reply owners + A/C  | Exact core `cb32e03f` + C `713fb30e`; [current app/owner result](symposium-acceptance/cb32-current-owner-envelope/result.json); retained independent UI receipts below                                                                                                                                                   | PARTIAL GREEN. Real ordinary driver/context/tool isolation and independent failure persistence observed. Full UI-to-command fanout, Stop, uncertain replay and routed reader-answer journey remain open.                                                                                                                                                                                               | Header/partial-outcome/policy pending/refusal/confirmation-recovery renders independently inspected; remaining Defaults/@, Stop/replay and full routed interactions are not independently accepted. |
| 8. Native exact retained request, per-sampling permit, tool loop, ACK and Stop uncertainty                 | Core native                                  | PR #1012 candidate; reported 15-patch tree `cf8cc168`, 123 focused passed / 3137 filtered; later candidates separate                                                                                                                                                                                                     | OWNER-REPORTED only. C does not reproduce native algorithms in JS or run a concurrent native build. Installed/runtime qualification absent.                                                                                                                                                                                                                                                            | Not a visual criterion.                                                                                                                                                                             |
| 9. Canonical evidence/checkpoint and normal CI/review gates                                                | Core + C                                     | This map, exact core/C receipts and guarded scoped milestone notes; PR1022                                                                                                                                                                                                                                               | IN PROGRESS. Prior C head9e73f81f CI jobs succeeded; observed Centaur LGTM targets older9f69920e and is stale for newer source. New publication needs its own CI/trusted review. No milestone/parent closure or merge acceptance.                                                                                                                                                                      | Combined UX gate open.                                                                                                                                                                              |
| 10. Shared client/server identity/errors; exact native request and invalidation                            | Shared protocol/client/router/native         | `--owners` actual schemas/client round-trip and separate hand-wired HTTP owner tests                                                                                                                                                                                                                                     | PARTIAL GREEN at owner boundary. Native count/dispatch equality, per-sampling invalidation and actual-app error/recovery composition remain pending.                                                                                                                                                                                                                                                   | UI error projections alone cannot close it.                                                                                                                                                         |
| 11. Canonical schemas/migrations, rollback/concurrency/crash/recovery                                      | EventStore/workspace/recovery + C/B fixtures | Actual EventStore/workspace migrations plus reused core private forwarding storage and existing recovery owners on cb32e03f                                                                                                                                                                                              | PARTIAL GREEN. Owner-created older backup migration/restart/rollback and exact private-forward retention/confirmation/transaction-fence cases pass. No invented schema or capability. Actual app allocation/crash matrix remains open.                                                                                                                                                                 | Reload UI has separate evidence.                                                                                                                                                                    |
| 12. Actual production app construction/auth/session/router/preparation/dispatch/reply                      | Core production seam + C                     | Exact core `cb32e03f` + C `713fb30e`; [current app/owner result](symposium-acceptance/cb32-current-owner-envelope/result.json); actual app/chat/auth/typed begin/workspace owners                                                                                                                                        | PARTIAL actual-app evidence: login200/anonymous401, cross-origin begin403, public begin200 with dropped committed response, concurrent typed retries and restart return the same source receipt. Real preview/prepare/review200-unverified, typed retry and review restart pass. Required joins503; no allocation/inference. Full dispatch/reply and selected API/OpenShell qualification remain open. | No actual application screen capture; eleven inspected UI renders remain separate client/hook/component fixture evidence.                                                                           |
| 13. Multi-agent defaults, attribution, readers, failure, Stop/no replay                                    | Existing owners + C                          | New policies/coexistence + existing ordinary-delivery/replies suites                                                                                                                                                                                                                                                     | PARTIAL GREEN for stable targets, actual finalized source verification, one recipient failure preserving successful receipt, cross-session command refusal. Candidate reader reply is green; complete routed lifecycle remains pending.                                                                                                                                                                | Partial fixture behavior only.                                                                                                                                                                      |
| 14. Exact approved UI, retained edits/focus/refusal/stale/uncertainty                                      | A + core + C                                 | Eleven exact committed A renders: seven corrected images at `d127103b` / pushed `2ae799a`, four recovery images at `153fbe4`; [corrected-render receipt](symposium-acceptance/ui-correction-independent/inspection.json); [policy-recovery receipt](symposium-acceptance/ui-policy-recovery-independent/inspection.json) | PARTIAL visual: visible-count defect repaired; partial outcomes, in-dialog pending/refusal and saved-policy/failed-confirmation feedback, prior checkbox render and reachable footer observed. Focus, GET-only recovery/request counts, final combined Add agent/join/refreeze UX and physical iOS remain independently open.                                                                          | Frozen approved HTML unchanged; both receipts pin original bytes. No replacement reference images or full UX approval.                                                                              |
| 15. Bounded Telos/Symposium coexistence without role/context/tool/command leakage                          | Shared ordinary owners + C                   | `symposium-acceptance-coexistence.test.ts`; actual accepted owners `189289da`                                                                                                                                                                                                                                            | PARTIAL GREEN. Same account, separate sessions/roles/tools, real CodexConversation transport, original role binding across restart and wrong-task refusal. This is internal-owner integration, not whole-app acceptance or a new combined feature.                                                                                                                                                     | None required for this bounded backend slice.                                                                                                                                                       |
| 16. One living map, source/test/visual gaps, later sequential qualification                                | C map / core checkpoint                      | This file, portable runner receipts, coordinated A/B/core ownership                                                                                                                                                                                                                                                      | MAP ESTABLISHED; combined milestone remains open. Source merged, offline integration, approved UX, live runtime and deployed are separate states.                                                                                                                                                                                                                                                      | Final visual evidence pending.                                                                                                                                                                      |

Artifact journey (additional workstream handover requirement): selected saved version
must reach the intended recipient unchanged, with access and retained provenance,
including later edits/source unavailability. B owns canonical saved-byte fixture and
adapter; C will consume its exact committed interface. Transcript references and
host-only forwarding packets are not independent retention or actual agent delivery.
No saved-artifact delivery is independently accepted by this report.

## Actual-app construction prerequisites

The app is a module singleton, despite historical CLAUDE factory wording. Direct
import currently loads a host internal token and merges global MCP configurations.
The fixture must not import it with production credentials/configuration. Core agreed
to an absolute `MITZO_INTERNAL_TOKEN_PATH` selected before module import and an
application-owned resource teardown. C supplies synthetic REPO_PATH, private paths,
empty account inventory, explicit offline environment, synchronous task log and an
empty external MCP catalog; HOME/CODEX_HOME are not changed. Actual interactive
login, cookies, internal token implementation, app/chat/EventStore/router stay real.

Requested teardown includes registry disposal, notification callbacks/store, tasks,
agent library and app-owned profile/context/access/proposal/grant/review SQLite
handles. Core owns this production seam. Guard failure is BLOCKED, not a successful
application test. Once available, actual source review/join/send mounts must execute
with recording external account/count/RPC ports; absent wiring fails the required run.
No normal server, configured runtime or provider is started by this work.

## Future qualification matrix — prepared only

Generate rows from the actual selected account inventory at the time of separately
authorized qualification. Do not infer accounts from fixtures, UI labels or one
representative provider. Do not read production credentials to populate this plan.

| Dimension            | Required rows / retained evidence                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account              | Every configured account ID and immutable profile revision, inventory timestamp/hash; billing account explicitly identified before calls.                                                                                                                 |
| Runtime              | Mac host and OpenShell for each account. Unsupported tuples stay open.                                                                                                                                                                                    |
| Client/device        | Desktop browser, mobile browser and physical iPhone/Capacitor over each runtime; record OS/build/viewport. Browser WebKit simulation does not qualify physical iOS. Watch remains separate.                                                               |
| Model                | Explicit supported Luna ID for target account; never inherit session model. If unavailable, no call until explicit alternate-model approval.                                                                                                              |
| Target/authorization | One feasible separately authorized target, sequential cells; target identity/config/runtime revision and permission record. No per-feature stacks.                                                                                                        |
| Journeys             | Ordinary start, fresh full/selected/brief-only join, repeated Default/@ prompts, same-account independent agents, exact artifacts, queued settings, readers before next command, partial failures, Stop/uncertainty/no replay, reconnect and attribution. |
| Receipt              | Source commit/tree, binary/runtime, request/ACK/final-reply/artifact pins, observed result, visual/device evidence, blocked/unsupported reason; no secrets.                                                                                               |

All future cells are NOT RUN. Offline fixtures qualify no live account/runtime/device.
Canonical staging/pipeline remain stood down. No model calls, deployment, activation,
staging operation or recurring automation is authorized or performed here.

## Older accepted-schema fixture

The 11 KiB compressed SQLite backup was generated by the actual EventStore at
accepted `09f1090fd5be8b1167188a178dca2186eb445795` (tree
`54df91831b2f23a236c343e72549d34dbb693bae`), extracted from local Git history.
The portable generator instantiates that owner with one synthetic session/group
and an unverified review, closes it, then compresses its actual database bytes.
No CREATE/ALTER SQL or invented columns are supplied by the fixture. Manifest
`server/__tests__/fixtures/symposium-event-store-09f1090f.json` pins owner source,
compressed/raw hashes, size, group and immutable snapshot identity. The current
owner migrates it and preserves its review/hash, refuses an invalid membership
mutation without partial effects, and reopens it without gaining native authority.
One focused migration test passed after the expected missing-fixture red. Regenerating
this synthetic fixture is maintenance, not a normal test step or reference-image update.

## Independent visual inspection of A's bounded captures

C directly inspected all four images from capture source
`62c89aff166c6133ccc01aa95c8ff7aaa589241d` (A evidence commit `bed075d4`),
and read the original approved HTML at its retained hash `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.
A reports 6 browser cases plus 2 startup dependencies passing, one worker, no
retries. C inspected pixels and test source; C did not independently rerun that
browser job. The scenarios use schema-derived intercepted responses and show no
actual application backend or native device.

| Capture under A's `docs/design/assets/`       | SHA-256                                                            | C observation                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `symposium-shared-desktop-chromium-dark.png`  | `c9ae37c97057880e48e79d3f3fe03b735e0cf7bdeaa10d7f189e402260280b6f` | Retained Architect answer, explicit Reviewer uncertainty/no-resend, Reader pending and composer draft are visible. |
| `symposium-shared-desktop-chromium-light.png` | `5ffec9bf2b9be984e521a8392217f1b7adf29f3381dbe0977404de17e92f3026` | Light/Georgia appearance remains readable with visible controls and no apparent horizontal clipping.               |
| `symposium-shared-mobile-webkit-dark.png`     | `b44064f84ff3925e0f0234d7be931adbbcf14aac6dde3b44508afb8ef9ca33de` | At 320px, header shows two names plus +2 for three participants; approved narrow header rule is violated.          |
| `symposium-shared-mobile-webkit-light.png`    | `31f625399479f9b2b818e2aaac4d4d75083a6205b8249f4b18ef996cfa237804` | Same narrow-header deviation; retained draft and partial-outcome text are readable.                                |

Concrete defect sent to A and core: approved HTML line651 renders two names with
a separate mobile count, while its <=360px rule (lines509–518) hides all names
except the first and hides the separator. The correct 320px result is therefore
**Architect +2**, while current `ConversationAgents.tsx` joins both names into one
span and displays **Architect · Reviewer +2**. Do not change the reference or
simply alter the count without preserving that approved responsive rule. Core
owns the production component; A owns the focused assertion and refreshed captures.

These images omit the ordinary shell, Add agent and Before joining. They do not
close criteria1/4/5/12/14 or establish final combined approved UX. A source refresh
onto #1006 and core recovery/reader work require their own exact combined evidence.

## Combined candidate verification (not accepted main)

Separate branch `test/symposium-acceptance-artifacts-candidate` combines B's
published `313112667ef475a588b112bb179b70dd7a348df5` (PR #1020, based on accepted
`fea33e21`), C harness commits, and core's actual reader fix `eaa68d32` (original
`63ae43cd`) without editing their production files. Combined commit
`4b257990`, tree `2beb2f702c2d94d6676d0af0da2b1b8c60bfceb7`, plus the runner diff
recorded in the receipt: [result](symposium-acceptance/combined-4b257990/result.json),
[output](symposium-acceptance/combined-4b257990/output.log).

The combined required/candidate run has **10 passed, 1 failed, zero skips** across
7 files. The single failure is the guarded missing application import/teardown
prerequisite; the actual app was not imported. This does not qualify combined
application behavior, source closure pins, native capacity or approved UX.

The original reader regression passed unchanged after core's actual store fix:
reply-to-reader delivery is retained; after EventStore restart, the original
prompt, finalized reply and next explicit prompt reach the existing ordinary
context adapter in order, with exactly one recorded `turn/start`. This verifies
the reported repair on this candidate, while accepted main still fails that case.

The two new cross-owner artifact cases pass through B's canonical owner fixture,
exact retained read/forward handoff and C's real ordinary driver/serializer:

- An explicitly selected older saved revision survives later edits, owner restart
  and an absent original session. Recorded native application-context fragments
  reconstruct the handoff byte-for-byte, with old base64 bytes, revision/hash,
  intended recipient and retained provenance unchanged.
- Revoked artifact access is renewed through the ordinary `prepareTurn` callback
  and prevents `turn/start`. This is a bounded internal-owner composition check;
  C's fixture supplies that callback, and production application dispatch does
  not install it yet. It is not proof of an atomic final-send authority fence.

Run the artifact candidate checks explicitly after B's source is composed:

```sh
node scripts/run-symposium-acceptance.mjs --artifacts --evidence-dir /tmp/symposium-artifact-candidate
```

On accepted main without B's modules this command fails for the missing source
dependency; those cases are not silently skipped or counted accepted. The normal
scoped runner continues to run only available accepted-owner checks. The two
artifact tests first went red on missing handoff context/pre-dispatch callback;
adding only the fixture's existing-driver callback/context inputs made them green.

**Open artifact defect:** B subsequently reproduced a late-await privacy gap on
`31311266`: final target/source authorization may change retained-item privacy
after the last material check. B/core own the synchronous retained-material fence
and save/dispatch transaction integration. B's earlier 145 green cases and C's two
bounded green cases do not close that gap. Re-run the owner late-await regression
and these checks against its exact fix before any integrated-material acceptance.
Standalone retention and actual agent-delivery receipt installation remain pending.

A has published [draft PR #1021](https://github.com/dimakis/mitzo/pull/1021) at reported
`6123caaec7b1fa0b24c41c141647dc9c8a06638b`, preserving the independently reported
narrow-header deviation. Its 195 focused checks, 108 design checks with one existing
skip, and six UI/two startup checks are owner evidence; C's independent pixel/source
inspection above remains a bounded finding, not final UX approval.

## Latest artifact repair verification and scoped checkpoint

B published the privacy/custody repair as
`8c12cf9fb820eb5f48d75e175ff839f69432e4d7` (PR #1020, tree
`cc2c849d8f18e3715ade5c1769da39edeb85dc21`). C composed that exact commit without
production edits, yielding candidate `69dbb57c89eea799323b9a5b475bf898bea2e053`,
tree `6b994eb97c7aa757caa345d9b0a7407d55be5861`, plus the recorded runner-only diff.

- [Combined result](symposium-acceptance/combined-artifact-repair/result.json) and
  [output](symposium-acceptance/combined-artifact-repair/output.log): 10 passed,
  1 blocked application prerequisite, zero skips. The original reader case and
  both cross-owner saved-version cases remain green.
- [Actual owner revalidation](symposium-acceptance/combined-artifact-repair/owner-result.json)
  and [output](symposium-acceptance/combined-artifact-repair/owner-output.log):
  **36 passed / 2 files**, 1.71 seconds, including the four late-await
  source/target × privacy/corrupt-custody regressions. C reused B's owner tests.
- Source-focused TypeScript including the artifact candidate test passed on the
  combined candidate. This does not verify mixed-source closure pins or a real
  application final-send transaction fence.

The reported late-await defect is verified repaired within that bounded private
handoff/reader boundary. The new synchronous retained-material assertion is not
an atomic authorization grant; actual application admission/transaction integration,
standalone retention, native capacity and durable delivery remain open.

C's [draft PR #1022](https://github.com/dimakis/mitzo/pull/1022) was published with
GitHub-verified signed commit `1979befa3509ed584b98acfca27c42a24f9acd59`, tree
`72d65c812a35509c2f91cc37278c6d738f3d38e9`, matching the locally inspected tree.
Its normal CI was observed queued; no current-head CI or Centaur approval is claimed.
The local encrypted signing key was not changed. Subsequent evidence commits retain
all earlier receipts and tests; this map is the sole active acceptance map.

The canonical [scoped progress receipt](symposium-acceptance/scoped-progress-receipt.json)
records request `symposium-acceptance-c-1979befa-20261017`, appended through
TelosItemStore with a fresh revision compare-and-swap. The milestone remains active;
summary, all 16 criteria and children were checked unchanged. No shared plan/artifact
revision, parent status or new task hierarchy was written.

A's newer draft head is `d0a8d23b1ae2c60012cd480c57a743f7b4a69eac`; its selected
unavailable-recipient removal regression is owner-reported green. Original four
capture bytes and C's responsive-header finding remain unchanged. Await the core
fix and final combined capture evidence before any UX acceptance.

## Safe actual-application import and real HTTP follow-through

Core supplied exact safe-seam commits `0112ee1453db9361b15383414bd7baa1cfcfeeff`,
`a4bc9d7720e61ef43c11a8616b623a58e3c52887`, and
`9080eff0f8e307d28aa8477d7bc18f70006fb61f` (core tree
`aa9bfe269e2bd8dc06d97709139fd8f59735a6ff`). C composed those immutable owner
commits without production edits onto the prior B/core/C candidate, yielding
`de9974bfa6b4f226847e27afc13832e083354809`, tree
`0af2cdb4cb0bb2c011e9392d573d5fd9e63e3e42`, plus fixture/runner diffs in each receipt.

The harness now uses the exact `closeIdleApplicationResources():Promise<void>`
contract. A failed release or interrupted import retains its root/logs and
synthetic environment/network fences; it does not delete files under possibly
open resources or restore host configuration to unfinished callbacks. Successful
release is followed by an actual503 admission-fence assertion. This is idle
resource release, not a general shutdown or a mechanism to drain active work.

Ordinary driver fixture imports are deferred until the synthetic environment is
installed, including the logger. The memory-only transport has deterministic
loopback peer metadata (its req.ip regression went red then green). For actual
application acceptance, the harness now uses supertest over one disposable
**127.0.0.1** listener with real HTTP response completion, cookie/IP/rate-limit
semantics, bounded request deadlines and listener cleanup. No index.ts, normal
server bootstrap, provider or deployed target is started. Run `--required` outside
Seatbelt on this Mac once that safe source is composed, as for `--owners`.

[Initial semantic-transport run](symposium-acceptance/safe-app-de9974bf/result.json)
and [output](symposium-acceptance/safe-app-de9974bf/output.log) are retained. Its
manual response-finish transport does not qualify socket completion/abort behavior;
the performance middleware reports those synthetic finishes as aborted. The real
HTTP run supersedes that limitation for this bounded request sequence:
[result](symposium-acceptance/real-http-safe-app/result.json),
[output](symposium-acceptance/real-http-safe-app/output.log). Both runs retain the
missing source/review wiring as a failure, not as a passing refusal acceptance.

Observed through the **actual app.ts/chat.ts, real internal-token implementation,
interactive login/cookie/auth middleware, EventStore and typed shared client**:

1. Synthetic operator login returns200 and the real authentication cookie.
2. An unauthenticated conversation read returns401.
3. The authenticated typed client reads the actual existing conversation (200).
4. A valid typed source-review selection reaches the actual app route and returns
   **503 execution_unavailable**, failing the unchanged required expectation200.
5. Idle release completes; later HTTP admission returns503 before closed stores
   can be used. The loopback listener and root are removed only after safe release.

The full combined run remains **10 passed / 1 failed / zero skips**. The failure
has advanced from a pre-import dependency block to the real missing application
source/review owner. It has not turned green. Join, explicit send, finalized
attribution, actual routed reload/restart and full Telos coexistence remain open.
C requested the exact new public review/settings shape and external account/RPC
fixture hooks from core; it will not substitute the independent fixture workspace
for actual application admission or invent an unsupported native capability.

The corrective review at `session-audit/review-2026-10-17.txt` was read in full.
Its distinction between local repaired reader behavior and accepted main is
preserved. Header conformance remains with A/core; corrected breakpoint/column
captures will be independently inspected before updating the UX evidence.

### Same authenticated source/policy restart

The actual-application fixture now closes only idle owners/listener, resets the
module graph, and reopens the **same** synthetic root. It retains the original
cookie and credential file rather than logging in again, writing replacement
accounts or fabricating a session. After real policy mutation through the typed
client, it verifies exact conversation/policy replay, the same authenticated JWT
identity, unchanged internal-token bytes, unchanged ordinary command identity and
unchanged session count across that restart. The restart fixture's missing-helper
red was repaired before rerunning the required journey.

[Restart run](symposium-acceptance/real-http-restart/result.json) and
[output](symposium-acceptance/real-http-restart/output.log) retain **10 passed /
1 failed / zero skips**. All restart assertions and final idle-release/admission
fence pass; the full journey still fails at the actual503 review route. This is
pre-join source/policy restart evidence, not allocation-success/lost-confirmation
recovery or complete joining-to-reply acceptance. Those cases await the core
production review/join/send contracts and actual workspace/account/RPC fixtures.
No production files, approval references or required success assertions were changed.

The [final restart run](symposium-acceptance/real-http-restart-final/result.json)
([output](symposium-acceptance/real-http-restart-final/output.log)) additionally
pins an empty offline model-limit catalog under the synthetic root, so clearing
inherited opt-ins cannot enable catalog network fallback. It again reaches the
real review503 after all auth/policy/restart assertions and safe teardown. Final
source-focused TypeScript and ESLint pass. The scoped accepted-owner subset remains
7 passing cases; it does not include the red full-journey gate.

This is the deliberately unbootstrapped app seam. Production `index.ts` also
installs persistent authentication revocation authority; that bootstrap and logout/
different-login recovery cases are not qualified by this positive same-cookie test.
The test does not replace that owner with a fake or claim complete auth lifecycle.

Review routing remains Symposium core as implementation integration lead and
Review Symposium Telos Design (`01a14bab-6771-79e1-b832-6575ca1d2e6e`) as owning
reviewer. Telos S9 owns Telos-side acceptance/isolation; C's bounded coexistence
checks do not substitute for it. Necessary material event reports follow the
verified human request for sessions to report back; no new merge authority follows.

### Independent corrected UI inspection and current review dependency

C inspected and retained seven unchanged PNGs from A's clean committed source
`d127103bdb9c9de2215d27b643959168b7300813`, tree
`e205b262791b0163b1670baae8a5790380d3f09f`. Each retained image SHA-256 was verified
against that exact Git blob. The [independent receipt](symposium-acceptance/ui-correction-independent/inspection.json)
records image paths/hashes, source status and limitations. The approved HTML hash
remains `175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc`.

The previously reported visible-name/count defect is repaired in these inspected
renders: [320px mobile](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-shared-dark.png)
and [320px desktop conversation container](symposium-acceptance/ui-correction-independent/symposium-corrected-desktop-chromium-header-desktop-column-320-dark.png)
show **Architect +2**; [390px](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-header-390-light.png)
shows **Architect · Reviewer +1**. The retained success remains beside independent
uncertain/pending outcomes. [Pending](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-policy-pending-light.png)
and [refusal/recovery](symposium-acceptance/ui-correction-independent/symposium-corrected-mobile-webkit-policy-refusal-dark.png)
feedback stays inside Agents with the footer visible. These are static independent
inspections of A's real client/projection/presentation-hook/component fixture with
intercepted synthetic transport. They do not establish full application joining UX,
keyboard behavior, policy request counts, native iOS or approved combined acceptance.
No reference image was regenerated; earlier failed renders remain retained.

Core's committed application branch has advanced through observational review
service `d7d523a8`, typed client `e9919669`, route `1b85c635` and synchronous save
assertion repair `a6724a90`. These are source checkpoints, not independently run
combined application acceptance. At inspection the actual app still constructs
`createSessionCollaborationRouter({ store: eventStore })` without that service.
C requested the consumable mount plus a real prepared-unused-workspace fixture
using external Git/account boundaries and safe workspace-singleton teardown.
The future `/reviews` input includes target selectors; settings must come from
its actual owner result, never the source fixture's `f.settings` or workspace.
A successful Local observational review will remain **unverified** with zero
allocation/inference. It cannot qualify the selected API/OpenShell route, make
joining available or replace the required joining-to-finalized-reply gate.

No tests were rerun for this image/record-only addition. Latest independently run
combined integration evidence remains **10 passed / 1 failed / zero skips** at the
real application review503; the scoped subset remains **7 passed**. At the checked
PR1022 head `9f69920e`, CI was in progress and the Centaur job had completed, with
no submitted review or final LGTM found. Draft status and normal review gates remain.

### Actual application review, recovery and omission control — final checkpoint

Accepted main `136699011e63ae154f6a6bb8b7e46225fbb3dd29` was fetched and merged
into C's own branch without production edits. Its [scoped receipt](symposium-acceptance/accepted-13669901-scoped/result.json)
([output](symposium-acceptance/accepted-13669901-scoped/output.log)) records **7 passing
cases / 4 files**. Focused source TypeScript and ESLint pass.

The independent candidate combines core's committed application service/typed
contract/router/mount through `8513bfee`, the actual workspace idle owner
`e6323256` and actual app teardown call `e9816e22`, and current B implementation
through `b60a7869` (including `cdd81165` local-material callback). It is pinned at
`bd3aa8ab444cd9f174fd89c60e407406778ff21e`, tree
`62bf9a3f9d994f2373eeb13dadf98533262b4665`. B forwarding/context source conflicts
were resolved by selecting B's exact committed files; the router insertion retains
the candidate's existing boolean join handler while adding core's exact review
route. Source-closure pins remain B's source-specific pins. This composition is an
offline diagnostic candidate, **not** a qualified source/runtime distribution or
accepted main. Native algorithms are not recreated or newly qualified here.

[Final actual-app result](symposium-acceptance/actual-review-restart-final/result.json)
and [raw output](symposium-acceptance/actual-review-restart-final/output.log):
**61 passed / 1 failed / zero skips**, 62 cases / 9 files, one worker / 1GiB,
9.28 seconds. The remaining failure is the actual typed `prepareJoin` request:
503, fresh-agent preparation and ordinary delivery are not wired.

The passing real-application case now proves:

- Interactive login, anonymous401, authenticated typed view/policy, original token
  identity/internal-token bytes and source/policy retention across app restart.
- Actual HTTP workspace preview/preparation through the real Connections and
  RepositoryWorkspaces owners, yielding a READY unused target distinct from the
  source chat. Only external GitHub acquisition and identity processes are recorded.
- Actual published Agent Library version and live transport/login binding; review
  reads the selected source, omits the synthetic private provider field and returns
  exact server-derived settings with fresh permission revision0.
- `/reviews` returns200 with **unverified** capacity. Legacy flat `/snapshots`
  remains503. Typed review retry returns the exact saved result.
- A second real app close/reopen retains the same cookie/root, original review,
  settings, workspace and internal token. Only the existing interactive transport is
  rebound. No profile/workspace is recreated and no session/command is allocated.
- Idle Connections configuration is explicitly released after HTTP operations;
  actual app teardown closes only idle owners, fences further HTTP with503, closes
  the listener and removes the synthetic root only after successful release.

This uses a synthetic Local observation account and inert runtime metadata bytes,
which are never executed. It does not qualify the selected OpenAI API/OpenShell
route, count authority, native admission, live model, allocation confirmation,
full different-login lifecycle or finalized application reply.

The [omission-control result](symposium-acceptance/actual-review-missing-mount-control/result.json)
([output](symposium-acceptance/actual-review-missing-mount-control/output.log)) removes
**only** the actual app review factory from the same candidate. It records
**60 passed / 2 failed / zero skips**, failing review503 against required200 plus
the dependent joining prerequisite. The exact production app bytes were restored
and verified against the committed candidate afterward. This is a deliberate
mutation control, not accepted-main behavior or a successful refusal acceptance.

Earlier fixture diagnostics remain preserved: [first preview409](symposium-acceptance/actual-review-mounted-first/result.json),
[call-through diagnosis](symposium-acceptance/actual-review-preview-diagnostic/result.json)
and [private-profile correction](symposium-acceptance/actual-review-private-profile/result.json).
The synthetic account file initially inherited0644 from the empty profile setup;
the real preparation custody owner correctly refused it. C corrected initial
creation to0600 and removed the temporary diagnostic call-through observation.
No production admission was relaxed and no real credential was read.

`--artifacts` now also reuses B's original forwarding and retained-source owner
suites. The earlier [55-case scoped run](symposium-acceptance/final-artifact-custody-scoped/result.json)
is pinned to B `f9409978`; the final62-case combined run additionally includes
original final-await transcript removal/edit, post-prepare custody/privacy and
Promise/value-returning callback refusals through `b60a7869`. Counts overlap.
The independent retained-byte recording handoffs remain green, but durable
application forwarding prepare/confirm/read and recipient delivery are still open.
No new browser, model, native runtime, staging, deployment or merge was performed.

### Independent saved-policy / failed-confirmation visual follow-up

A's final recovery source `6bfbe8d5` is published at
`153fbe4da624c070da3e2d07494087f59f1eb23b`, tree
`6a1f59a89e6b8df8d6e4667c4cec75afe3cef8a8`. C independently inspected all four
new mobile WebKit / desktop Chromium light/dark renders and retained exact Git
blob bytes with hashes in the [recovery inspection receipt](symposium-acceptance/ui-policy-recovery-independent/inspection.json).
Saved-state explanation, confirmation-read error and Refresh sharing are visible
inside Agents; the prior unchecked Reads value and dimmed controls remain rendered,
and the footer is visible. The successful desktop transcript reply is preserved.
These screenshots do not independently prove GET-only retries, disabled DOM/focus,
request counts or completed recovery. A reports those unit/browser behaviors;
C did not launch another browser run or qualify final application mounting/UX.
Earlier seven corrected captures and frozen approval references remain unchanged.

### Exact core source: authenticated begin and private forwarding refusal

Core [PR1023](https://github.com/dimakis/mitzo/pull/1023) source
`cb32e03fda3babb9fe14fd3e486175e5b881f4d6`, tree
`9a33fd7693392147f5871ac4dff8ed49fc127d66`, was consumed directly into a separate C
branch in the existing isolated worktree. Previous `bd3aa8ab` and its branch/evidence
remain preserved. C's clean test overlay is
`713fb30e9e5b499c2466bd821b4c9b41f09e8fdf`, tree
`d5aa7bde9169acc3917ed62defc9752cf3802779`. The [composition receipt](symposium-acceptance/cb32-current-owner-envelope/composition.json)
verifies all product files remain byte-identical to core; only C tests/evidence are
added. No manual production conflict resolution or ad hoc runtime pin choice is
part of this new candidate.

The [final result](symposium-acceptance/cb32-current-owner-envelope/result.json)
([output](symposium-acceptance/cb32-current-owner-envelope/output.log)) records
**116 passed / 1 failed / zero skips**, 117 cases / 12 files, 10.08 seconds,
one worker and1GiB. These counts include the previous bounded cases and core's
existing private-forward storage, normalized selector and ordinary-delivery refusal
suites; they must not be added to earlier totals. Required joining still returns503
through the actual typed client. The linked-agent and finalized-reply success
assertions remain unchanged.

The actual-app fixture now seeds only the synthetic pre-existing chat and source
message through their canonical owners. It no longer calls private
`collaborationConversation.begin`. It instead verifies anonymous begin401,
cross-origin begin403 and no enrollment, then calls the actual typed HTTP begin.
The transport discards the first successful response **after the actual server
commits**, causing a real client-visible failure. Two concurrent exact retries and
another retry after reopening the same root/cookie return the original revision1,
single-source receipt. Session IDs and ordinary command identity do not change.
Existing source/policy restart, real workspace preparation, selected-source review,
typed exact retry, review restart and idle cleanup/admission-fence checks still pass.
This is source-relationship recovery, not allocated-agent confirmation recovery.

The [begin-route omission control](symposium-acceptance/cb32-begin-missing-control/result.json)
([output](symposium-acceptance/cb32-begin-missing-control/output.log)) removes only
`POST /:id/begin` from the actual router. It records **60 passed / 2 failed** in the
62-case envelope, failing at404 against required cross-origin403, plus the dependent
journey prerequisite. The [review-factory omission control](symposium-acceptance/cb32-review-missing-control/result.json)
([output](symposium-acceptance/cb32-review-missing-control/output.log)) preserves
public begin but removes only the actual app review factory; it records
**60 passed / 2 failed** at review503 against required200 and its dependent gate.
Both product files were restored and verified against exact core bytes. These are
explicit negative controls, not successful feature acceptance or main behavior.

The [initial diagnostic](symposium-acceptance/cb32-begin-review-initial/result.json)
records C's mistaken undefined expectation for an absent collaboration. The actual
owner contract returnsnull; the fixture now assertsnull without changing production.
The subsequent [62-case app recovery run](symposium-acceptance/cb32-begin-review-recovery/result.json)
records61pass/1joining failure before the owner envelope was expanded. Its receipt
retains the exact tracked-diff hash for that one assertion change; the later clean
117-case overlay is the current checkpoint. No failed record was overwritten.

[Source-manifest verification](symposium-acceptance/cb32-source-pins/result.json)
imports core's actual TypeScript manifest and fingerprint function and independently
verifies **561 source pins / zero mismatches**, with zero product changes. The normal
compiled checker first refused because this isolated checkout has no `dist` module;
no broad build was attempted. Source checking used tsx outside Seatbelt after its
local IPC pipe was refused inside the sandbox. This is source-hash evidence only,
not compiled distribution, installed runtime, native admission or live qualification.
Focused current-source TypeScript and ESLint pass.

Private forwarding retention/confirmation and the explicit refusal of note-only
ordinary delivery are now independently reused owner evidence. There is still no
public forwarding prepare/confirm/read route, complete selected-content delivery or
native send permit. Full Add agent/join/reply, allocated-agent crash/confirmation and
different-login lifecycle, selected API/OpenShell counting/admission/dispatch,
actual combined-source rendered UX and physical iOS remain open. The eleven earlier
static UI inspections keep their exact A source/hash bounds; no new render, approval
reference, model call, runtime adoption, staging, deployment or merge is claimed.
