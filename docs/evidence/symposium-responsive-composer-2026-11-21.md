# S6 responsive composer candidate — 21 November 2026

## Source and boundary

Base: current remote main acquired at `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`.
Branch: `fix/symposium-responsive-composer`. Accepted PR #1374 was merged as
`dc122db8e64b17e639d1985351a2f1c1b7e5defd`; this candidate retains its draft,
recipient, shared control and delivery behavior. No prerequisite PR is needed.

This is an ordinary contributor candidate for scope reference `03faebf1b91972d2`,
reporting to feature lead `b0ea73a5-3a4a-8374-84b2-6fedb68501f8`. It claims no
canonical Telos worker assignment, merge, deployment or runtime acceptance.

S2 owns Send/Queue handlers and the proposed optional `onQueue` contract. This
change preserves those handlers and the Queue callback expression. S7 owns the
existing status rail and adds its own isolated
`onRecipientsClick={responders ? chooseResponders : undefined}` line. This
candidate does not implement that prop or change status semantics.

## Design and implementation

The prior toolbar could contain four leading controls plus usage, microphone,
Steer, Queue and Stop, all with fixed 44px geometry. Its under-360px CSS explicitly
allowed wrapping. Inline long recipient buttons competed for the same space.
The component evidence confirms these coexist; CSS inspection alone is not a
rendered failure reproduction.

`ComposerTools` gains an optional `children` slot for existing secondary controls.
One mounted set moves into the existing overflow at constrained container widths;
primary actions remain outside. The conservative 52rem budget accounts for the
largest action group and larger text. Inline recipients use a separate bounded
grid row; the retained extra source Stop gets its own recipient-row accommodation
at the narrowest widths. The textarea scrolls within a viewport-relative cap,
including expanded mode. No admission or delivery callback changes.

Overflow uses the existing motion hook and semantic spacing, type, surface,
border and radius tokens. Escape returns to More, inline/overflow transitions
restore visible focus, and portaled dialogs keep their originating control
available. The visual viewport bounds the scrollable overflow. The 8px measurement
in that geometry is clearance from the viewport edge, not a new spacing scale.

## Local evidence

- Test-first: the new overflow component test failed because secondary controls
  were absent. Two subsequent focus regressions failed for wide/narrow resize and
  a pointer inside a portaled dialog. All three pass after their fixes.
- 53 focused tests pass across overflow, command strip, focus, inline recipients,
  responder selection, runtime tools and ordinary shared conversation. Existing
  draft and targeted Stop/Steer tests remain unchanged.
- 109 design checks pass; one existing check is skipped. Focused ESLint passes.
- The corrected retained #1428 installer produced a fresh private verified setup:
  Node 24.22.3, npm 11.18.0, darwin arm64 ABI 137; lock SHA-256
  `ccca6e1e72ab39971aced83fc12bb81252dd3a298fa15fb77c6d722ab03ac8ca`.
  It replaced the initial temporary dependency copy. No release/cache writes.
- `test:ui -- --list` compiled workspace packages, then frontend TypeScript
  exceeded the repository-required 1 GiB heap before Vite or browser listing.
  Broad compilation remains a CI gate.
- Browser startup first found no binary in the executor's private home. Selecting
  the already-installed matching Chromium path reached macOS process registration,
  which failed with `bootstrap_check_in ... Permission denied (1100)`. No rendered
  test ran or screenshot was produced; the rejected launch was not repeated.
- A bounded saved Astra reviewer consultation failed during preparation. Reading
  and recovering its original request returned the same uncertain preparation;
  the original consultation was stopped. It produced no review contribution and
  supplies no independent review evidence.

## Rendered fixture and remaining gates

`tests/offline/composer-responsive.spec.ts` bundles the real ChatInput and styles,
intercepts all traffic, and runs through the existing mobile WebKit, mobile
Chromium and desktop Chromium projects. Cases include light/dark Teal/Georgia,
280/320/359/390/800/1280px widths, idle/running state, an extra source Stop,
multiple long recipients, 200% root text, long drafts and a 320×360 short viewport.
It checks target geometry/hit testing, one primary action row, bounds, keyboard
overflow/Escape, recipient selection, retained textarea identity/draft and Stop.
The short viewport is a keyboard approximation, not physical-keyboard evidence.

Run the new fixture and existing approved Symposium/ordinary composer fixtures on
an eligible browser host. Inspect captures in both themes and fonts, test actual
iOS/Android keyboards, safe-area/visual-viewport behavior and screen-reader focus.
No browser, physical phone, full-build or live model acceptance is claimed.
Exact combined-head CI and the normal Centaur review gates remain required before
any separately authorized merge. No staging or production work was performed.

## Revision after the operator design decision (2026-11-25)

CI on the original candidate showed that moving context usage and voice into More
broke the protected ordinary composer check (`tests/browser/composer-layout.spec.ts`,
"context wheel joins the actions"). Dimitri then decided that narrow Symposium
composers wrap onto two rows of direct icons, with nothing in More, and that the
ordinary composer keeps its approved single row.

The candidate now restores main's ChatInput/ComposerTools structure, so the
ordinary composer is unchanged and the earlier secondary overflow (and its Centaur
findings about overflow anchoring and height) no longer exists. A
`data-symposium` toolbar marker and `SymposiumComposer.css` order the existing
controls into two rows below a 34rem composer width. The responsive spec was
rewritten for 280/320/390/768px. It checks that every control is a direct 44px
icon (not inside More), that there is no overlap, that the layout has exactly two
rows at 280-390px, that the primary actions share a row, and that positions stay
the same while typing, sending and queueing. It also checks the expanded
recipient row on a short, large-text viewport and that the ordinary composer has
a single row. The spec is protected in the ledger revision
`two-row-narrow-composer-2026-11-25`.

Browser execution was not available in the implementing sandbox. CI is the browser
evidence for this revision.
