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
from deployment attestation. Their continuation catalogs preserve the original
binding after current account/target compatibility resolves; native owners still
verify original credentials, login, history and workspace before effects. Retired
Responses execution remains retired. Existing Host Mac Codex continuity remains
with its native owner and its reviewed compatibility contract.

Refreshing a bound chat rechecks current capabilities while preserving the selected
future model, thinking level, account and agent. It cannot adopt another account.
Failed metadata refresh stays blocked and keeps the previous selection. Catalog
failures direct users to Refresh models instead of asking them to change a locked
account.

## Verification

Synthetic server regressions cover legacy OpenShell restart and new command
admission for repository and default workspaces, unchanged receipts/native
thread/physical runtime, duplicate-command acknowledgement and rejected authority
drift. The preparation test exercises the actual capture/assert and inventory
composition and rejects a foreign workspace or changed gateway. Local catalog
regressions cover compatible source/label edits and changed account identity.

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
