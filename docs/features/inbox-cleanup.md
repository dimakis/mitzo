# Inbox cleanup

The Inbox list toolbar exposes **Clean up** next to **Mark updates read**, on both
phone and desktop. It is available even when the selected Needs you view is empty:
cleanup applies to the entire Inbox, including other views.

The shared confirmation dialog explains the operation before **Archive read and
resolved** is pressed. The server archives resolved records and read updates;
pending requests and unread, unresolved updates remain. Nothing is deleted, and archived
items remain recoverable in Archive. The result reports the actual archived count.
A failure retains its explanation and requires closing/reviewing before another
attempt. Authentication loss closes the dialog and suppresses late results.

Approvals and questions archive automatically when allowed, denied or expired.
Reading an unresolved request does not resolve it. Session updates archive when
read individually or marked read in bulk. Archive and the existing History audit
view retain outcomes; delayed delivery is cancelled after archiving. Other source
types keep their separate read and resolution states.

This does not introduce periodic deletion of reports, worktree cleanup, producer
scheduling, or the proposed Home/Work/Inbox/Library navigation redesign. The prior
operator-approved backlog cleanup was a separate live operation.

## UI verification

The implementation reuses `HomeDialog`, `home-inline-actions`, `home-secondary`
and `workspace-text-link`; it adds no palette, font, spacing or motion scale.
The approved navigation and page structure remain in place. Component tests
cover an empty Needs you view, explicit confirmation, cancellation/focus return,
errors and authentication loss. Store regressions cover request resolution,
expiry, acknowledgement and audit/delivery behavior.

`tests/offline/inbox-cleanup.spec.ts` renders the real view in the shared phone
and desktop shells with all HTTP intercepted. It covers dark Mint/System and
light Teal/Georgia with larger text, 320px phones and desktop widths, touch target
height, overflow, failure/recovery, focus and screenshots. The CI Offline layouts
jobs retain successful Inbox captures in their `responsiveness-visuals` artifacts
for inspection; the PR records the current run and visual acceptance results.
This Mac's runtime reports the Seatbelt sandbox and the repository guard stops
before browser launch. Keep that guard intact and use hosted CI for rendered
verification and capture inspection.
