# Compact file viewer and stable draft feedback

The user requested a smaller Markdown/HTML display header and investigation and
repair of the draft-status flicker while typing with a screenshot attached on
1 November 2026. This is a local implementation record, not deployment evidence.

The viewer reuses FileViewer, ShareButton, UiIcon and MobileShell. Viewing actions
remain on one row; filename and branch form a truncated column. Mobile Read keeps
its accessible name while showing only its icon. Edit, Save and Discard retain
their labels, with wrapping available during narrow-screen editing. Colors,
spacing, type, controls and safe-area ownership use the existing shared contract.
The approved-design ledger has no protected Files entry; Chat settings and
Symposium controls are unchanged.

The draft status previously alternated between Saving and Saved as asynchronous
storage started and completed. Revision checks also removed and recreated its
DOM node. Its node now remains mounted, with stable autosave wording. Current
revision checks, owner changes, storage failures and delivery receipts retain
their existing fences. The generic wording does not claim pending writes are
durable. Empty and submitted drafts hide the status; failures remain alerts.

Validation completed locally:

- Eight viewer control tests, including accessible names and retained full titles.
- Seventeen saved-draft tests, including attachment pending/settled transitions,
  the same status node, retained focus, failed writes, owner changes and delivery.
- Design suite: 108 passed, one pre-existing skipped test.
- Self-contained preview bundled and read back. A DOM smoke check loaded the
  actual viewer and composer, confirmed sample content and embedded images, and
  switched preview views without console errors. This is not visual browser proof.

The new all-intercept `compact-display.spec.ts` covers mobile WebKit/Chromium and
desktop Chromium in both themes, Mint/System and Teal/Georgia, 320px width, larger
text, 44px controls, options/focus restoration, final paragraph scrolling and
typing with an actual IndexedDB-backed screenshot draft. It generates captures
under `artifacts/compact-display/`. Its bundle and test listing succeed.

Rendered browser acceptance is pending: the approved escalated Playwright command
still reported `CODEX_SANDBOX=seatbelt`, so the repository host guard stopped it
before browser launch. No guard or environment was bypassed. A real browser check
and screenshots must run through a supported host or CI. Broad builds/tests remain
in CI under the Mac's one-worker, 1 GiB local test limit. No staging, production,
provider credentials or model calls were used.

Generate another self-contained local preview with
`node scripts/render-compact-display-preview.mjs`. It writes the next unused
revision under `mockups/compact-file-viewer/` and embeds the actual components,
shared CSS, icons, sample responses and memory-only storage. Changing the viewport,
appearance or view resets the sample state; it never contacts a live service.

The third preview revision responds to the user's phone screenshot: Screen, Theme
and View now occupy one three-column row. Short selected values keep the native
selects compact without reducing their shared control height or base text size.
The light preset still uses Teal/Georgia and the dark preset Mint/System. Preview
control styling is scoped so it cannot override the actual application's selects.
The offline fixture also opens the delivered HTML and checks the toolbar from
280px through desktop widths, theme/view/screen selection and keyboard navigation.
The regenerated artifact passed the DOM smoke check for document rendering, all
three labelled controls, light Teal/Georgia, the screenshot draft and 320px selection.
The focused component/design run again passed 133 tests with one existing skip;
the browser listing includes all nine compact-display cases across three projects.
Browser execution remains pending under the host restriction described above.

Landing preflight on 2 November integrated accepted main `7970842` without UI
changes or conflicts. It corrected an unsupported Testing Library `exact` query
option and refreshed the three changed source fingerprints with runtime revision
`v1.0.826-compact-display-draft-feedback`. The combined branch again passed all
133 focused component/design tests with the same existing skip, and source
artifact verification passed. Full compiler/build and rendered acceptance remain
required CI gates.

CI also exposed stale autosave-copy and unmounted-node expectations in the existing
draft and ordinary-chat browser journeys. Those now assert stable autosave wording
and hidden empty feedback. The ordinary-chat reload still requires exact durable
draft bytes through `expectPersistedChatDraft`, separately from the status copy.
Both changed test fingerprints advance with runtime revision
`v1.0.827-offline-draft-feedback-contract`. The focused browser listing discovers
95 cases including startup across the three projects; execution remains in CI.
Generated preview wrappers are formatted without changing their embedded
application payloads, and the generator formats each newly created revision.
