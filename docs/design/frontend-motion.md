# Frontend motion

Mitzo uses the same brief motion on the web and in the Capacitor iOS app.
`frontend/src/styles/tokens.css` owns timing, easing, and distances:

| Role          | Duration       | Use                            |
| ------------- | -------------- | ------------------------------ |
| Fast          | 150ms          | Press feedback, menus, pickers |
| Standard      | 200ms          | Pages, sheets, disclosures     |
| Spin / status | 800ms / 1200ms | Repeating activity indicators  |

Use `var(--motion-ease)` for interaction easing. Activity indicators can use
`linear` or `steps()` where continuous or discrete progress requires it.
Do not introduce component-specific durations or `transition: all`.

## Navigation

`MobileShell` places `MotionRoutes` outside its responsive layout. Every current
and future route inherits a fade on pathname changes, including history back and
forward. Query changes, initial launch, streaming, and ordinary renders do not
replay it. Desktop navigation and mobile tabs stay outside the animated surface.
The boundary uses `display: contents`, preserving the existing flex/grid layout.

Do not add pathname keys to page components or retain outgoing routes for motion.
That can reset drafts or duplicate live subscriptions. Page fades use opacity
only; page transforms would change the containing block of fixed chat controls.
Authentication can settle asynchronously; the boundary observes until a page
exists and then disconnects. Navigation interruption cancels its owned animation.

## Surfaces and disclosures

Use `MotionPresence` for conditionally mounted content. It retains the content
briefly for exit motion and immediately makes it inert and hidden from assistive
technology. Reopening cancels the exit. Updating children does not replay motion.

```tsx
<MotionPresence open={menuOpen} kind="popover">
  <div className="my-menu">...</div>
</MotionPresence>

<MotionPresence open={sectionOpen} kind="disclosure" appear={false}>
  <div className="section-body">...</div>
</MotionPresence>
```

Keep the boundary mounted when closing; placing it inside `open && ...` prevents
exit motion. Use `appear={false}` for disclosures already expanded on page load.
Disclosure height is measured only when toggled, so streamed text can grow normally
after the brief transition. Popovers and sheets use individual `translate` to
preserve existing centering transforms. Backdrops use `kind="fade"`.

Use `useMotionPresence` for settings/forms that must stay mounted when hidden. Put
its `ref` on the existing surface, use `hidden={!present}`, and immediately set
`inert={!open}` and `aria-hidden={!open || undefined}`. Workspace controls and the
reviewer sheet illustrate this pattern. Keep existing focus and Escape handling.

Async picker content and native `<details>` have shared CSS entrance motion.
The CSS layer also provides entrance motion for approval banners and the existing
document/access dialogs. Use the shared presence primitives for new custom menus,
dialogs, and disclosures that need exit motion; do not add animation libraries or
timer-based unmount delays.

## Accessibility and verification

`useReducedMotion` subscribes to preference changes and cancels active Web
Animations. `motion.css` disables CSS animations, transitions, smooth scrolling,
and press scaling under Reduce Motion. Missing animation support or missing
timing tokens falls back to immediate rendering. Animation never delays input or
model dispatch.

CI's `npm run test:design` scans production CSS/TS/TSX for literal durations,
easing, broad transitions, and direct `element.animate` calls outside the shared
helper. Existing design-token checks protect the motion token definitions too.
The motion unit tests cover draft preservation, interruption, reduced motion,
exit accessibility, and mounted settings.

```sh
npm run test:design
npx vitest run frontend/src/components/__tests__/Motion.test.tsx
npm run build
npx playwright test --config playwright.offline.config.ts --grep 'motion:'
```

The browser tests intercept all requests and WebSockets, serving the compiled app
and fixture data without a backend, provider credentials, or model calls. They
cover mobile WebKit, mobile Chromium, and desktop Chromium. Use the broader
`npm run test:ui` suite to check responsive layouts after changing shared surfaces.
