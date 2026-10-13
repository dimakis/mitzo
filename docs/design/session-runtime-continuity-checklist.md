# Session runtime continuity completion checklist

This checklist compares accepted PR #917 with the product directions and approved
picker retained as Telos artifact `3985777d901aa39cef7765f75b1277d6`, revision 1.
The approved desktop and mobile references are `a875f7176ab17985a2cf43320c84bbee`
and `022217422c48dabebd27199bc553489c`, revision 1. Configuration and
offline fixtures establish source behavior; live account qualification remains
separate. Staging is stood down.

| Control or behavior      | Source evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent                    | Exact published revision and unavailable revision retention exist. Bound profile stays fixed. Supported source scope is published user guidance without recipes. Built-ins and context recipes require separate enrollment.                                                                                                                                                                                                                                                   |
| Account                  | Selected account survives draft restoration; unavailable choices remain visible. The combined inventory exposes only supported server-owned Local/OpenShell tuples. Local file-backed ChatGPT and OpenShell brokered OAuth/enrolled API profiles retain their exact authentication/billing identity. Their projections are disjoint; changing environment may retain an unavailable account choice. Local API/Vertex remain unavailable. Account stays fixed after admission. |
| Model and Thinking level | Draft choices and invalid options remain visible. Server-supported ordinary Codex conversation scope enables edits for the next unadmitted message. Each guarded send freezes its settings; running/queued commands retain their snapshots. Additional non-Codex routes remain pending.                                                                                                                                                                                       |
| Run on                   | OpenShell remains the new-chat default; Local requires an explicit choice. Server location reasons are displayed. Supported ordinary OpenShell shares the explicit binding admission and continuation flow. Its unselected default target resolves from the first trusted inventory; refresh preserves previously selected stale/invalid intent. No fallback is permitted.                                                                                                    |
| Agent software           | Runs with is derived from the exact configured route or bound harness. Do not introduce a runtime selector or infer software from account labels.                                                                                                                                                                                                                                                                                                                             |
| Session details          | Existing metadata hydration and workspace controls remain. The new-session-elsewhere action retains account/profile/model/thinking intent in a separate blank draft and requires independent repository preparation. Complete original profile/account/runtime/target/workspace/branch details.                                                                                                                                                                               |
| Follow-up and queue      | First-command restrictions remain for unsupported metadata scopes. Supported ordinary Codex conversation scope uses guarded follow-up and direct native queue admission with durable snapshots, exact acknowledgements and retained manual retries.                                                                                                                                                                                                                           |
| Stop and permissions     | Source ownership checks retain Stop, approval responses and same-login controls; unsupported mode/context/web helpers remain blocked. Offline owner tests cover foreign-login refusal and retained driver cancellation.                                                                                                                                                                                                                                                       |
| Reconnect                | Metadata failures block sends with Retry. Preserve the exact binding, attachment owner and frozen HTTP recovery request. Offline attachment/outbox tests cover reconnect without a second dispatch.                                                                                                                                                                                                                                                                           |
| Cold resume              | Source/offline Local and OpenShell cold continuation reacquire the original login, persistent revocation owner, route, physical custody, provider history and workspace. Missing/changed custody stays read-only with a reason. File-backed authentication/token refresh still refuses the strict retained lease; no automatic credential renewal is qualified.                                                                                                               |
| Drafts                   | Retain text, attachments, settings, invalid intent and original recovery links across navigation and refresh; never rebuild a frozen request from edited draft settings.                                                                                                                                                                                                                                                                                                      |
| Responsive picker        | Reuse existing shared picker/workspace controls and tokens. Hosted offline fixtures must inspect 390 × 844 scrolling, larger text, mobile/desktop, light/dark, alternate accents/fonts, focus, keyboard and Reduce Motion.                                                                                                                                                                                                                                                    |

## Implemented source API boundaries

The server exposes explicit supported continuation scope and availability
reason in session metadata; a Local location alone must not imply either support
or permanent first-command restriction. Metadata retains the immutable binding
and distinguishes the last admitted command from editable future model/thinking
intent. Route capabilities must describe supported models, thinking and derived
software for the bound account/target.

Subsequent sends carry a session reference, command ID, exact settings snapshot and
route-native capability revision under server validation. Admission freezes those values before
queue/provider effects; exact retry returns its original receipt. Session account,
profile, runtime, target and workspace cannot be replaced by future settings.
The existing durable browser outbox validates both first and continuation commands
for Local and OpenShell, retaining the complete frozen request across reload and
lost acknowledgements. Recovery requires an explicit retry; it does not replay
automatically or reconstruct a command from the current draft.
Supported cold resume reuses existing provider and workspace owners and native
conversation custody fields. It requires persistent login revocation authority.
Local login source/home and executable identity changes refuse continuation;
OpenShell retains its original account, gateway/runtime and checkout identity.

## Validation status

The audit read repository design/motion contracts, approved mock source and phone
viewport reference. Focused offline regressions cover server-reason display, derived software,
server-supported Local/OpenShell continuation, independent new-session intent, immutable future settings and retained exact
acknowledgements. First-command-only regressions remain for unsupported scopes.
The hosted browser fixture adds future-thinking and queued-follow-up snapshots;
rendered evidence is pending hosted CI. Focused local verification uses one worker with a 1 GiB heap; broad
builds and rendered offline browser evidence belong in hosted CI. No local backend,
browser, model test, staging dispatch or production activation is authorized by
this checklist.

The initial PR #922 source snapshot passed 646 affected offline tests, server and
frontend source type checks, affected lint, commit hooks and secret scanning.
The development fixture used real temporary Git, esbuild and node:test, with
native transport and publication simulated. Resume availability now checks for a
running native command with a bounded query; it does not hydrate completed
prompt/image history during metadata refresh. The regression deliberately makes
completed payloads unreadable and verifies running/completed and binding checks.
Fresh current-head hosted checks and Centaur/MGMT source acceptance remain
required. No live account, tool or publication qualification is claimed here.
