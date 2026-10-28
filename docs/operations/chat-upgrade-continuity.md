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

## Retained Local Mac Codex commands

An explicit retry can recover an ordinary Local Mac Codex command retained during
bootstrap, before native enqueue, or after durable enqueue without a provider
dispatch. Recovery keeps its original command ID, fingerprint, payload, inference
settings, account, context and checkout. Current operator authority, physical
workspace custody, credentials, capabilities and all queued model selections are
qualified again. A manual conversation title is display metadata and does not
change this identity.

This recovery applies to an existing native conversation with retained thread and
host custody. It does not reopen an initial bootstrap failure that never
established that custody.

The existing **Reconnect and continue** queue action selects the saved server input
even after acceptance has retired its browser outbox. It requires the current signed
connection and original conversation operator. Workspace adoption publishes updated
session metadata so a mounted composer refreshes its workspace identity before
accepting another send.

Recovery refuses running, interrupted, completed or previously attempted inputs,
pending native dispatch/ownership, other uncertain commands and identity drift.
A failed native row is eligible only with a durable positive proof, written by
the current runtime, that preparation failed before a turn-start RPC was attempted.
Legacy failed rows without that proof remain ambiguous; missing history alone
does not authorize replay.
It never resets a receipt to reserved or retries a provider mutation. Read-only
receipt observation still cannot start work. The existing explicit command route
reopens only a proved undispatched command, commits acceptance, and then releases
the owned native FIFO. The first enqueue does not attempt recovery before its
coordinator commits. A provider tool refresh retains its predecessor until the
first replacement turn ACK; recovery inspects the last actually dispatched
thread rather than asking an empty replacement for nonexistent history.

Offline regressions model both bootstrap failure boundaries, accepted paused
queues, manual renaming and dirty task files using real SQLite, admission owners
and native conversation queues with synthetic RPC responses. They assert exactly
one native turn start per accepted input, later independent turns, metadata refresh
after workspace adoption, and repeated chat switches. They reject ambiguous
execution or changed identities. The production consumer is exercised with an
intercepted provider launch as well as the smaller admission fixtures. No
production records, task checkouts or credentials are used by those tests.

### Recovery boundary checks

| Boundary                                       | Required behavior                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Browser HTTP wait and acceptance observation   | Receipt observation stays read-only; acceptance may retire only the matching outbox command.                                       |
| Bootstrap before native enqueue                | Explicit exact retry reuses the retained receipt and current owner, without allocating another chat or checkout.                   |
| Native enqueue before coordinator consumption  | Provider dispatch waits for the original command to become consumed.                                                               |
| Accepted queue after outbox retirement         | Signed **Reconnect and continue** uses the saved server input and the same startup exclusion as exact Retry.                       |
| Workspace handoff with earlier queued steering | Immutable original admission is joined to the adopted workspace by its canonical execution revision.                               |
| Mounted composer and navigation                | Adoption refreshes workspace metadata; delayed replies from the previous workspace/chat cannot restore stale identity.             |
| Provider thread replacement                    | Preserve predecessor custody until the first replacement ACK; inspect the last dispatched generation during recovery.              |
| Preparation failure versus possible dispatch   | Only a positive pre-dispatch witness allows failed-input recovery; attempted RPCs, pending ownership and missing ACKs stay fenced. |
| Subsequent turns                               | Recovery proof applies only to the recovered input; later explicit turns retain independent admission and model snapshots.         |
| Operator/account/context drift                 | Requalify current authority, credentials, selected tools, physical workspace and queued inference settings before release.         |

Historical failures without a positive witness are deliberately retained for
inspection. This change does not infer a safe replay from missing native history,
and it does not claim to identify the inner cause of every historical bootstrap
refusal. New pre-dispatch diagnostics record only a bounded lifecycle stage and
command/conversation identity, without prompts, upstream error text or credentials.

## Cold Local Mac owner and provider thread replacement

After a cold resume into an adopted repository, a changed tool surface can require
an ordinary provider thread replacement. The cold qualification snapshot used to
remain the live thread fence: the legitimate pending replacement then invalidated
its own lease on an early notification, before the ACK could be recorded.

Cold admission still rejects pending dispatch or ownership. Once admission succeeds,
a disposable in-memory owner tracks only its exact admitted command and attempt.
Committed store operations advance its expected pending child, ACK lineage and
ownership completion. Reading plausible database rows cannot grant this authority;
rejection consumes the attempt, and closing the runtime or store disposes it.
Historical interrupted primaries require an accepted native receipt, matching turn
and verified generation lineage; their evidence remains immutable as later turns
advance. Operator, credentials, custody and physical workspace checks still apply.

| Effect                      | Verification and retained boundary                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Immediate continuation   | Early replacement events before ACK preserve the lease; the predecessor remains current until ACK.                                          |
| 2. Ordering and authority   | Only the admitted attempt can advance the expected child; forged ledger changes, stale events and revoked authority fail closed.            |
| 3. Later work               | Independent later commands and another cold tool refresh preserve the adopted checkout and advance to the next generation.                  |
| 4. Restart and interruption | Completed, queued and interrupted prepared primaries are covered; pending uncertainty cannot become restart authority or replay permission. |
| 5. Commit and retained data | The real host-task validator and trusted selected-file commit executor preserve unrelated dirty files and custody after rollover.           |

The consumer tests use real SQLite, public admission, lifecycle bridges and native
queues with intercepted provider RPCs. The commit assertion exercises the validator
and trusted executor directly; it is not a live provider tool-authorization test.
No real models, production credentials or production task files are used.

This prevention fix does not reconcile a previously stranded ambiguous dispatch.
A missing ACK does not prove that execution never started. Existing pending records
remain fenced for explicit evidence-based recovery; they must not be deleted or
silently replayed. Deployment and live verification remain separate operations.

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
