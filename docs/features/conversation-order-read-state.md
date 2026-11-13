# Conversation ordering and reply read state

Historical PR #1307 record. On 13 November Dimitri requested incorporating and
superseding it in [hidden conversations and calmer ordering](chat-lifecycle-and-ordering.md).
That combined feature uses 1800ms motion and five seconds between promotions,
and addresses the six blocking review findings retained on this draft.

Dimitri requested these changes in the originating conversation on 11 November
2026 after reporting that both the desktop sidebar and regular Chats list jumped
while several sessions ran. He asked for slower, pronounced promotions, one at a
time; finished jobs separated from active jobs; and read state since the latest
reply, with Mark as unread in the existing session actions. He suggested using
the presence-dot position for read state and asked about blue. The chosen UI
uses a blue unread dot, an empty fixed gutter once read, and a stronger unread
title; existing activity labels continue to describe execution.

## Behavior

- Each conversation promotion takes 1100ms using the shared reorder motion role.
  Commits have a 2.5-second scheduling interval, so successive moves do not overlap.
  Repeated activity coalesces by session. Newly discovered conversations use the
  same queue. Tool traffic never establishes message freshness.
- In progress precedes Finished. Completion moves through the queue rather than
  leaving a finished row between running jobs. Group changes drain in arrival
  order before recency promotions, so newer active replies cannot starve a
  pending completion. Sidebar and library use MotionList
  to preserve the visible conversation and avoid remounting its controls.
- Nested scroll events are captured. Hover, active scrolling, a viewport away
  from the top, keyboard focus and action dialogs hold ordering. Show latest
  applies the next update; repeated clicks cannot interrupt an ongoing movement.
  Reduced motion removes movement while preserving ordering and browsing rules.
- Completed visible assistant text establishes a durable reply sequence. Thinking,
  tools, streaming text and saved metadata do not establish unread replies.
  A visible open transcript acknowledges only the reply shown; looking at a
  collection row does not. Another unseen reply remains unread.
- Mark as unread and Mark as read share the existing right-click, long-press and
  overflow actions. Manual unread survives status updates and remains until a
  later visit or explicit read action. Server receipts and SSE updates reconcile
  devices. Revisions fence concurrent changes; read metadata never changes recency.
- Histories with no durable text/reply boundary have no invented reply cursor.
  Existing retained replies with no read receipt start unread. Failed saves keep
  the visible marker and show a retryable error in the owning control.

## Verification

The focused regression run passed 321 tests across 22 files, with one existing
design test skipped. It includes the real EventStore, a database reopen,
revision conflicts, the mounted HTTP list/read-state routes, hidden-session
denial, sanitized database failures, menu save failures, visible/hidden-tab
receipts, serialization, repeated Show latest, new-row bursts and nested scrolls.
Frontend and server TypeScript compilation, the frontend production build,
changed-file ESLint with zero warnings and source-artifact validation passed.

The offline browser fixture covers read/unread actions and failure/retry on both
surfaces, both themes and alternate appearance, alongside the existing gestures,
motion, scrolling, reduced motion, preview and keyboard scenarios. Browser startup
is currently blocked by macOS sandbox process-registration permission; actual
rendered checks and capture inspection remain pending. No live model call,
deployment or merge was performed.

## Current-main integration, 11 November 2026

Integrated accepted main `14fb28b0d03a0d780b663f1ef0697699ec546b88` once after
the coordinator released preparation. The only text conflict was in the source
artifact manifest. Retained both new source inventories, advanced its runtime
revision, and regenerated fingerprints against the combined ChatArea, EventStore
and application code. The upstream live Symposium attribution remains intact;
read receipts still use the completed visible reply and its durable sequence.

The combined candidate passed 75 focused tests across ten files, using one local
worker and a 1 GiB Node heap. Coverage includes upstream responder progress and
the composed application observer journey, as well as read receipts, ordering,
durable storage and the actual HTTP metadata routes. Source-artifact validation
also passed. The PR's merge conflict prevented ordinary pull-request CI from
running; publishing the resolved candidate restored that workflow (run
`43031852101`). A further regression reproduced newer active replies delaying a
finished row's group change; prioritizing queued group changes fixed it. All 24
ordering, motion and legacy-order tests passed after that correction.
Browser assertions and the sandbox guard remain intact. Final CI, browser
captures and exact-head Centaur approval remain outstanding.

Main advanced to `0b8b94f1dd6519f7fcfb5b9eafdb352f03dc475e` during that
integration, landing the next Symposium context change. GitHub reported a fresh
manifest conflict and suppressed CI for the group-priority head. Resolved that
actual conflict, retaining both inventories and regenerating source fingerprints.
The integration passed 65 tests across nine files, including the new upstream
prompt-context and send-recovery coverage alongside read state and ordering.
