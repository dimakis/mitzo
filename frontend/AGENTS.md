# Frontend design instructions

Read [the UI design contract](../docs/design/ui-design-system.md) before changing any user-facing UI. These requirements apply in every session to existing pages and new features, on mobile and web.

- `src/styles/tokens.css` is the only palette/font source. Use semantic color roles, `--font-ui`/`--font-mono`, type/spacing scales, radius tokens, `--page-gutter` and `--control-height`. Never copy literals or redefine shared scales in page CSS or inline styles.
- Reuse `MobileShell`, `DesktopShell`, `WorkspacePageHeading`, `UiIcon`, `EmptyState` and existing controls before creating another implementation. Collection pages do not own a second mobile logo, safe area or navigation height.
- Repeated controls and list patterns belong in shared components/styles. When no suitable pattern exists, add it there with its tests and document it in the contract in the same PR.
- Match the Connections reference: quiet surfaces, readable hierarchy, grouped rows, restrained action accents and details on request. Use navigation names and direct, human-readable copy.
- Keep large text, long titles, 44px mobile touch targets, accessible names, visible keyboard focus and labelled destructive actions usable. Check loading, empty, error and success states.
- Keep accent and font preferences effective across routes. Never make changing the accent recolor warnings/errors or make code lose its monospace font.
- Run `npm run test:design` from the repository root for every UI change. Extend the guard when adding a new styling mechanism; do not suppress it to ship a page.
- For rendered UI changes, add/update relevant offline browser fixtures and run `npm run test:ui`. Inspect changed screens on mobile and desktop, in light/dark themes and representative alternate accents/fonts. Check scrolling and keyboard behaviour where relevant.
- Record shared patterns/tokens used, checks performed and screenshots or visual inspection evidence in the PR's UI design section. If a check is inapplicable, explain why.

Existing literal layout measurements are migration debt, not examples to copy. Use scale tokens for new/changed spacing, type and radii. Component geometry (for example a 1px border or a viewport calculation) may require an explicit value; explain an exception when it affects visual rhythm. Changes to the common design belong in the shared source and contract, with affected views checked together.

## Motion

For React and CSS changes under `src/`, follow
[the shared motion contract](../docs/design/frontend-motion.md).

- New routes inherit motion through `MobileShell`; do not key pages by pathname.
- Use `MotionPresence` for menus, sheets, and disclosures. Keep the boundary
  mounted through close, and preserve focus, keyboard, and draft behavior.
- Use `useMotionPresence` for settings that must stay mounted while hidden; exit
  content must immediately be inert and hidden from assistive technology.
- Timing/easing comes from `styles/tokens.css`. Use the shared helper for Web
  Animations; no private durations, `transition: all`, or unmount-delay timers.
- Respect Reduce Motion and verify changes with `npm run test:design`, relevant
  unit tests, and the offline browser motion/layout tests. These need no model calls.
