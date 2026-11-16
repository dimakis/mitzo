# Shared composer and default repository repair

## Operator refinement after mock revision 1

Dimitri rejected changes to the existing top Agents actions, a permanent duplicate
roster and text-labelled composer actions. Revision 2 keeps activity, sharing
policies, preview, Details, Chat settings and Add agent in the original Agents
dialog. Inline recipients start collapsed behind @, retaining selected-agent color
marks. Existing lightning, Queue and the Send/Stop slot remain icon-only. Queue
uses explicit shared delivery rather than enabling the ordinary local outbox on
this bounded route. Steer/Queue controls retain their position while typing.

A regression reproduced three scroll-to-bottom writes for three draft keystrokes
with unchanged transcript inputs. Shared transcript composition now memoizes its
actual projection, ordinary history and streaming inputs independently of the
composer draft. Typing produces no scroll write; real streamed content still
follows the reader at the bottom and preserves a reader inspecting older replies.
Recipient focus uses preventScroll. Source identity deduplication and historical
packet suppression remain covered by the existing transcript tests.

The refinement's focused regressions cover 379 passing tests across 32 files,
with one existing skip, including the 27-turn production-composer journey. A final
fixture-assertion follow-up retains its exact repository and AbortSignal checks.
The offline browser fixture now includes long history and checks the reader's
position while typing. Revision 2's in-memory interaction checks cover
collapsed selection, existing icon geometry, Send/Stop swapping, no typing-induced
scroll writes, selected-agent control, the preserved Agents options and simulated
fresh-agent joining. Browser geometry remains unverified under the retained host
process-registration denial; no browser retry was attempted.

The original draft PR is #1374 at `86364844`. Its first CI run exposed compiler
errors in the image type boundary, nullable journal input, ES2022 findLast usage and
test fixtures/query options. This follow-up corrects those reported errors without
weakening runtime validation or changing target libraries. Full compiler and
rendered CI evidence remain required for the updated head.

One implementation in the existing task checkout retains the default-repository
joining work and addresses Dimitri's 16 November shared-chat UX report. No further
agents or model calls were started for implementation or testing.

## Behavior and patterns

- Add agent resolves the configured ordinary primary repository through the
  account/runtime-bound preparation owner. Alternate repository selection remains
  available. Review retries and brief edits retain the same concrete preparation.
- Inline shared toolbar controls select one or multiple recipients while agents
  run. @ focuses the existing input and filters names without opening a popup.
- One Stop control routes to the selected original commands. Steer uses the
  existing exact-command correction endpoint, retaining per-agent outcomes.
- Durable send, Stop and correction journals preserve original request identity;
  disjoint recipient work remains available after an uncertain acknowledgement.
  Restoration observes retained activity and never automatically replays controls.
- Ordinary image paste/previews feed canonical shared messages and native image
  input. Text history contains image fingerprints rather than raw base64 text.
- Existing transcript bubbles integrate the agent name, stable seat accent and
  source-recorded time. Historical messages without time retain unknown time.
- Existing status rail owns actionable feedback. Updating a notice preserves its
  order rather than removing and appending it on every render.

Shared patterns: ChatInput and its draft/attachment owners, ComposerResponders,
ComposerStatus, transcript bubbles, ordinary runtime preparation and native control
owners. Colors, typography, spacing and touch targets use shared tokens and seat
accents. The speaker border and selected-recipient underline use 2px geometry;
the recipient strip scrolls horizontally within a bounded toolbar width.

## Verification and remaining limits

The focused regression set covers 525 passing tests across 37 files, with one
existing skip. A final ledger follow-up rechecked the original approval and design
guards after preserving that baseline as a separate active surface. Coverage
includes approved setup checks, real authenticated application
image delivery and canonical Stop routing, default-repository retry/brief editing,
recipient switching, multi-agent controls and receipt recovery. Protocol, harness
and client TypeScript project builds passed. Changed TypeScript lint passed. The
27-turn production-composer journey passes through remount and history paging.
Stop recovery also covers an unrelated membership addition, while refusing future
revisions, removed targets and forged command identity. Unexpected router and
delivery errors retain their original cause internally and log only sanitized
diagnostics with a correlation identifier.

The offline mobile Chromium fixture was updated for inline recipients. The first
startup found no browser in the executor's temporary home. Selecting the existing
cache for the same installed Chromium revision then reached a macOS process
registration denial (`bootstrap_check_in`, permission denied). No subsequent launch
or alternate binary was attempted. Phone/desktop, theme/accent/font rendering,
scrolling and keyboard geometry remain unverified and require the authorized CI
browser environment. There are no new visual captures.

The full frontend typecheck exceeded the required 1 GiB Node heap; broad build and
type validation remain for CI. No staging, deployment, production runtime changes,
live model tests, publication or merge occurred.

The earlier context inspector remains active in Telos (`05f51bcee39031b1`, UI slice
`5e5b6f6cbc37df2e`). This work keeps the current wheel mounted and labelled with its
actual usage owner; it does not establish that the prior redesign landed.
Local Mac Codex and Claude retain their existing configured account/runtime
qualification. OpenShell shared delivery remains unqualified; this repair does not
establish universal account or engine support.

## Approved revision 3 and composer receipt fix

Dimitri approved `mockups/multi-agent-controls/v003.html` on 16 November and asked
for the sent shared prompt to clear. The appended design-ledger approval preserves
all earlier revisions and references. Source now keeps status and recipients in
the existing above-composer rail, uses the existing Agents view and addressed-read
policy, and opens individual recorded usage from the multicolor context wheel.
Unknown, stale and failed usage remains visible through the ordinary context owner.

Recorded timestamps, Copy, Read aloud and Reply remain in message actions. Forward
is in the same menu for both user and agent messages, including canonical shared
projections. The selected public discussion text is re-read by the host under the
existing actor, membership, recipient and final material fences; this does not read
another participant's private provider history. Reviews retain source author/time
and a navigable exact quote. Source/projection aliases resolve to an existing rich
message when ordinary history owns its rendered identity.

Forwarding stays context-only by default. The unchecked Ask for a reply option
starts a separate ordinary prompt only after confirmed forwarding. That prompt has
its own durable send journal and exact qualified recipients. Forward recovery never
starts or replays it, and an unaccepted follow-up is reported honestly. Stop during
preparation only cancels an overlapping selected audience.

A matching durable prompt receipt is accepted even when native delivery is pending
or uncertain. The composer consumes only that submitted revision while retaining
the original request for recovery; a newer edit survives. A wholly refused audience
still keeps its draft. Tests cover delivered, queued, pending and uncertain receipts,
each with and without a newer ordinary saved draft.

Validation: 139 focused tests passed across 16 files with one worker and the required
1 GiB heap. This includes the real authenticated application forwarding/native-input
consumer, context failure/retry UI, canonical reply capture, projection navigation,
Stop and send durability, optional reply recovery, and typing-scroll regressions.
The shared design suite passed 109 tests with one existing skip. Protocol, harness
and client compilation passed. Changed source lint and formatting were checked.
The earlier worker OOM was isolated to a newly added test recreating its hook callbacks;
the fixture was corrected and the complete focused run then passed within 1 GiB.

The offline browser fixture includes the per-agent popup and recorded usage in both
themes across the configured phone and desktop projects; `--list` succeeds. Actual
browser rendering remains unverified because the retained macOS process-registration
denial was not retried. There are no new screenshots. Full frontend typecheck and
broad builds remain for CI after the previously recorded 1 GiB limit. No staging,
production activation, live model calls, additional review agents or merge occurred.

## Landing repairs — 16 November 2026

The landing session integrated accepted main `57a3df15c875`, preserving both
source sets in the reviewed-artifact registry without duplicate registrations.
Centaur's four blocking findings from review `6b8f7cd834ec` were reproduced
before changing their implementations:

- `CEN-119F4D489AB1`: shared send, observation and original-request Stop now use
  the authenticated large-command parser. Tests exceed the old 10 MiB boundary
  and retain ordinary 401, internal-caller 403 and revoked-session behavior.
- `CEN-B86E386F8CFF`: Stop and Steer include retained earlier message deliveries.
  The production wrapper regression reopens with 51 messages and no local send
  journal, then targets both original commands through the same composer.
- `CEN-668B595C5FCF`: steering fences membership per unresolved target. Removed
  targets retain an unavailable outcome; accepted targets stay accepted and
  other uncertain targets recover with their original request identities.
- `CEN-09874C45287E`: all selected Stop records are durably saved before the first
  network request. Remount recovery preserves both targets and their request IDs.

The four focused files pass 38 tests with one worker and a 1 GiB heap. Design
guards pass 109 tests with one existing skip; replay/application coverage passes
17 tests. Changed-source lint, formatting, shared-package compilation and source
fingerprint validation pass. A missing local native SQLite addon initially
blocked application tests; after preparing the matching existing build in this
isolated clone, both application files pass. Toolchain setup timed out before
reporting readiness; these checks use copied installed dependencies in the task
clone and do not claim a fresh setup receipt. Full combined-head CI and trusted
Centaur follow-up remain required. No new rendered layout or live model test is
claimed, and production activation remains separate.

### Current-head review follow-up

Centaur full review `5921102128` on `95204127` verified all four original fixes
and reported three additional blockers. Regression tests reproduced all three:
recipient changes lost composer acceptance, a removed Stop target stranded later
targets, and quoted reply bytes were charged only after durable acceptance.
Receipt settlement now retains its original callback and draft revision while
fencing login, conversation and mount ownership. Stop handles removed targets
independently. The store's shared canonical quote resolver feeds both preflight
and acceptance, so an overfull reply cannot create an unclaimable pending message.

CI unit job `133339492807` also exposed the forwarding application's obsolete
checkbox selectors. The fixture now selects the same audience with the approved
inline toggle buttons and asserts their pressed states. Its original forwarding,
lost-confirmation recovery, exact content, no-extra-turn and privacy assertions
remain intact and pass locally. The focused six-file suite contains 131 tests;
the receipt-security cases additionally fence login loss, conversation changes
and unmount after recipient changes. Shared-package compilation, changed-source
lint and formatting pass. This is a correction delta for review; fresh combined
CI and trusted current-head verification remain mandatory.

### Revision-3 fixture reconciliation

Centaur follow-up `5921395086` approved production head `b9d32eef` with
recommendation `merge`, zero new/unresolved blockers and three verified fixes.
Its dedicated App status `59032660571` succeeded. CI unit shard 1 then exposed
another obsolete recipient-checkbox assumption in the complete fresh-agent UI
journey. The subsequent bounded scan distinguishes the revision-3 ordinary
composer from the retained protected popover/design surfaces.

The fresh-agent journey now uses inline pressed-state toggles and selected-agent
Stop names, restores the existing Defaults protocol intent through the real draft
owner, and inspects multiple retained controls in the existing status dialog.
Settled commands are checked through their canonical outcomes and journal cleanup;
uncertain requests still require exact retained identities through remount.
The seven synthetic turns, privacy, reply attribution, partial failure, native
interrupt, no-resend and full request-equality assertions remain. Its accepted
receipt is observed before asserting that the unresolved native result survives.

The browser composer fixture uses the same controls, focus behavior and saved
Defaults restoration, and models both original-request Stop and targeted agent
Stop with exact audiences. Its finalized reply carries a completed native outcome.
The three focused application/composer files pass 20 tests; browser discovery lists
20 cases across the selected/imported suites. Browser execution remains for CI.
Production sources are unchanged from the approved `b9d32eef`; only these fixtures,
their registered fingerprints and this evidence change.
