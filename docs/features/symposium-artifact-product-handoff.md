# Symposium saved-artifact handoff

Producer: workstream B, draft PR [#1020](https://github.com/dimakis/mitzo/pull/1020).
Final implementation source `f8b3b289c4f4ab0cbc2ade851a925583fdf97aa2`, tree
`dc892c2aa52c7eb882efee833443012951c08e19`. It includes accepted main
`13669901` (#1010). Artifact UI implementation remains byte-identical to the
rendered UI at `fcefea95ad6837e8bc2dd2bb7f1ca7bf431ec8a0`. The subsequent evidence commit
changes only documentation, captures and focused test assertions.

## Final shared behavior and consumption

B owns `WorkOutputs`, `SavedArtifactDialog`, `SavedArtifactRouteDialog`, the two
saved-artifact client helpers/types and exact history/read methods in the existing
artifact store/router. Core approved that ownership. S7's pending title-link change
is replaced by this combined behavior: one title link opens the exact-version
artifact dialog on the current Work route. Inline provenance retains filename,
revision/hash, date, source/path and honest unknown-author text. Native Download
and Share remain existing separate actions.

The URL fields `savedArtifact`, `savedRevision`, `savedHash` are an exact selector,
not authority. Reload resolves metadata through the current authenticated owner;
wrong owner, changed hash or absent revision refuses without substituting latest.
The dialog's File options → Open uses the existing `artifactViewerUrl` at the
selected revision. Its `from` route includes the exact Work dialog selection.
Files reload and Back retain that selected version. Full editing stays in Files.
S7's explicit saved-document references remain their existing Files links.
Consumers should use B's complete shared component/test changes, not layer S7's
alternate output-title behavior on top. B made no changes in S7's checkout or
`TelosItemWorkspace`.

The existing router now exposes operator-authenticated
`GET /api/telos/artifacts/:id/versions?beforeRevision=N&limit=M` with exact metadata
rows, descending revision order, cursor/hasMore and a maximum of 50. No BLOB is
selected. Source captures and currently ineligible shared items refuse. Existing
preview/download routes revalidate bounded exact metadata/hash/bytes and public
eligibility after any awaited scoped authorization. Original scoped source-capture
interactive reads remain supported; internal/model authority is not expanded.

## Validation and visual comparison

All checks use synthetic databases created from the real canonical TodoStore
backup plus supported artifact initialization. No live account, model, credential,
staging, production or runtime activation is involved. One worker and a 1 GiB Node
heap were used. Normal lint/format/secret/commit hooks remain enabled.

- Backend: 175 tests / 7 files passed, zero skips. Exact retained-only source-null
  forwarding, missing chats, older bytes after later edits, source/private-history
  exclusion, bounds, authority renewal, retries/conflicts, metadata paging, public
  policy changes, same-size BLOB corruption and changed scoped custody are covered.
  CEN-873972402DBA is addressed in source by a required private synchronous
  transcript read renewal after final awaits and before serialization. Four actual
  EventStore red/green cases cover reference removal/content changes during final
  target/source awaits with messages empty. Missing, Promise/value-returning callbacks
  and revoked synchronous source authority refuse. The original source witness is
  never reopened. Core explicitly assigned the shared source/compiler repair;
  dependency commit `5633cf82` copies its exact `a6724a90` source file, then
  `f8b3b289` adds the callback. Final Centaur verification remains pending.
- Components: 25 tests / 3 files passed, zero skips. Exact route selection, old-version
  preview/export, no retargeting, late-response refusal, hash mismatch before preview,
  real Work link and Files return route are covered.
- Design: 108 passed, one pre-existing skipped test / 6 files. No ledger, approval
  reference or protected contract test was changed.
- Browser: six role journeys and two startup checks passed, one worker. Actual
  WorkOutputs, dialog, FileViewer and artifact routes run together with a synthetic
  loopback-only database. Traffic is intercepted and unknown external traffic/write
  requests fail. Mobile WebKit/Chromium at 320px and desktop Chromium at 1280px,
  dark Mint/System and light Teal/Georgia, large text, reduced motion, keyboard
  opener/focus return, old-version choice/reload, Files reload/Back, exact native-share
  File bytes and current access denial are exercised. Native sharing is recorded,
  not physical iOS qualification.
- Focused strict backend/frontend TypeScript checks and the complete reviewed-source
  fingerprint check pass. Broad application builds/`npm run test:ui` remain CI work
  under the repository's local memory constraint; the focused browser command is
  `NODE_OPTIONS=--max-old-space-size=1024 ./node_modules/.bin/playwright test --config playwright.offline.config.ts tests/offline/symposium-artifact-versions.spec.ts --workers=1`.

Captures are implementation evidence, not new design approvals:
[mobile dark](../design/assets/symposium-artifact-mobile-dark.png) and
[desktop light](../design/assets/symposium-artifact-desktop-light.png).
The frozen approved Symposium artifact dialog (existing approval r1, HTML lines
826–831) defines title, saved-version choice, typed preview, Shared with, explicit
saved-version sharing, Work link and collapsed provenance. This implementation
preserves the available structure using HomeDialog, UiIcon, native file actions,
shared motion and semantic tokens. The Work link follows the real retained item.
No author, outcome or delivered recipient is invented. Unsupported preview formats
are explicitly unavailable; physical native and full media walkthroughs remain open.

## Remaining core dependency

The durable forwarding prepare/confirm/read API, actor-bound retry receipts and
recipient outcomes are not implemented by core yet. B's exact host packet and
renewal callback are preparation only; they create no receipt, queue entry, model
call or dispatch authority. No enabled substitute send control is installed.
The approved message-forward and Share saved version dialogs, request-reply option
and per-version Shared with receipts require those real contracts. Core also owns
ordinary input/media eligibility, context admission and dispatch/uncertainty.

C's independently verified earlier combined recording-turn evidence remains in its
single living acceptance map in PR #1022 (map commit `617bf52a`). It does not qualify
this newer UI source or close application, capacity, runtime or mixed-recipient gates.
C should consume this source and rerun the matching actual-owner cases. Core owns
final integration; the Symposium reviewer routes the S7 consumer reconciliation.
No merge, parent closure, accepted UX, live runtime or deployment is claimed here.

## Core contract follow-up, 18 October

Core has selected these existing-owner endpoints for implementation; the types,
receipts and handlers are still pending a committed source handoff. Participant
controls stay unavailable until then. These are proposal details, not implemented
B endpoints:

- `POST /:group/forwards/prepare`: exact B selection plus a bounded note. Middleware
  supplies actor identity; the target group must match the route. Reserve the original
  actor/request fingerprint before async reads. Exact retries recover retained bytes.
- `POST /:group/forwards/:forwardId/confirm`: separate retained confirmation request ID,
  selection fingerprint, packet hash, original membership revision and `requestReply:false`.
  First confirmation atomically creates selected recipients' context-only pending receipts.
- `GET /:group/forwards/:forwardId`: original preparation reference and independent
  recipient outcomes. Read/retry is observational; lost-response retries keep the original
  request/body and cannot upgrade saved content or create another delivery.

Preparation/confirmation performs no allocation, model call or automatic turn/queue.
The next independently admitted explicit command may receive supported text through
ordinary context owners. Unsupported binary/media and `requestReply:true` remain
unavailable. B's strict selection parser does not accept an arbitrary note field;
core owns its envelope, note retention/bounds and combined request fingerprint.

B additionally exposes private `assertLocalMaterialCurrent():void` on the prepared
result. It reuses the held artifact checks synchronously without re-opening sources,
awaiting, changing selected bytes or creating a receipt. Core must combine it with
genuine synchronous target/membership, original source/operator and retained-access
checks inside its existing save transaction. The artifact-only callback is not
complete authorization, including for message-only packets, and grants no dispatch
permit. Two actual-owner red/green tests cover post-preparation transcript-reference
removal and retained-item privacy changes; missing/async/value transcript callbacks
continue to refuse through the earlier regressions.
