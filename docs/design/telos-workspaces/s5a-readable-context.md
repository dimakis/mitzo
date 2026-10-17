# S5a retained-context presentation correction

Parent `85e8444019a4ae4a`; S5a `9dab491c72f0494e`. This independent correction
starts from accepted Mitzo 13669901. The current S5 producer's changed-file
inventory does not include `TelosLinkedContext`; allocation, dispatch, role
context schemas, fingerprints, recovery and persistence remain with their owners.

The existing disclosure now explains Overall goal, Parent outcome, This item and
Done when in the approved order. Raw snapshot/message/block IDs and hashes remain
in the retained DTO and exact action URLs, rather than the explanation. Sources
show the selected message count. Materials show the real retained revision.
Missing display titles use Parent item and Retained material labels; names, dates
or revision numbers are never inferred from opaque IDs. Existing plain-text
briefs, unavailable-source text and material errors remain readable.

The component opens the same original conversation and exact retained material
revision, uses the same browser/native sharing owner, and fetches no replacement
content when the disclosure opens. Navigation and material controls reuse
`session-work-link` and `home-secondary` with the shared control-height token.
There are no new palette, font, motion or layout scales. The ordinary context
region keeps its existing bounded scrolling and the composer stays available.

## Evidence

Two real-component regressions failed first: approved heading order was missing,
and raw authority identifiers appeared as the explanation. The original three
context/source/material checks still passed. The correction passes those checks,
the new regressions and the existing role-setup component checks: seven total.
The design suite passes 108 with one existing skip.

The focused offline fixture uses the actual component, ordinary ChatInput and
their existing styles. Six scenarios pass across mobile WebKit, mobile Chromium
and desktop Chromium, plus two separate browser-startup checks. They cover dark
Mint/System, light Teal/Georgia at 160% text, a 320px phone, long text, keyboard
disclosure and focus, bounded scrolling, 44px controls, exact source/material
links, a visible retained-material error and unchanged unsent composer text.
Opening the disclosure makes no additional source request. All traffic is
intercepted, with no backend, credentials, model or runtime allocation.

Inspected captures are linked in the UI design contract. These isolated renders
omit the application shell. Broad build/type/full-app UI checks belong in CI
under the lane's one-worker/1 GiB local limit.

## Remaining acceptance

This is a draft presentation increment, not complete CT05 or S5a acceptance.
Parent/material human display metadata still needs its authorized exact-version
projection and accepted-schema compatibility work. S7 consumes the single shared
renderer; S9 verifies final combined-source desktop/mobile UX. The frozen mock,
approved Quick Settings sheet and ledger remain unchanged.

The remaining advisor child timestamps/history/atomicity, positive same-request
preallocation recovery and complete journeys still require accepted S5 before
overlapping implementation. Generic 409 never unlocks an uncertain request.
S5b follows accepted S5a. No deployment, staging revival, live cleanup, live
database migration or model test is part of this increment.
