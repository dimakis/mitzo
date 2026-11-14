# Claude conversations across operator devices

## Reproduction and cause

On accepted main `19aa8a19` (14 November 2026), two independently signed logins
for Mitzo's primary operator can establish independent SSE streams. After the
first starts an ordinary Claude conversation, the second client's
`POST /api/chat/switch` returns HTTP 200 but its stream receives
`Owned local session belongs to another login` instead of `session_switched`.
The new integration regression observed that failure for every account row below.
This is a reproduced equivalent of the reported desktop/iOS symptom; the original
incident's exact operation, text and production diagnostic have not been captured.

The owning control boundary compared the second client's login ID to the login
that created the runtime. Ordinary Mitzo has one verified interactive subject
(`user`); login IDs identify authenticated sessions, not distinct operators.
Codex already uses `ordinaryOperatorOwnsConversation` for that distinction.
Claude's admission, historical receipt, queue and cold-resume checks contained
the same narrower comparison. Queue metadata also withheld `canContinue` from
the second login, even after its direct command could be authorized.

The repair reuses that existing operator check only for the supported Claude SDK
engine alongside Codex. Transport IDs still belong to their exact login. The
runtime's retained operator, provider credentials, account binding, native SDK
session, workspace identity, serialized command owner and immutable original
custody remain independently fenced. Opening a client only subscribes; an explicit
command goes through the existing admission and queue. Cold continuation requires
terminal evidence and original SDK history. An in-flight duplicate can still be
refused; clients must reconcile the original command ID rather than invent a retry.

Legitimate control refusals remain visible with `session_operator_denied`, stage
`session_control`, session/connection correlation and a sign-in/reopen instruction.
They use the existing nonfatal control-rejection consumer so denying one client
does not mark the retained runtime stopped or erase its visible activity.

## Account and route matrix

| Configuration                                      | Source support                                                                 | Evidence in this change                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Anthropic Vertex with file-backed ADC              | Ordinary Local Mac `claude-sdk`; configured and environment-derived profiles   | Two real HTTP/SSE clients, synthetic configured account/ADC and canned SDK peer                  |
| Personal Claude subscription configured by profile | Ordinary Local Mac `claude-sdk`                                                | Same journey; synthetic subscription verification                                                |
| Managed personal Claude subscription               | Same engine and target, enrollment-owned profile                               | Same journey using disposable managed account store                                              |
| Anthropic API / qualified Messages endpoint        | Ordinary Local Mac `claude-sdk`; endpoint and Keychain version remain selected | Same journey with synthetic Keychain value/version                                               |
| Legacy Claude SDK conversations                    | Existing unbound attachment/observer behavior                                  | Existing registry, transport and legacy control regressions; no new account/device qualification |
| Codex ordinary Local Mac/OpenShell                 | Existing operator-identity behavior                                            | Existing shared control tests, including cross-login and denial cases                            |

`sessionHarnessForProvider`, `ordinaryLocalVertexInventory` and
`localVertexCapabilities` define these routes. The current source does not qualify
Claude on OpenShell or Bedrock. Vertex profiles carrying sandbox-provider mappings
are excluded from ordinary Local Mac inventory; this repair does not enroll them.
ADC variants share the same session-control boundary; the new fixture is not a
live qualification of service-account, personal login or gateway credentials.

## Verification and limits

`tests/integration/claude-multi-device.test.ts` uses the production application,
authentication, SSE endpoint, connection registry, REST control/admission routes,
runtime/queue owners and protocol parser. Only provider processes, credentials,
history and repository hosting are canned/disposable; no model is called.

Each matrix row exercises active/idle opening, navigation away/back, pending
approval replay through the installed SDK callback and real consumer, a duplicate
approval response, background/foreground lifecycle hints, disconnect cleanup,
fresh transport/login replay, queued input, simultaneous requests with the same
command ID, Stop/Continue, metadata-selected continuation and terminal cold resume.
It asserts no query on open, no account/custody change, one input per command and
original-history continuation. Negative checks cover a second runtime attempting
to resume an active execution, a signed non-primary subject, transport borrowing,
revocation and stale-connection Stop. Shared legacy tests retain unknown-subject
and missing-owner denial, plus current-primary/revoked Claude controls.

Physical desktop+iOS, browser rendering, real login/token-refresh providers and a
full server-process restart were not exercised. Cold owner teardown/recreation and
fresh signed client replay are simulated. Original-owner expiry/revocation and
unsettled provider effects retain their existing fail-closed behavior; a second
device cannot replace that execution authority merely by opening the chat.

Workspace package TypeScript builds, scoped lint/format and source pins pass.
The broad server compiler exceeded the required local 1 GiB heap and is left to
CI. Two existing Codex prepared-repository metadata scenarios returned 409 before
their first provider turn, both on this candidate and an isolated archive of
unchanged `19aa8a19` using the same dependencies. Their local failure is not counted
as a pass; hosted CI must resolve that platform/environment gap before landing.

This draft follows the existing Claude parity stack. It includes accepted lifecycle
PR #1348; it does not claim PR #1356's retained-composer navigation bug explains
this incident. Their narrow overlapping operator checks and shared source pins
need normal integration review after the earlier stack. Required combined CI and
Centaur final LGTM remain mandatory. No merge, staging or production activation is
implied by these offline results.
