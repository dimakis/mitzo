# Persistent native agent chat — implementation draft

Source direction: Dimitri, 13 November 2026, conversation
`03fad929-1c23-86cc-a3b2-354651787b90`, public user event `5596675`, plus the
originating request for a Codex-style persistent floating subagent control.
The user prescribed current-chat styling and draggable full-screen, half-screen
and hidden mobile states. The retained HTML is a proposal illustrating that
direction; it has no separate exact-byte visual approval.

The retained v003 proposal fixes a duplicate SVG/control identity found during
DOM verification. Opening, resizing, hiding, parent/child drafts and uncertain
delivery recovery passed that check. Earlier mock bytes remain retained. DOM
interaction evidence is not rendered or physical-device verification.

The session-level owner shares the dialog and drafts between historical turn
links and the persistent control. Native children remain within the original
conversation and authority boundary. SnapSheet extends HomeDialog's modal,
focus, scroll-lock and Escape ownership; its mobile grip has equivalent labelled
size/hide controls. TextBubble, UserBubble, ToolPill and semantic tokens retain
the current appearance preferences and transcript style. Viewport-based sheet
height and pointer-derived drag height are structural interaction geometry.

The focused UI batch passed ten tests, including the unchanged protected
NativeSubagents and ChatArea regressions. Drag snapping/cancellation, parent and
sibling drafts, cross-turn access, one dialog owner and original uncertain
request reuse are covered. Design checks passed 109 tests with one skip.

Rendered verification remains pending. TaskExecution could not launch Chromium
because macOS refused Mach process registration. A separately approved native
browser command was then stopped by the repository's Seatbelt guard before
launch. Neither result proves rendering; do not repeat these routes or unset the
guard. Full frontend type checking exceeded the required 1 GiB local heap and
is delegated to CI. The intercepted phone/desktop light/dark browser fixture is
`tests/offline/native-subagents-presence.spec.ts`, alongside the unchanged earlier
fixtures. It uses no backend, credentials or model calls.

Review, hosted CI, source acceptance, production activation and device usability
remain separate and unverified at this draft milestone.

Final local candidate: 132 focused control, store, route, task-execution, feed,
integration and UI regressions pass. The 109 design checks passed separately
with one skip. Browser discovery lists the intercepted Chromium/WebKit cases;
listing does not execute them. An unexpected native acknowledgement now retains
an uncertainty diagnostic, and a later accepted explicit control clears stale
failure presentation without resending the uncertain message.

The first hosted compile caught streaming Map traversal, async result narrowing
and a duplicate registry key. The follow-up corrects all three and adds a real
streaming-to-finished marker regression. The expanded focused batch passes 163
tests across thirteen files, including all existing ChatArea tests. Fresh hosted
type checking and rendered verification remain pending for this correction.

Hosted compilation and frontend builds passed on `2df6991`, as did browser
interaction tests. Core checks identified formatting of the generated registry
and the retained proposal HTML. The latter bytes remain unchanged and are
excluded from rewriting alongside the existing immutable references; their SHA
checks remain enforced. The follow-up strengthens the sizing fixture to assert
actual expanded width, makes desktop Full screen expand the real surface and
keeps desktop inspection compact until explicitly expanded. Mobile snap behavior
is unchanged. These are stronger checks within the same prescribed design; no
earlier protected reference or check was removed.

All three desktop layout shards passed on `2df6991`. Mobile failures reported
the wide agent pill intercepting taps on historical rows. The correction uses
a compact counted icon, transcript-end clearance and a launcher placed before
the approval footer. The offline fixture now uses the product's nested scroll
ownership and explicitly verifies approval actions remain reachable. The v004
proposal reflects the compact control; its DOM interactions pass, and older
proposal bytes remain retained. The catalog fixture is regenerated from the
authoritative TaskExecution description, fixing the separate inventory parity
failure. The expanded local batch passes 199 tests across fourteen files.
Fresh hosted mobile rendering remains required for this correction.

The new capture names use the existing `native-subagents-*.png` retention
pattern so hosted sizing/dragging evidence survives the runner. The integration
with accepted main `f850dcc` preserved both source changes; the only conflict
was generated registry metadata. Post-integration ChatArea/session/sizing and
ledger checks passed, alongside complete source integrity.

Centaur's review of `2df6991` identified the desktop sizing behavior (already
corrected above) and focus loss after the floating list unmounted. Three new
regressions reproduced focus loss after Hide, Escape and Back. The launcher now
serves as the modal's connected focus-return target for floating-list entry;
historical transcript entry retains its original target. The 12 targeted owner,
dialog and sizing tests pass. The new focus cases live in a separate regression
file, preserving the ledger-protected tests unchanged. The prior `579fbbf`
candidate passed hosted compilation, frontend
and iOS web builds, core checks and general browser interaction checks. Fresh
hosted validation and Centaur follow-up remain required for this focus correction.

The `579fbbf` mobile WebKit shard exposed the existing empty-inspection regression:
SnapSheet's more specific body flex rule overrode the compact empty state, leaving
over 220px between Retry inspection and the composer. Removing that duplicate
rule preserves the owning empty-state sizing; empty transcript entry now starts
at half height while explicit Full screen still works. A retained light WebKit
presence capture was visually inspected (artifact `14057258111`); the full chat
surface and composer are readable. It also showed text selected during grip
dragging, now prevented at pointer start and on the grip. These corrections still
require fresh hosted browser execution. The unrelated unit-shard failure is the
forwarded-artifact application journey's missing response at line 133. Local
reproduction stopped earlier because its fixture repository was missing; neither
cause equivalence nor a successful reproduction is claimed.

## Approved icon and retained-image addition, 13 November

Baseline `dc9eeccd5b846a0b6553d3b78a91832e4d33fad1` passed all hosted CI,
including Swift, all desktop/mobile layouts, unit shards and macOS acceptance.
Trusted Centaur review `PRR_kwDOR2Rn9s8AAAABX4DiVA` at20:02:52Z gave exact-head
LGTM/merge with zero blockers. Its three prior review threads were resolved.
The later accepted main change requires coordinated final integration; this
baseline review and unchanged coverage remain retained evidence.

Dimitri then explicitly approved the combined icon in
`parent-child-robot-icon.html` (public user event5748923, direction5748590): one
slightly larger robot above two smaller heads, connected by downward arrows.
The new design revision appends that approval without rewriting earlier ledger
entries, references or protected tests. `UiIcon` owns the geometry, and only the
native subagent entries use the new symbol. Existing header controls, top robot,
Symposium composer shortcut, context indicator and other composer controls are
unchanged. Earlier full-page mocks simplified those controls and must not be
interpreted as approval to change them.

The same request adds full-screen viewing for pictures already sent in chat.
`UserBubble` gives each retained image its own labelled button. The read-only
`ChatImagePreview` reuses HomeDialog and the draft image preview's full-screen
surface, contain sizing, safe areas and modal focus/scroll ownership. Text editing
and image preview have separate interactive targets. Loading/failure status and
Retry remain visible; sanitized load diagnostics omit the URL and image bytes.
No historical image edits, sends, header changes or composer-control changes
are introduced. Closing restores thumbnail focus and leaves the draft intact.

The initial focused local batch passes206 tests across14files, with the existing
documented design skip. It includes restored-message rendering, preview load/
retry/close, source-scope changes, existing message stability, composer preview,
header controls, native focus and all design checks. New intercepted browser
coverage reopens retained landscape/portrait pictures and retries an unavailable
image on phone/desktop and alternate appearances without backend/model calls.
Fresh hosted browser/type verification and targeted delta review remain required
for these additions; the known blocked local browser route was not retried.

Focused read-only correctness review found that portal pointer/context-menu
events could reach the transcript's MessageActions and select a reply behind
the viewer. Three regression cases reproduced the failure before the fix.
HomeDialog now offers opt-in pointer isolation, used only by this viewer, while
preserving native image context-menu behavior. Both local reviewers verified
the correction and the added browser assertions; neither reports a remaining
blocking finding. The final focused batch passes225 tests across18files,
including actual MessageActions touch/pen/context-menu regression coverage.
Browser coverage now also checks just-sent images, meaningful contained image
dimensions, modal keyboard focus, draft preservation and retry recovery.

## Final accepted-base integration

Integrated accepted main9deeb2f (Codex custom-account HTTP routing, ordinary
specialist consultation and Telos adoption/coordination). The source-registry
conflict retains the union of both registrations and advances the runtime
revision. The control-dispatch conflict preserves upstream source-command
admission, actual invocation via onSubmitted and its rejection/uncertainty
boundary. Completion-before-steer recovery remains limited to the undispatched
same-source transition; a changed source command cannot use that retry.
Admission failures also retain the visible child diagnostic.

Two focused read-only integration reviews found no remaining runtime/UI blocker.
Their test-contract corrections now forward actual submission evidence through
the race fixture and mark simulated transport invocation explicitly. Added
regressions verify changed-source rejection even alongside completion, rejection
before invocation and exactly one replacement start under the original command.
The combined local batch passes223 tests across17files; eight real-conversation
adapter cases also pass, with unselected cases explicitly skipped by name.
Hosted checks and current-head trusted final review remain required before merge.

Visual-evidence correction: the existing successful-run artifact owner retains
`responsiveness-*.png`, so the new retained-image captures use that prefix.
This changes only screenshot output names; assertions and product behavior are
unchanged. The initial combined run's successful compilation, core/browser and
unit/consumer results remain useful evidence, but a replacement exact-head run
must retain the corrected captures. No workflow or coverage change is needed.
