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
