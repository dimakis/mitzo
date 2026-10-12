# Ordinary session Access — first correction slice

Outcome `4f55b423d0731750`, source-audit milestone `cbc784ecd482c3f9`.
Audited accepted main: `0b81f65f0312bfe08434d4e624f3713817fa3503` (12 October 2026).
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
are references only. No main merge or deployment is included.

## Capability/evidence matrix

Initial supported live route: an ordinary Claude SDK session with a live registry owner and
exact matching durable session ID, behind the existing operator authentication boundary.
Empty ordinary chat remains supported before a session, output or Telos item exists.

| Fact                                    | Authority                                               | Projection and limitation                                                                                                     |
| --------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Selected account/model before send      | ChatView/DesktopChatView account selection              | Selected, not admitted; no session has started                                                                                |
| Live account/model                      | ManagedSession.accountBinding and model                 | Live binding; model preference/catalog is not runtime evidence                                                                |
| Configured accounts/services            | Existing `/api/connections-access`, owner-scoped facets | Configuration and historical verification only; read-only in-dialog Connections preserves composer                            |
| Session service attachments             | No existing bounded read model for this route           | Unknown; never inferred from desired assignments or account selection                                                         |
| Active tool approvals                   | ManagedSession.sessionAllowList                         | Session tool allow-list only; skill/workspace/exact-action checks still apply                                                 |
| Pending approvals                       | getPendingRequestsBySession(exact ID)                   | Tool, request ID and existing approval scope only; no raw tool input or secrets; view through existing chat approval controls |
| Effective mode                          | effectivePermissionMode(live owner)                     | Restrictive pending transitions applied immediately; no authority expansion                                                   |
| Skill ceiling                           | ManagedSession.activeSkillPolicy                        | Restriction only, not proof of callable tools                                                                                 |
| Callable tools                          | No complete adapter inventory authority                 | Unknown; transcript names are observed capabilities, not Sources or available-tool proof                                      |
| Execution limits                        | No complete session read model                          | Unknown; existing TokenBar retains its separate runtime token evidence                                                        |
| Missing owner/unsupported route         | No authoritative live observation                       | Unknown, not an empty grant/approval assertion                                                                                |
| Disconnected/failed or aged observation | Fetch failure or 30 seconds since observation           | Stale with time, refresh and no current approval action; late cross-session results discarded                                 |

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
2. Type a draft, select context and attach an image. Open Access from the composer before send.
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
