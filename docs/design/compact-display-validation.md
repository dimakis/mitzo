# Compact file viewer and stable draft feedback

Final integration on 4 November 2026 includes accepted main `d6d53c50` (PR #1210).
Its explicitly approved combined composer status supersedes this PR's earlier
autosave wording. ChatInput now matches accepted main exactly: one mounted status
row, silent routine writes and visible failures. The attachment regression retains
its pending/settled writes, node identity, focus and persisted-content assertions,
now checking the quiet Ready summary. Browser mutation and screenshot checks use
the same live summary; retained preview v007 remains a historical snapshot.
The ordinary-chat reload still checks exact durable draft bytes before navigation.
No approved reference, protected test or design-ledger hash was changed.
The combined local design/viewer/draft/status/image/preview checks pass 193 tests
with one existing skip. Runtime fingerprints use
`v1.0.857-compact-status-integration`. New combined CI and focused Centaur
verification of this integration remain required before merge; the earlier
thorough approval is review `5772376926` at `370e8f66`.

On 4 November 2026, the user approved retaining generated previews v002–v006
outside the production PR. Each original-workspace copy was verified byte for byte
against commit `b336631e` before its removal from the candidate tree. Revision v007,
the generator and all browser coverage remain. The preview README records recovery
from Git history. Generation advances beyond the highest retained revision rather
than reusing a historical number. The resulting complete diff is below Centaur's
16 MiB limit; no review limit or approval requirement was changed.

Recovery preflight on 3 November 2026 integrated current accepted main. The sole
conflict was the runtime revision marker; the combined revision is
`v1.0.846-compact-display-integration`, retaining main's implementation and all
matching source fingerprints. The nine focused viewer, saved-draft, design and
preview-CSS test files passed 137 tests with one existing skip. Source artifact
verification, focused formatting and whitespace checks passed. Full combined
CI, rendered acceptance and final current-head Centaur review remain required.

Run `41741156677` found two unsupported Testing Library `exact` role-query options
in the newer branding regression. Anchored accessible-name expressions retain the
same Home/Back assertions while satisfying the compiler's `ByRoleOptions` type.

Run `41741847798` passed compiler/build and core checks, then exposed one stale
desktop editor fixture expecting the removed page-owned Home button. The fixture
now requires one visible shared shell wordmark, no duplicate header logo and the
same image-within-control geometry. All editor reachability, keyboard, touch and
save/discard assertions remain in place; rendered verification stays a CI gate.

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
under each test's output directory as `responsiveness-compact-display-*.png`,
retained by CI's existing responsiveness visual artifacts. Its bundle and test
listing succeed.

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

Run `41436177063` passed compiler/build, core/design, all four unit shards,
browser interaction and every macOS owner. The desktop compact header/composer
cases passed in both themes, and their retained captures were inspected. Remaining
compact-display failures exposed fixture issues: missing mobile shell CSS, exact
label lookup in the generated preview, and WebKit's intercepted blob-script load.
The fixture now includes the real shell stylesheet. Preview revision `v004`
retains the design while labelling its controls explicitly and executing its
decompressed script inline. Earlier revisions remain retained. The generator
resolves repository formatting settings. A DOM smoke check of `v004` passed
document rendering, all three labelled controls, light Teal/Georgia and composer
navigation without DOM errors; rendered acceptance still requires the next CI run.

Run `41445654113` passed the desktop compact-display cases and preview controls
on all three projects. Both phone projects exposed a focused File options target
shrinking to 36px after its dialog restored focus: the later global
`.share-btn:focus-visible` rule tied the viewer selector's specificity. The viewer
now scopes its shared control geometry through its header, retaining 44px sizing
while focused. The browser fixture explicitly focuses each header action before
measuring and includes its name and viewport width in failure diagnostics.
Preview `v005` includes the corrected real component; earlier revisions remain.
Local design checks passed (108 tests, one existing skip), as did all 25 focused
viewer/draft tests, source verification and browser test discovery. Rendered
acceptance for this correction remains a CI requirement.

The same run's joined repository journey returned an uncertain send receipt after
native bootstrap failed at 11 seconds. Main subsequently accepted workspace
admission improvements in `e0b918d`; this branch integrates that base. The only
conflict was the runtime revision marker, now
`v1.0.832-workspace-admission-and-compact-display`, with all source fingerprints
from both branches retained and verified. No admission deadline or assertion was
weakened. The combined branch passes the 133 design/viewer/draft checks and 26
selection-owner tests (one existing design skip). The bootstrap fixture's initial
local attempt was blocked by the host's private-directory fence. With its
supported private-directory setting pointed at a temporary fixture path, all 56
bootstrap tests also pass: 215 passing checks in total. CI remains required for
the real joined browser journey and the focused header correction.

The user requested consistent branding on 2 November 2026. Files no longer owns
the legacy standalone M/home button or its page-specific logo sizing. It inherits
the same full wordmark from MobileShell or DesktopShell as other collection
pages; document Back and its edit guards remain in the compact toolbar. The
preview/browser fixture now includes the real DesktopShell on desktop. The
browser regression requires exactly one visible shared home wordmark and no
page-level logo in either theme. Preview `v006` includes this refinement while
retaining earlier versions. The new no-duplicate-branding/navigation unit test
failed on the old button and passes with its removal. All nine viewer control
tests and 108 design checks pass (one existing skip). Browser execution remains
required in CI under the existing macOS host restriction.
The generated `v006` was read back and its embedded components passed a DOM smoke
check: mobile and desktop each render one shared home wordmark, the file toolbar
contains no M button, and switching to the draft view works without DOM errors.
This is structural/interaction evidence, not rendered layout validation.
Run `41484090893` passed both phone projects' shard 1, which includes the earlier
focused-target regression; the new branding assertions require the next run.

Preview `v007` corrects two misleading fixture behaviors reported by the user:
the phone shell's React breakpoint used the selected width while CSS used the
outer artifact window, and unhandled navigation (including Search chats) rendered
the draft composer. The generated artifact now applies production width media
conditions to its named preview container. React reads that same box and observes
width changes; pointer and motion media conditions remain intact. No shared
masthead scale or production navigation behavior changes. The phone masthead
retains the shared 64px height and 96px wordmark width.

The fixture explicitly renders the actual SessionList for `/sessions` with valid
empty sample list/search responses. Only `/chat` renders the composer; unsupported
preview destinations show a labelled return link. A DOM smoke check reproduced
the incorrect `v006` search-to-composer navigation, then verified that `v007`
opens actual conversation search, settles a query and never opens a composer.
All embedded width media conditions were checked for conversion. Three focused
CSS transformation tests cover phone/desktop bounds, comma alternatives and
retained pointer/motion conditions. The browser fixture now checks the masthead
geometry even at a wide outer viewport and verifies search navigation/querying.
Rendered acceptance and screenshots remain required in CI.

For the user-authorized landing, accepted main `a4d2c51` is integrated. Its changes
are server-side recovery and refresh behavior; the compact viewer, composer,
branding and preview declarations are unchanged. The only conflict was the
shared revision marker, now `v1.0.835-settled-recovery-and-compact-display`.
Fingerprints from both sides are retained and source verification passes. The
combined branch passes 137 focused design/viewer/draft/preview checks, with one
existing design skip. Exact combined-head CI and Centaur approval remain required.

Recovery on 4 November 2026 verified that published commit `d4d1e2ee` passed
CI run `41743281924`, including browser and native coverage. Accepted main
`b8ae361c` is now integrated; its notification, chat recovery, readable tool-result
and reviewed-capture changes merge without UI conflicts. The shared runtime
marker is `v1.0.854-compact-display-integration`; source fingerprints verify.
The combined branch passes 139 focused design/viewer/draft/preview checks with
one existing skip. Fresh combined-head CI and final Centaur approval are still
required before merge.

Inspection of run `41743281924` captures found that files named light still
rendered the dark palette. The fixture assigned root attributes from an early
initialization script, before its HTML root was reliably available. Theme, accent
and font now appear in the served HTML, and the initialization script records
matching appearance preferences for mounted hooks. Assertions verify all three
attributes before the header capture and the theme after composer navigation.
Earlier capture filenames alone do not prove light-theme coverage. The focused
browser command was stopped by the repository's Seatbelt host guard even through
the escalated execution tool; rendered verification therefore remains in CI.
