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
