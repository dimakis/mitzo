# Chat settings acceptance — 17 October 2026

Approved revision: `quick-sheet-2026-10-17`. The Quick sheet is the approved
variant in `quick-sheet.html`; `approved-mock-dark.png` records that reference
with the requested OpenShell mark. Implementation captures are separate evidence.

## Local results

- 327 focused component, route, design-token, approval-history and reviewed-source
  tests passed on the branch combined with main's continuity change `9554a4ea`.
- Focused settings TypeScript checking and lint passed. Final contract/source checks
  cover the final visual changes; the protected-test fingerprint guard was verified
  with a failing digest and then the correct source digests.
- The settings surface fixture covers mobile WebKit, mobile Chromium and desktop
  Chromium, dark/light, Mint/Georgia and Teal/System, larger text and short viewports.
  It checks the approved row order, neutral heading and rows, logos, 44px targets,
  one editor at a time, defaults, model refresh, selection, retained inputs, modal
  dismissal, Back/Escape, focus restoration and full controls above the footer.
- Affected real-app browser coverage includes composer voice/commands/resources,
  draft save/restore/clear, repository preparation and cleanup, exact runtime/model
  selections, invalid and locked choices, independent thinking snapshots, briefing
  recovery, built-in versus saved agents, reusable profile drafts and collaboration.
  All selected scenarios passed across the three browsers, including targeted
  reruns after updating tests to navigate through the actual field editors.
- A further 38 checks for Agent Library navigation, Access, account confirmation
  and retained Telos sources passed across all three browser projects. These
  journeys open each field editor and verify the approved consecutive summary rows,
  selected choices and retained drafts rather than expecting the superseded form.
- The OpenShell mock was inspected in dark/light and at 320px; switching to Local
  Mac removes the OpenShell mark. The approved reference and implementation images
  were inspected separately.

These are all-intercept offline fixtures. They start no backend, use no production
configuration, perform no staging operations and invoke no real models.

## Build and merge acceptance

The required `npm run test:ui` command was attempted with the repository's mandated
1 GiB Node heap. Its Vite production build exceeded that limit. The broad frontend
TypeScript project also exceeded that heap; the focused settings check passed.
Local real-app browser fixtures used an esbuild bundle of the current application
into ignored `frontend/dist`, with every request intercepted. This does not establish
Vite production-build acceptance. Full build, full-suite CI and exact-head Centaur
review remain required before merge.

CI run `39030037794` on `32f54df0` passed design/format/lint and both complete
TypeScript checks, built the production Vite bundle, and passed browser interaction
and native Swift/build acceptance. The initial offline run found older navigation
assumptions in the three journeys above; their focused repaired matrix is green.
The final combined commit must still pass the complete CI matrix.

Main's existing protection requires up-to-date `ci`, `Connections browser regression`
(the browser/offline aggregate), native checks and `Centaur final LGTM`, with admin
enforcement. The ledger's integrity/history checks run in required CI; rendered
contracts run through the required browser aggregate. No protection settings changed.

## Reproduce

Use `npm run test:design` and the focused Vitest files listed in `ledger.json` with
one worker and `NODE_OPTIONS=--max-old-space-size=1024`. For rendered checks, build
the application in CI and run Playwright with `playwright.offline.config.ts`, one
worker and the settings-surface, approved-chat, chat-drafts-updates, local-first-command,
multi-runtime-picker and relevant unified-mobile scenarios. No live target is needed.

Review screenshots against the pinned reference. The automated contracts check
layout and behavior; they do not assert full pixel equivalence or grant permission
to rewrite an approval or weaken its tests.
