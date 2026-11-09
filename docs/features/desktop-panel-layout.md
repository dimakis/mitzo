# Desktop conversation width and resizable columns

User direction, 9 November 2026, Mitzo conversation
`732c67ba-5537-84ee-a704-c7d50e2ba816`:
“yep, lets fix that. also, for whatever reasonm, we can't move customise the various different columns like the side bars or the conversations, lets fix all of those”.
This approves removing the centered 860px transcript limit and 85% assistant
bubble limit and making the desktop columns adjustable. It does not change the
approved settings or composer designs, column order, backend or session dispatch.

DesktopShell now provides draggable dividers for navigation, conversations and
resources. The remaining width belongs to the conversation. Arrows resize in
10px steps, Home/End reach the current bounds and double-click restores a panel's
default. The conversation preview shares the same control, preserving its
26–52% limits and 2% keyboard steps. Pointer movement uses deltas without jumping
when first pressed; cancellation and capture loss end the drag.

Widths and existing collapse choices persist in browser storage. Collapsing does
not discard an expanded width. Narrow windows fit all present columns around a
center budget of one third of the available width, capped at 320px; returning to
a wide window restores the preferred widths. The desktop breakpoint remains
768px. Missing storage retains in-memory interaction and reports its limitation.
The existing optional layout storage policy is distinct from durable chat storage.

Responses use the full available desktop pane with the shared page gutter.
Table cells wrap long summaries, including on phones. Automatic column sizing
lets short identifiers leave room for summaries; the existing wrapper still
contains unusually wide content.

Shared sources: DesktopShell, ResizeDivider, useDesktopPanelLayout,
useLayoutPreference and ResizableSessionLayout. Styles use semantic color tokens,
page/spacing/type tokens and existing shared appearance. Divider hit geometry,
panel limits and viewport budgets are structural measurements. Dragging applies
widths directly without an interpolated transition. Existing approved ledger
entries and their protected checks remain unchanged.

Validation as of 9 November 2026:

- Test-first sizing, pointer, keyboard, persistence, cancellation, collapse/restore,
  absent panels, corrupt/unavailable storage and window-fit component regressions.
- 285 passing checks across 19 sizing, shell, conversation-library, message and
  design suites; one existing CI-only design check skipped locally.
- Focused strict TypeScript checks and ESLint for new components/hooks.
- The all-intercept offline browser fixture covers mobile WebKit/Chromium and
  desktop Chromium in dark Mint/System and light Teal/Georgia. It checks actual
  drag geometry, keyboard focus, retained draft, restored widths, full response
  width, wrapped tables and narrow desktop bounds. Test discovery/bundling passes.
- Local rendered verification is pending: the approved escalated Playwright
  command still retained `CODEX_SANDBOX=seatbelt`; the repository host guard
  stopped it before browser launch. No browser retry, screenshots or visual
  inspection are claimed. Full build and rendered acceptance remain CI gates.

Implementation starts from current canonical main `33cfa0699413`, which also
matched the inspected release. No staging or production activation is included.

Landing preparation: two focused read-only reviews of `2dd7f1ec` found no
blocking findings. The drag fixture now checks actual panel dimensions, covers
preview pointer resizing and uses CI's retained responsiveness screenshot names.
An optional follow-up is retaining unrelated wide preferences when a user manually
resizes another panel on a constrained window. Pure window resizing already
preserves the saved layout. CI source preflight identified stale registered
hashes for the changed design contract and chat CSS; the runtime source revision
and those two hashes were refreshed without changing their verification.

Final-base integration retains accepted main `3f594189` (PR #1272), which fixes
native policy/history recovery without changing frontend layout or dependencies.
The only conflict was the shared runtime revision stamp; it advances to
`v1.0.972-desktop-panel-layout` while retaining both sets of source fingerprints.

CI captures at `83ce4266` confirmed full-width responses and working dividers in
light/dark themes. They also exposed a word-breaking problem in narrow identifier
columns: `anywhere` allowed automatic table sizing to split even a one-word
heading. Table cells now preserve word boundaries for intrinsic sizing while
wrapping summaries, and the browser fixture checks that its one-word heading
remains intact. The scroll wrapper still contains exceptionally wide data.
