# Coordinated chat removal

An idle provider can still own a runtime. **Stop and review deletion** fences new
commands in the event database, cancels this conversation's scheduled prompts and
submitted queued messages, settles the original delivery owners, and closes its
runtime without asking a model to perform closeout. Reviewing the dialog alone
does none of this. The subsequent Delete action requires the same retained removal
operation and a fresh sandbox cleanup token where applicable.

The chat remains visible on failed or uncertain cleanup. The event database keeps
the removal fence across controller restarts. Concurrent preparation joins one
operation, completed deletion returns its original receipt, and a changed account,
workspace or runtime cannot silently replace the reviewed resources. New admissions
and dispatch claims check the durable fence, including timers and peer prompts.

**Keep chat** explicitly releases the admission fence before resource release has
started. It does not revive cancelled timers or resend messages. After release has
started, an uncertain operation must be reconciled under its original identity;
neither Keep nor Archive can dismiss that uncertainty. Expired/revoked operator
authority aborts remote cleanup and is rechecked at local preservation boundaries.
The dialog clears on authentication changes and bounds preparation, including
response-body consumption, without automatic mutation retries.

OpenShell deletion retains the existing exact physical ownership, checkpoint
verification, stop and deletion checks. Closing an idle runtime removes the former
registry blocker; it does not remove any ownership or recovery requirement. Task
Board, Symposium, external custody and unsettled native tool effects still protect
resources. Active turns can be interrupted by their original runtime but may leave
uncertainty that requires keeping and reconciling the chat.

Local Mac deletion uses the existing preservation owner for an independently owned
repository checkout. Its verified archive and original inode tree are retained.
Linked Git worktrees, ordinary nonrepository directories and older workspaces stay
at their current location; the dialog explicitly reviews this retained disposition.
Changing workspace custody invalidates the removal review. Stopping their runtime
releases its provider process and timers, but this feature makes no disk-reclamation
claim for retained local files or archives.

The larger resource-cleanup audit remains open: linked-worktree archive/unlink
custody, reference-aware checkpoint/archive expiry, byte budgets, physical resource
reconciliation and measured daily-use storage stability require further work.
This change does not choose a new data-retention policy or purge old directories.

## Verification and UI evidence

The dialog reuses HomeDialog, home-inline-actions and semantic secondary/danger
controls. It introduces no styles, palette, type scale or motion owner. Focus,
scrolling and authentication lifetime remain with the existing dialog.

Offline regressions cover persistent fences, timer cancellation/settlement and
restart, simultaneous preparation, exact release receipts, authorization loss,
retained local custody, retirement integration, body deadlines and explicit
prepare/keep/delete UI actions. The intercepted sandbox-removal browser fixture
covers 320px mobile WebKit/Chromium and desktop Chromium, dark Mint/System and light
Teal/Georgia, preparation, failure, archive, wrapping and focus restoration.

Shared-package TypeScript compilation and 108 design checks pass locally (one
existing design skip). Local Playwright stopped at its sandbox guard before
launching browsers, including through the approved execution request. Rendered
browser results, screenshots, the full application build and final source review
remain CI/review acceptance; no local visual inspection or live cleanup is claimed.
No model calls, staging operation, production activation or actual resource
deletion were performed while implementing these fixtures.

## Failed-stop recovery — 11 November 2026

The deletion dialog previously cleared its review after a failed stop, hiding
Keep chat even though the durable removal fence still paused the conversation.
It now reads the original removal after a failed or unconfirmed preparation,
keeps known actions visible, and disables mutations until that read succeeds.
The read never repeats the stop. Keep chat uses the original operation ID;
failed deletion still requires an explicit fresh review before another attempt.
Review failures retain the last known details with disabled controls. Persisted
removal errors also remain visible after reopening the dialog.

Native deletion checks distinguish workspace mismatch, pending commands,
unfinished workspace transfer, missing tool result and recovery review. These
checks remain read-only and retain every existing deletion fence. Structured
diagnostics record the stage, stable blocker code, chat and removal operation;
failure-recording errors do not replace the primary shutdown or release failure.
This fixes recovery visibility and diagnostics; it does not establish which
native condition blocked the original screenshot or reconcile live chat data.

The change reuses HomeDialog, home-inline-actions and the existing semantic
controls, with no new styling or motion. Focused offline regressions cover the
native store through the runtime/service/HTTP adapter, persisted failure review,
exact Keep chat identity, disabled stale controls and explicit retry. The browser
fixture adds failed-stop recovery before successful preparation on its existing
phone/desktop and appearance variants. The 66 focused regressions and 109 design
checks passed locally, with one existing design skip; touched-file lint passed.
Local browser startup through task execution failed on macOS process registration;
an explicitly escalated native attempt still hit the repository's Seatbelt guard.
No rendered result is claimed. Review, full builds, browser CI and production
activation remain separate.
