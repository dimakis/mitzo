# Ordinary chat continuation across upgrades

An ordinary conversation retains its account binding, execution namespace, native
thread, command receipts and workspace. A compatible deployment must not change
those identities or require a new conversation.

OpenShell target v2 identifies its configured gateway/workspace namespace, CLI
namespace, workdir and supported Codex protocol. Deployment evidence separately
covers installed code, executable measurement, policy, seed, image and other
runtime settings. The entry owner measures the current deployment before admission
and rechecks the same deployment around asynchronous effects.

A legacy OpenShell target contains a deployment fingerprint. It can continue only
when the saved session binding matches original native custody, its retained
physical fingerprint is intact, and its gateway, workspace, CLI environment and
workdir still match the current target. Original login, account, model/permission
selection, workspace, lifecycle ownership and uncertain-command checks still apply.
No session binding, custody record, historical receipt or task checkout is rewritten.
A retained workspace preparation carries its owning conversation/workspace into
requalification so the same native proof is checked there too. A current stable
target needs no legacy bridge, including an initial command retry before native
custody has been persisted.

Local Claude and deferred Gemini targets similarly separate host/protocol identity
from deployment attestation. Stable v2 host/protocol identities must match exactly.
Their continuation catalogs can reconstruct only reviewed v1 declarations from
accepted releases, using the same original host ID, target ID and label. The
reviewed source closures are listed below. Unknown revisions, changed hosts or
unprovable original legacy labels stay blocked; native owners still verify
original credentials, login, history and workspace before effects. Retired
Responses execution remains retired. Existing Host Mac Codex continuity remains
with its native owner and its reviewed compatibility contract.

Refreshing a bound chat rechecks current capabilities while preserving the selected
future model, thinking level, account and agent. It cannot adopt another account.
Failed metadata refresh stays blocked and keeps the previous selection. Catalog
failures direct users to Refresh models instead of asking them to change a locked
account.

## Reviewed local legacy declarations

The v1 target hash includes the full declaration. Reconstruction uses its exact
property order and current server-owned host/target/label with these reviewed
historical contract hashes. A different stable v2 host/protocol hash cannot match
the v1 preimage. The current descriptor must also identify the reviewed v1 session
protocol before any legacy declaration is offered. No arbitrary retained target
revision is accepted. Claude custody,
capability declaration and SDK history protocols are unchanged between the two
older accepted releases and the accepted base.

| Accepted release                           | Sorted source-closure SHA-256                                      | Supported legacy engine |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------------------- |
| `86916da4af1c2e17fdbe9132543afaa3dadec88b` | `860f9c40af4d13bde50cee3df429e4f4b72f5267ec67dd99fd875c32e4473d80` | Claude and Gemini       |
| `c42ce72a2c84e94bac1b14ecba3585789f320264` | `17db03d4e5e03a84bc2d6ac7155122f3add253fe1ac5d9b4923771d8f568d6a6` | Claude                  |
| `263cfea8bb65e48801b88fdd1b45fd3256f1b2ee` | `c4463e7e0a509a3c63be60f01b9780622f7f1adb978e98fabf0f957e505a0915` | Claude                  |

Read-only diagnosis matched both retained local Claude conversation identities to
the two older releases. This observation grants no admission authority; the
compiled reconstruction and native owners qualify every explicit command.

## Verification

Synthetic server regressions cover legacy OpenShell restart and new command
admission for repository and default workspaces, unchanged receipts/native
thread/physical runtime, duplicate-command acknowledgement and rejected authority
drift. The preparation test exercises the actual capture/assert and inventory
composition and rejects a foreign workspace or changed gateway. Local catalog
regressions cover compatible source/label edits, the reviewed legacy declarations,
changed account identity, host/protocol drift and unknown legacy revisions.

The intercepted `chat-upgrade-continuity` browser test renders the real responsive
chat routes, settings and composer. On 320px mobile WebKit/Chromium and desktop
Chromium, dark Mint/System and light Teal/Georgia, it changes the future model,
refreshes capabilities, preserves the draft and captures the exact continuation
request. All six scenarios plus both browser startup checks pass without a live
backend, credentials or models. Existing shared tokens and controls are unchanged;
no layout or approved-design ledger is modified. Inspected captures:
[mobile](../evidence/chat-upgrade-continuity/mobile-dark.png) and
[desktop](../evidence/chat-upgrade-continuity/desktop-light.png).

Full server typechecking and frontend production bundling exceed this Mac's required
1 GiB Node heap limit; those checks require CI. No production mutation, staging
operation or model-backed test is part of this repair's local verification.
