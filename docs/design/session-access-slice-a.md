# Ordinary session Access — first correction slice

Outcome `4f55b423d0731750`, source-audit milestone `cbc784ecd482c3f9`.
Initial audited accepted main: `0b81f65f0312bfe08434d4e624f3713817fa3503` (12 October 2026).
Canonical Telos outcome and eight children retrieved from the operator's canonical store.
Pinned revision-1 plan, workflow and two follow-up reviews were retrieved and SHA256-verified.

## Reconciliation and scope

Accepted main already includes explicit finalized transcript output references and contributor
support (PR837), plus PR839/841/842 cleanup. `SessionOutputReferences`,
`session-output-routes.ts` and protocol event-store registration bind exact session/message/block
identity and hash; these are source-dependent references, not independent retention.
This slice preserves them. It adds no persistence, review, account admission, contributor routing,
worker dispatch or release programme. The target/capability inventory, contributor parity and
review composition have separate owners; their unaccepted work cannot establish current availability.

Open PRs inspected: #798 backup setup, #568 worktree recovery, #540 Codex background state,
#445/#440 transport changes and older task/provider work. None supplies accepted session Access.
Do not adopt their proposed transport/runtime semantics. Older inspected checkouts and mockups
are references only. The subsequent merge is authorized separately; deployment remains excluded.

## Capability/evidence matrix

The first delivery supported an ordinary Claude SDK session with a live registry owner and
exact matching durable session ID, behind the existing operator authentication boundary.
Empty ordinary chat remains supported before a session, output or Telos item exists.

| Fact                                    | Authority                                                                                   | Projection and limitation                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Selected account/model before send      | ChatView/DesktopChatView account selection                                                  | Selected, not admitted; no session has started                                                                                |
| Live account/model                      | ManagedSession.accountBinding and model                                                     | Live binding; model preference/catalog is not runtime evidence                                                                |
| Configured accounts/services            | Existing `/api/connections-access`, owner-scoped facets                                     | Configuration and historical verification only; read-only in-dialog Connections preserves composer                            |
| Draft/sent context and images           | ChatInput local state, finished user message contextBlocks/images and boot_context metadata | Sources distinguish current draft attachments and historical sent material; these do not prove future provider retention      |
| Session service attachments             | No existing bounded read model for this route                                               | Unknown; never inferred from desired assignments or account selection                                                         |
| Active tool approvals                   | ManagedSession.sessionAllowList                                                             | Session tool allow-list only; skill/workspace/exact-action checks still apply                                                 |
| Pending approvals                       | getPendingRequestsBySession(exact ID)                                                       | Tool, request ID and existing approval scope only; no raw tool input or secrets; view through existing chat approval controls |
| Effective mode                          | effectivePermissionMode(live owner)                                                         | Restrictive pending transitions applied immediately; no authority expansion                                                   |
| Skill ceiling                           | ManagedSession.activeSkillPolicy                                                            | Restriction only, not proof of callable tools                                                                                 |
| Callable tools                          | No complete adapter inventory authority                                                     | Unknown; transcript names are observed capabilities, not Sources or available-tool proof                                      |
| Execution limits                        | No complete session read model                                                              | Unknown; existing TokenBar retains its separate runtime token evidence                                                        |
| Missing owner/unsupported route         | No authoritative live observation                                                           | Unknown, not an empty grant/approval assertion                                                                                |
| Disconnected/failed or aged observation | Fetch failure or 30 seconds since observation                                               | Stale with time, refresh and no current approval action; late cross-session results discarded                                 |

Managed connections have desired account assignments and revision-bound capability grants;
OpenShell has owned runtime/provider attachment verification, but exposing that as an ordinary
session availability oracle belongs to the separate inventory/admission owner. Keychain grants
are exact session+connection revision bindings in CredentialConnections; this slice does not
claim its tool allow-list projects those provider grants. Storage identity remains the trusted
operator/session boundary, not the model billing account; no per-seat isolation is claimed.

Telos artifact save still requires item identity, stable retry keys and storage checks;
`userUploadAllowed` excludes LifeOps from shared documents. TelosCreateOutcome remains an
approved mutation with existing intent/criteria/milestone/profile schema. Symposium has its own
admission, configuration generation, context and release authorities. Access does not mutate any
of these or derive ownership from an account/profile label.

## Empty-chat walkthrough and classification contract

1. Open regular chat; choose the usual account/model. No mandatory goal, profile or work form.
2. Type a draft, select context and attach an image. Open Access beside Workspace controls before send.
3. See selection explicitly labelled as selection, with session availability unknown.
4. Open Connections inside the same read-only dialog; inspect configured accounts/services,
   unavailable source notices and the explicit attachment uncertainty. Back to Access and close.
   The ChatInput remains mounted: text, image/context selections and caret survive.
5. In a supported live session, inspect exact-session pending request scope; View pending approvals
   returns to the existing permission controls. Access itself cannot allow, deny or widen scope.
6. Refresh failure retains stale evidence with timestamp; switching session clears the old projection.

Historical user/assistant/tool-result URLs (including errors) become deduplicated References.
Successful written paths are workspace-dependent References, not implicitly registered outputs.
Tool names form an observed-capability list. Arbitrary result images are not generated outputs.
Explicit output references continue in their existing reading surface. No new output is registered
by viewing Access, opening Connections, receiving a result, or mentioning a URL.

## Validation and acceptance boundaries

Test-first red/green covers authority projection, auth/no-store/read-only route, cross-session
rejection, classification, empty-chat return and stale observations. Offline compiled-app fixtures
must inspect rendered phone/desktop, light/dark, alternate accent/font, keyboard and scrolling.
These fixtures make no model calls and start no backend or preview.

The required canonical staging check refused with “custodian check/drain refused or uncertain”.
Its retained ownership is preserved; safe status is unproved and freshness is not established.
Staging recovery belongs to its separate owner. No live provider/model call, deployment or live
acceptance is claimed. Provider enrollment and explicitly selected supported Luna acceptance remain
separate future gates. Production requires a separate explicit user action.

The tray does not report a zero count for registered outputs: it has no output registry observation. Its Outputs disclosure explains the existing conversation location; inferred links/images never contribute an output count.

## Implementation evidence

The red phase failed on missing Access modules and the prior Sources/Outputs classification.
Core projection/component/classification tests then passed (26 checks); the header action and
unsupported zero-output count corrections each had failing tests before implementation.
Rendered checks caught the approval banner covering a composer Access action; Access now uses
the shared always-visible Workspace action slot. Nine focused browser checks pass across mobile
WebKit/Chromium and desktop Chromium. They select an account/model before starting any session,
preserve a text draft plus image through Connections/return, exercise keyboard disclosure and
Escape/focus restoration, navigate a request-scoped approval, show unavailable/stale states,
and preserve historical References without inferred outputs.

Shared tokens, HomeDialog, WorkspaceControls, UiIcon and Connections grouped facts/rows are reused.
Screenshots cover 320px phones and 1280px desktop, light/dark, Teal/Georgia and Lavender/System.
The new heading slot uses token spacing; no palette, typography or motion constants were added.

Inspected captures: [desktop Access](assets/session-access-desktop-dark.png),
[mobile Connections with Teal/Georgia](assets/session-access-connections-mobile-light.png),
[stale observation](assets/session-access-stale-desktop.png), and
[mobile References](assets/session-access-references-mobile.png).
Related mock-only regressions: 13 files / 120 checks pass, including composer ownership
and existing exact-output/contributor tests. Shared design guards: 106 checks pass.
Frontend build and server compile pass. Full offline UI and hosted CI are tracked separately.

Hosted CI exposed the existing full `app.ts` composition source pin. The pin and
read-only `session-access.ts` inventory entry are updated under runtime implementation
revision v1.0.58, with a failing inventory test before the update. This is source-review
coverage for the new read route; capability executors, admission logic, provider policy
and approval semantics are untouched. Full handler-source tests and guarded server build
verify every other recorded digest remains unchanged.

A hosted WebKit regression after briefing account selection exposed an expanded
Workspace overlay covering the launch action. A 20px-root-text fixture reproduced
it locally. WorkspaceControls now measures the space before the existing launch
actions/composer and scrolls settings within that boundary; long summary text is
clamped while its accessible name retains the full details. Twelve focused browser
checks (Access, References and larger-text briefing return) pass across all three
targets. The [inspected larger-text capture](assets/session-access-workspace-large-text.png)
shows both Workspace settings and Send launch prompt reachable. Motion, layout and
design guards pass. This changes layout only, not account selection or admission.

Accepted runtime-selection metadata from PR859 is documented in
`docs/design/session-runtime-selection.md` and persisted through
`packages/protocol/src/session-runtime-binding.ts` / `server/ordinary-session-runtime.ts`.
It records immutable target identity for continuation; it does not establish callable
tools, attachment freshness or new route readiness. This slice preserves that contract
and does not activate or duplicate the separate inventory/admission owner's picker.

## Accepted-main reconciliation during validation

Main advanced to `80681392e0a378ee711fc59306548fc1e809aa40` while this PR's
checks ran. PR863's contributor-account characterization and PR864's review route/host
extraction were merged into this branch. Their implementation and test files are
preserved unchanged from accepted main. The only conflict was the shared source-pin
map: it now contains both owners' entries and the combined app digest, under runtime
implementation revision v1.0.59. The new failing digest assertion preceded this update.
Relative to this accepted main, the app delta remains the read-only Access import/mount;
no contributor parity or review composition was duplicated. The pre-reconciliation head
`819ca378416c6821994496e20f7bbeee6ce79aa3` passed all hosted implementation jobs
(13,459 tests, browser/layout and native builds); the reconciled head requires its own
CI and exact-head review. Source acceptance and deployment/live acceptance remain separate.

Main advanced again to `310a9a71` (PR867, draft image preview/drawing) before the
user-authorized merge. The documentation conflict retains both Access and image
editor contracts; the shared dialog and tray changes remain as accepted. The affected
Access/dialog/tray/composer/resource and design tests pass together (146 checks).
Rendered offline UI is rechecked because the accepted changes touch shared modal
and draft-image behavior. This reconciliation adds no Access or persistence scope.

At the gated merge attempt main advanced to `b66c3516` (PR862, the separately
owned dormant trusted local Codex capability projection). Its account-profile
projection, immutable capability revision, discovery source/stale evidence and
strict snapshot loader remain as accepted; the Access projection continues to
support the single ordinary Anthropic route in this slice. Configured local
Codex target evidence does not establish session attachments or execution grants.
The source-pin map merges cleanly and retains both implementations; its combined
runtime revision is v1.0.60, avoiding reuse of the two branches' different v1.0.59
contracts. No frontend code changed in this reconciliation, so the completed
261-check rendered UI run remains applicable; hosted CI and exact-head review
are required again.

## Codex continuation for Luna-compatible ordinary accounts

This read-only increment begins from accepted main `a8c294da4fe4df47de0c76acf5eec4455f941c7a`.
It consumes existing ordinary Codex execution ownership; it does not activate the dormant
local target catalog, picker or first-command admission. Model choice remains the existing
account's supported catalog and validation, including Luna when that account permits it.

| Fact                                | Codex authority                                                                                 | Projection boundary                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime owner                       | Exact registry session and its `getCodexRuntime` instance                                       | Initialized thread only; lost/closed transport, recovery, pending thread ownership and Symposium owners yield Unknown                                |
| Account                             | Native verified binding inside the runtime                                                      | Account ID/provider/profile revision must match the exact managed session; no credential/email/workspace/profile payload is exposed                  |
| Model                               | Verified thread/start or resume response; subsequently acknowledged turn/start selection        | Last acknowledged selection is separate from an unaccepted or queued future model; it is not a fresh provider authorization probe or billing receipt |
| Execution location                  | The owning `openCodexChat` client-launcher branch                                               | Local/OpenShell provenance does not establish per-seat isolation; search policy/configured targets supply no fallback                                |
| Mode, approvals, host ceiling       | Restrictive effective mode, session allow-list, active host policy, exact-session pending queue | Mitzo host scope only; native Codex permissions remain Unknown and restricted native skill ceilings remain unsupported                               |
| Services, full tool surface, limits | No complete session read authority in this slice                                                | Unknown; configured Connections and observed transcript tool names do not establish availability                                                     |

Observation reads invoke no provider RPC, discover/sign-in call, queue admission, reattachment,
thread creation, grant mutation, capture or publication. Returned metadata is copied. Missing
live proof cannot be filled from durable selection or cached account capability metadata.
The shared Access dialog retains composer state and uses the Connections facts/components.
Pending approvals return to their existing controls; there is no new approval action.

Test-first evidence: the initial observation/projection contracts failed (5 cases), then passed.
The UI label contract and empty-host-ceiling case failed before their corrections. Launcher
provenance separately failed when location was inferred from search policy. Focused mocked
lifecycle/source checks passed (205 before the final provenance tightening, then 12 focused
checks); UI/design checks passed (112). The initial guarded source build passed under v1.0.67;
final broad build and compiled-app renders run in hosted CI under current host pressure.
CI retains the Access/Connections captures for actual mobile/desktop visual inspection.

The canonical staging check still refuses with uncertain custodian check/drain. Resource
observation reports memory pressure and refuses host admission. No live model call or test
charge occurred. This implementation supports observing existing Codex sessions; live Luna
acceptance still requires a qualified canonical staging account/route, an explicitly supported
Luna selection, and naming the exact model and charged account before the call. The observed main-merge hold expires at 2026-10-12 14:38:39 UTC; the
resource-aware source gate remains required; deployment/live acceptance is
separate from implementation and reviewed source acceptance. Later retention/release slices
remain gated.

### Accepted parity integration

Accepted main `ae8da69ec314f4759c13ed5ba3784b1a159119d0` includes PR879's
web updates, effective session approvals and retained provider-environment
continuation. The Codex observation route retains that implementation. Shared
remembered approvals still describe the Mitzo host scope, with native policy and
complete available-tool inventory unknown. Parity's ordinary output-workflow panel removal remains
accepted; historical References remain in the conversation. Only generated
source fingerprints conflicted during integration; the combined runtime uses
v1.0.70 instead of either branch's earlier revision. Fresh combined CI, rendered
Access/Connections evidence and exact-head Centaur review are required before
source acceptance. Deployment and live Luna acceptance remain separate.

### Reviewed environment refresh correction

Centaur finding CEN-D3F87C1146BA identified retained recovery progress after
PR879's successful automatic transport refresh. Two red tests reproduced it for
pre-turn grants and queued environment continuations: both acknowledged resumed
turns remained recovering, suppressing the Access observation. Automatic refresh
now ends its progress after completed or refused reattachment and notifies the queue
observer, without acknowledging user recovery or changing provider-turn ownership.
Existing interruption, failed refresh, admission, continuation and private-ledger
fences remain in force. A third red test verifies refusal retains paused/Unknown state, starts no provider turn and stops progress so existing recovery controls remain usable. The combined reviewed runtime advances to v1.0.72.
