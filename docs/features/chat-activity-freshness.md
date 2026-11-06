# Chat activity and freshness

Approved by Dimitri in the originating conversation on 6 November 2026. The
retained [mock](../design/approved/chat-activity/activity-freshness.html) is a
reference for activity additions, not replacement navigation, message bubbles,
settings or composer controls. The product has no new reduced-motion toggle.
The existing system preference remains part of shared motion behavior.

Library rows, filters, search results, device pins, previews and the conversation
sidebar share activity labels, animated bars and explicit timing. Open chat uses
the already approved single status row above the existing composer. Errors,
approvals, queue actions and recovery retain precedence over ordinary activity.
SessionActions still owns conversation/Today pinning, rename, copying the session
ID, details and deletion. Touch, context-menu and keyboard behavior is retained.

## Clocks and order

Normalized live block starts, tool results and message ends supply content-free
activity phases. The overview retains neither tool arguments nor reasoning/text
for this feature. Token deltas do not broadcast or advance freshness. Provider
admission establishes turn start; visible messages establish message freshness;
turn completion and observed wait transitions have their own times. An unknown
start has no elapsed counter. Stored modification time is labelled **Updated**
when a message timestamp is unavailable. Exact dates are available on timestamps.

Messages, completion and explicit attention requests move conversations in bounded
batches. Tool-only changes update status without reordering. Pointer/touch,
scrolling, keyboard interaction, search and action dialogs retain list positions;
the library exposes **updated · show latest** for queued moves. Device pins keep
their saved order and search retains its result order. With no live projection,
saved HTTP freshness reconciles the list after reconnect/refresh. Last-known
disconnected activity is display-only, stops animated bars and cannot override
fresh HTTP state or establish an actionable approval. Authentication loss clears it.
Permission lifecycle changes request a coalesced refresh even without provider output.

One shared subscriber clock updates rendered time labels every second and stops
when no timestamp is mounted. It performs no polling and never changes list order.

## Validation

Local validation passed 415 tests across 27 focused files (one existing CI-only
check skipped), changed-source ESLint, formatting, design guards and the protocol
TypeScript build, with one test worker and a 1 GiB heap. Focused tests cover
event/owner fencing, distinct clocks, no token-driven freshness,
coalesced ordering and held updates, retained action menus, the mounted composer
row, issue precedence, disconnected presentation and preserved design contracts.
The offline session-library fixture covers mobile WebKit/Chromium and desktop
Chromium, both themes, alternate accents/fonts, active bars, elapsed labels,
assistant-message freshness, pointer-held updates and the actual composer with a
retained draft and status details. Its source bundles successfully with esbuild.

Browser execution is **unverified**: the explicitly approved host command still
inherited the macOS Seatbelt marker, and the repository guard refused before
launch. No browser was launched and no rendered screenshot was inspected. CI must
run the offline fixture, the existing chat-settings/chat-status contracts and
full build/type checks. Staging is stood down. This work does not deploy or restart
production, and a draft PR is not acceptance or deployment.

Shared tokens supply colors, font roles, spacing, radii, control height and status
animation duration. The 2px bars/gaps are indicator geometry. Existing ledger
revisions and protected checks are retained byte-for-byte; this approval is a new
surface with separate evidence.
