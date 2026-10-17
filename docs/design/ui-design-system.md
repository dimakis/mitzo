# Mitzo UI design contract

The Connections inventory is the starting point: quiet surfaces, clear type, grouped rows, restrained lavender actions, and detail views that expose context when requested.

## One theme source

`frontend/src/styles/tokens.css` owns every app palette literal and font stack. It loads before component styles in the production and fixture entry points. Components use semantic variables in CSS and React inline styles. The old `--accent`, `--ui-font`, `--text`, `--bg`, and `--workspace-*` names are aliases to that same source; never give them a second palette.

- Actions and selection: `--color-accent`, with `--color-on-accent` for filled controls. Accent panels derive from the accent and background using `color-mix`.
- Surfaces and text: `--color-bg`, `--color-surface`, `--color-panel`, `--color-text`, `--color-muted`, `--color-border`.
- Meaningful states: `--color-success`, `--color-warning`, `--color-danger`, `--color-info`. Changing the action accent must not change the meaning of warnings or failures.
- Fonts: `--font-ui` and `--font-mono`. Form controls inherit the app font; source/code uses the code font.
- Rhythm: use the type/spacing scales, `--page-gutter`, `--control-height`, and radius tokens. Mobile controls have at least 44px touch targets.
- Light theme overrides the semantic values in this same file. Use paired foreground/background roles for contrast in both themes.

Stable agent identity colors use `--seat-color-*` in the same file. Persisted provider configuration is data, not a style declaration: the configuration adapter resolves the default identity color to the literal required by its existing API. Native status bars and browser theme metadata read the current background token rather than carrying their own copies.

Route loading keeps shared Home controls and dialogs in the application entry stylesheet. Component styles load with their route; their control heights must use `--control-height` independently of global CSS ordering. Static markup browser fixtures include the styles owned by the components they represent. Offline regression captures show [shared Updates controls](assets/startup-shared-controls-mobile-light.png) and [profile controls loaded with the chat route](assets/startup-profile-controls-mobile-dark.png).

If a route download fails, the existing error boundary explains the connection failure. Its Try Again control reloads the current document to clear rejected module promises; ordinary rendering errors retain the existing component reset. The offline route-recovery test blocks the Login chunk, restores connectivity and verifies sign-in after retry on all three browser projects.

Dynamic route JavaScript uses direct imports rather than Vite modulepreload links: WebKit can retain a failed modulepreload across reloads. Initial HTML preloads and route CSS loading remain enabled, and the likely landing route still starts alongside authentication. Recovery acceptance must use the production Vite bundle because an esbuild fixture does not reproduce this preload behavior.

## Appearance preferences

Settings exposes eight curated accents and seven locally available UI font stacks. Preset values live in the same token file, including the light/dark accent shades. The preference hook stores validated preset IDs in local storage and applies root data attributes immediately; startup restores them before React renders. The UI says these choices are saved on the current device. Code remains monospace, and Reset appearance restores System theme, Lavender accent and System font. Browser tests verify every accent pair meets 4.5:1 contrast for filled controls and that selections survive route changes and reloads.

## Mobile composition

`MobileShell` owns the full wordmark, its position and size, the safe area, and the bounded content viewport on collection routes. Individual collection pages never add another mobile logo. Conversation and item detail routes keep their focused back/navigation and keyboard layout.

Use `WorkspacePageHeading` for title, a short description, optional count and page actions. Titles describe the destination using the navigation vocabulary: Work, Inbox, Chats, Connections. Avoid competing product/internal names in the same heading. Describe the next useful action in direct language.

Use grouped bordered rows and quiet surfaces for lists. Put the most useful title first, concise context below, and secondary metadata last. Long technical names must wrap or be clamped in the list and remain available in the full detail. Destructive actions need visible labelled controls; Proposals opens its full content before reviewing it in a chat. Return to the filtered list without losing the query.

## Drafts and updates

Chat load errors distinguish an initial request from a refresh of a previously loaded
list. A failed refresh retains its rows beside the existing error and Retry control,
including in Today's recent sessions. Draft confirmation describes storage on the
current device, appears only after the current revision is saved, and disappears
when an empty composer has no retained draft. Failed writes remain explicit alerts.
These changes reuse existing list/error and composer status styles.

Isolated actual SessionList and ChatInput renders were checked offline in mobile
WebKit at 320px and desktop Chromium at 1280px, dark/light themes and Mint/Georgia,
with retry, empty/saved/cleared states and retained composer focus. Captures show
[mobile refresh](assets/chat-refresh-mobile-dark.png),
[desktop refresh](assets/chat-refresh-desktop-light.png),
[mobile draft save](assets/chat-save-mobile-light.png) and
[desktop draft save](assets/chat-save-desktop-dark.png).
These focused renders omit the application shell; full-app offline fixtures cover
the corresponding routes and run in CI when host pressure prevents a broad build.

Chats shows a counted Drafts destination when saved drafts exist, separate from active and recent conversations. The shortcut disappears when the last draft is removed. The dedicated collection uses `WorkspacePageHeading`, `MobileShell`/`DesktopShell`, shared iconography and token-based quiet records. Each record leads with the message, shows the saved account/model/thinking context, and exposes a labelled discard action through `HomeDialog`. Draft text wraps or clamps in the list and remains editable in the ordinary composer. Save failures stay visible. New chat always starts fresh; switching drafts must never copy one draft's content or settings into another.

Empty messages with a repository preparation retain their exact receipt. Legacy preparations keep their account/model binding. New server-qualified READY preparations keep account and environment locked while allowing a supported first-message model before reservation; original source and preparation model stay recorded and the first reservation freezes the effective command. Discard confirms and releases unused preparations before removing the local draft; unavailable or uncertain cleanup keeps the draft and reports the error. Pending attachment imports remain fenced to their originating composer. Clearing an ordinary draft leaves an editable blank composer whose URL can be reloaded.

Settings owns the Updates destination and its availability summary. The dedicated update panel uses the shared surface, accent action and secondary controls; commit/build metadata remains secondary. Review update opens the existing configured prompt for user review. Loading, unavailable configuration and failed checks must remain distinct from an up-to-date release. Both pages inherit theme, accent, font, shell scrolling and navigation motion; neither defines another palette or wordmark.

Offline acceptance captures show [Chats with its Drafts shortcut](assets/chat-library-chats-drafts-mobile-dark.png), [saved drafts on a narrow phone](assets/chat-library-drafts-mobile-dark.png), [the light desktop collection](assets/chat-library-drafts-desktop-light.png), [mobile Updates](assets/chat-library-updates-mobile-light.png) and [desktop Updates](assets/chat-library-updates-desktop-dark.png). The all-intercept fixture checks 320px mobile and 1280px desktop, light/dark themes, Mint/Georgia and Teal/System, larger text, final-item scrolling, keyboard focus, modal dismissal and confirmation, missing account/model selections and loading/error/update states. The fixture starts no server, provider or model. Discard confirmation returns focus to the next draft or New chat.

## Icons

Use `UiIcon` for application controls, navigation, resources and status indicators. It renders decorative SVGs with a shared 24-unit viewbox, rounded 1.7-unit strokes and `currentColor`; use 16px in dense controls, 20px in navigation and 24px in empty states. These dimensions describe icon geometry, not a competing spacing scale. Keep touch targets at `--control-height` even when their visible icon is smaller. Filled stars distinguish pinned items; other icons use outlines. Busy icons respect reduced motion.

Internal destinations use `forward`/`back` chevrons; external destinations use `external`. Resource types use file, image, terminal, layers and connections shapes. `lib/status-icons.ts` owns task, outcome, session and progress mappings; retain visible status text or an accessible control label. Scope badges use Workspace, Personal and Built-in text. Never use emoji or font glyphs for UI controls: appearance fonts and platform emoji rendering must not change their meaning or weight. Brand assets, prose, keyboard shortcuts, user content and data visualizations retain their own rendering.

Decorative SVGs do not carry an accessible name or state. Name icon-only buttons, use `aria-pressed` for context selection and `aria-expanded` for disclosures, and expose nontext status indicators through a labelled wrapper (`role="img"`) or status text. Pinning must not hide an outcome's status from assistive technology.

The [approved before-and-after comparison](assets/icons-before-after.png) shows the icon treatments in reconstructed app snippets. Offline screenshots of the implemented app cover [dark Settings](assets/icons-settings-dark.png), [light Settings with Georgia](assets/icons-settings-light.png), [320px touch task controls](assets/icons-taskboard-mobile.png), [desktop task states](assets/icons-taskboard-desktop.png) and [light Connections](assets/icons-connections-light.png). Touch task actions wrap below the title and remain visible; keyboard focus also reveals actions on desktop. Header action groups wrap within the available width.

The bottom navigation shares its height token with the conversation composer and session tray. The shell owns the safe areas once. Inner lists scroll within the remaining viewport and keep their final item above navigation.

## Document editor controls

`DocumentEditor` owns the shared editing toolbar in Files and Knowledge. Group
Source/Preview/Split view selection separately from Standard/Vim editing keys and
relative line numbers. Place Undo/Redo and the six Markdown formatting actions in
a quiet icon row, with accessible button names and descriptions available on hover
and keyboard focus. Fullscreen retains its labelled action and the existing save
flow. Knowledge's general button styles must not override this shared pattern.

Keep the source editor, selection, draft, history and preferences mounted when
switching views. Compact desktop chrome uses the common control geometry; touch
controls retain at least `--control-height`, with wrapping or an independently
scrollable toolbar that keeps each control reachable. Visible Vim mode is status
text, distinct from the preference that enables Vim.

File-header actions use quiet secondary controls and a restrained accent for Edit
or Save. Discard remains a visibly labelled destructive action; Done remains
neutral. Save, loading, error and conflict states retain the existing behavior.
Colors, fonts, spacing, focus, radii and motion come from the shared token source.

## Saved document revisions

Saved Telos Markdown and HTML documents reuse the Files header, `DocumentEditor`,
draft status and conflict controls. Edit opens the existing editor; **Save new
revision** appends a revision and opens its pinned URL. Previous links retain their
original bytes. The revision status explains saving, and output provenance labels
human changes as Edited by user. Unsupported formats stay read-only. Existing
semantic tokens, focus, large-text wrapping, mobile touch targets, theme/font
preferences and shared toolbar motion remain effective; no new styling is added.

The all-intercept `telos-document-editing` fixture renders the actual page at
320px mobile WebKit/Chromium and 1280px desktop Chromium in dark Mint/System and
light Teal/Georgia. It checks keyboard focus, larger text, failure/reload recovery,
both conflict choices, new-revision navigation and sharing the saved bytes. Six
scenarios and two browser startup checks pass, alongside 155 focused unit/route
regressions, 107 design checks, frontend type checking and focused lint. The full
`test:ui` build exceeded the required local 1 GiB heap; full application build and
suite acceptance remain CI checks. The fixture isolates Files from the shell and
uses no backend, credentials or model. No staging or production activation occurs.

Inspected captures: [mobile dark editing](assets/telos-document-mobile-dark.png),
[mobile light editing](assets/telos-document-mobile-light.png),
[desktop light editing](assets/telos-document-desktop-light.png) and
[saved desktop revision](assets/telos-document-saved-desktop.png).

## Interactive HTML previews

Standalone HTML file links in assistant paragraphs use the shared `HtmlPreviewCard`
and open inline automatically. The header uses semantic surface/border/accent roles,
shared type/spacing/radius tokens, `UiIcon`, and 44px controls. Artifact content keeps
its own design on the existing neutral preview canvas. The bounded frame height is
structural viewport geometry; Open leads to the existing full Files viewer.

The disclosure uses `useMotionPresence` with retained DOM, so collapsing removes
input and accessibility access immediately while preserving the same iframe and
its local selections. A new file/session identity starts a fresh preview. Loading
uses a status announcement, failed reads expose an alert and Retry preview, and an
empty HTML file remains a valid blank document. Network, form submission and parent
access restrictions remain those of `HtmlPreview`.

The offline `html-mockup` fixture renders actual assistant Markdown and checks
inline loading, native keyboard/form interaction, variants, retained state,
read failure/retry, empty files, session-scoped reads and sandbox isolation on
320px mobile and desktop with dark/light Mint/Georgia appearance and larger text.
It intercepts every request and starts no backend or model.
Messages containing these previews bypass prose truncation so its fade and Show
more overlay cannot cover interactive content. Captures show the
[320px mobile dark preview](assets/html-mockup-mobile-dark.png) and
[desktop light preview](assets/html-mockup-desktop-light.png), both with Mint/Georgia
and larger host text. These isolated transcript checks omit the application shell;
full-app build/browser acceptance remains in CI when local memory pressure prevents
the broad suite. The sandbox blocks native form submission in Chromium before a
submit handler can run; simulated forms use button click handlers and local validation.
The capability guidance reaches ordinary owned Codex and Responses/Gemini routes
at their provider configuration boundary as well as the older shared chat prompt.
Frozen command/profile payloads stay unchanged. These boundaries have offline
mock-provider regressions, and their reviewed source fingerprints include the
shared capability contract.

The preview is an HTTP document at `/api/html-preview`, with a distinct restrictive
response CSP and `sandbox allow-scripts` in both header and frame. A `srcdoc`
document inherits the application's `script-src 'self'` policy, so its own meta
policy cannot enable prototype scripts. The application policy stays unchanged;
only the empty preview shell permits inline artifact scripts. The parent transfers
the already-authorized document once after load. The shell validates the sender
and message shape, removes its listener, then renders; it exposes no host command
bridge. Neither artifact content nor authentication tokens enter the frame URL.

`frame-ancestors` permits the app itself and exact configured CORS parent origins,
including Capacitor. The shell carries no user data and needs no bearer token;
the original file read retains its session/auth checks. Browser fixtures invoke
the same security middleware as the deployed app and exercise web and cross-origin
embedding. Both script elements and inline event handlers run inside the preview;
the host rejects inline handlers and preview network/parent access stays blocked.
Before delivering scripts, the client also installs a narrowing parent `frame-src`
policy for self and the configured application server. This closes frame-navigation
exfiltration in native webviews which lack the web host's response policy. The
build-constant policy remains installed because removing a CSP meta element does
not revoke it. Offline tests start the cross-origin parent with permissive frame
navigation, then verify the component blocks an attempted external navigation.

### Managing multiple mockups

**More → Mockups** opens a protected collection route with the existing chat list
and history search. Choose a chat before reading its saved messages; viewing never
attaches a provider or starts a turn. The route reuses `MockupCollection` and the
original session-scoped file reads. Search survives returning to the picker, late
history reads are fenced to their selected chat, and failed/malformed history has
an explicit retry state. MobileShell owns the mobile masthead and navigation;
More stays selected in both navigation layouts. PageRoute supplies DesktopShell.
The offline navigation fixture covers actual shells and pages at 320px/1280px in
both themes with Mint/Georgia, history failure/retry and working preview actions,
using intercepted requests only. Captures show the
[mobile chat picker](assets/mockup-navigation-mobile-dark.png) and
[desktop chat picker](assets/mockup-navigation-desktop-light.png).

Resources includes a per-chat **Mockups** collection. It reads finished assistant
Markdown file links from the available conversation history; discovery is a
reference, not proof of file creation or durable publication. Versioned paths
`mockups/<slug>/v001.html`, `v002.html`, etc. group by their full directory, with
numeric newest revision first. Unversioned HTML links remain separate entries.
The authoring skill creates the next unused revision instead of overwriting a
previous version. Distinct designs use distinct slugs.

The collection searches names/paths, shows eight designs per page and opens only
the selected preview. Returning preserves the search/page and restores focus.
Changing revisions creates fresh preview state; unavailable sources retain the
existing alert/retry behavior. Switching chats clears collection selection and
never carries file authority between sessions. The list uses existing resource
rows, semantic tokens, UiIcon, HomeDialog and HtmlPreviewCard; its five tabs wrap
on narrow screens. Files still depend on the original workspace being available.

Offline acceptance uses forty designs with three revisions each, no backend or
models, in light/dark themes on 320px mobile WebKit/Chromium and desktop Chromium.
It verifies bounded lists, lazy preview reads, search/paging, numeric revision
selection, working local interactions, unavailable versions, back/focus, Escape,
empty search/collection, readable tabs and session isolation. Captures show
[mobile collection](assets/mockup-collection-mobile-dark.png) and
[desktop collection](assets/mockup-collection-desktop-light.png).

## Token usage

The conversation token popover groups latest context/request capacity separately
from cumulative usage, with short explanatory notes. Native request totals and
session input-context observations retain their distinct labels. Runtime-reported
capacity is the effective context limit; unknown/stale capacity remains unknown.
The native `details` disclosure explains repeated input, cache reuse, compaction
and optimization without turning cumulative tokens into a cost estimate. It uses
shared type/spacing/radius/color tokens, a `--control-height` summary target and
visible keyboard focus. The existing `MotionPresence` and Escape behavior remain.
Popover width is bounded by the composer's toolbar and the page
gutters, including desktop layouts with both sidebars expanded. Its 70dvh maximum height is
structural viewport geometry; internal scrolling keeps expanded explanations and
reporting details reachable on short phones and with larger text.

Offline acceptance screenshots show [the separated usage figures on a narrow
phone](assets/token-usage-mobile-dark.png) and [expanded help with larger text,
Teal accent and Georgia font](assets/token-help-mobile-light.png). The offline
fixture covers keyboard disclosure, Escape, touch targets, scrolling and empty
usage on mobile WebKit and mobile/desktop Chromium. An 800px desktop regression
case verifies the collapsed and expanded popover stays inside the center panel
and composer, with both sidebars open. The [narrow desktop acceptance
capture](assets/token-usage-narrow-desktop.png) records that layout.

## Motion

The [shared motion contract](frontend-motion.md) applies to mobile and desktop.
`tokens.css` owns the 150ms feedback/menu and 200ms page/sheet/disclosure roles,
their easing, and the small popover/sheet travel distances. `MobileShell` supplies
navigation motion automatically. Reuse `MotionPresence` and `useMotionPresence`
for surfaces, preserving drafts, focus, and subscriptions. Streaming content does
not replay transitions. Reduce Motion disables animation and press scaling.
`npm run test:design` also rejects literal timings/easing, broad transitions, and
direct Web Animations calls outside the shared helper.

## Ordinary conversation runtime selection

Ordinary conversations use one compact top summary and one settings dropdown on
mobile and desktop. `WorkspaceControls` owns the compact opaque popover and the always-visible
Access action. Conversation context stays at the left; a content-sized Settings
button stays beside Access. The title leads, with agent, account, model, thinking
and execution location secondary; full settings remain in the trigger’s accessible name.
The composer contains the message and its existing toolbar, with no repeated picker.
The dropdown starts closed for each conversation, independent of previous open
preferences or attention states. Outside pointer interaction closes it without
preventing that interaction or taking focus. Escape, Close and Done restore focus
to the summary; only Done reviews the current execution intent.

`AgentSettingsFields` retains one mounted set of Agent, Account, Model/Thinking
and Run on controls immediately inside the top popover. Secondary mode, voice, web search,
collaboration and profile-draft controls live under **More settings**. Existing
account confirmation, runtime binding and preparation locks still apply.
The dropdown scrolls within the available space above the composer on phones.
The shared fields, motion presence, UiIcon, semantic colors, spacing/type/radius
scales and 44px control targets remain in use. New phone sessions and restored
drafts do not request keyboard focus on mount. While the software keyboard is visible, mobile navigation yields its height to
the conversation and composer. Native keyboard events or the browser visual
viewport determine that state; ordinary focus, browser chrome and pinch zoom
must not toggle navigation or shift the composer.

Workspace remains for conversation details and operational controls. OpenShell is
the default; Local Mac is deliberate. Resolve only pristine unselected target
intent from trusted inventory, and preserve stale/unavailable account, model,
thinking and target choices with a useful reason. Runs with describes the derived
software rather than adding another runtime control. An unbound retained
account whose exact reference is missing or changed displays a disabled confirmation
option in the existing Account select. Selecting the real catalogue account
explicitly confirms its current tuple in one step, retaining model, thinking and
draft content. Opening the control, changing other settings or reviewing execution
choices never confirms billing; bound accounts stay locked.

Bound ordinary Codex, Responses, Claude and Gemini conversations lock account, exact profile identity and execution target. Supported Codex/Responses/Claude scope enables model/thinking edits for future commands, normal guarded follow-ups and the native queue. Gemini shows its original-model/thinking constraint and retains changed intent with explicit refusal; it does not promise unsupported future settings. Each queued
request keeps its original settings snapshot. Consumed receipt settings are labelled Last submitted command, distinct from the future picker selection. Unsupported mode/context/web helpers
remain independently disabled. Metadata loading/failure never enables legacy
fallback; Retry preserves the conversation and draft.

New session elsewhere creates a separately owned blank draft with copied intent
and no inherited repository preparation. The explicit retained-intent flag keeps
that blank draft recoverable without changing ordinary empty-draft behavior. Its
separate preparation creates a separate checkout. The original conversation,
provider history, branch and pending work remain under their existing owners.
Unavailable cold custody is a visible server reason, not a replacement environment.

Repository preparation cards share the chat column's available flex space with
the non-shrinking composer. Long branch/details/actions scroll inside the existing
card instead of pushing attachments and the message field beneath navigation.
The Workspace disclosure observes that card's geometry; no fixed viewport-height
cap or reset of settings, focus or draft is required.

The existing motion boundaries, drafts and focus remain mounted. Expanded settings
must scroll at 390 × 844 and with larger text while shell navigation stays reachable.
Hosted all-intercept fixtures cover Local/OpenShell start, future thinking, guarded
queue snapshots and new-session intent. Source tests are offline; rendered hosted
CI evidence and live provider qualification remain separate. The approved source
archive is Telos artifact `3985777d901aa39cef7765f75b1277d6`, revision 1; its mock
catalogues illustrate layout and do not establish live route availability. See the
[completion checklist](session-runtime-continuity-checklist.md).

## Authentication recovery

The native splash yields to the rendered authentication status without waiting for a network response. A stalled check has a five-second deadline and reaches the existing token-styled unavailable alert and Retry action. Mobile shell navigation remains reachable. Retry starts a fresh check without clearing a valid login or requiring another tab; only an actual authentication denial redirects to Login with the original destination. Offline fixtures cover startup, tab changes, light/dark appearance and retry on mobile WebKit and mobile/desktop Chromium.

Transient failures also retry automatically with three bounded backoff attempts.
Returning to the native foreground, restoring network connectivity or making the
document visible restarts unavailable authentication without requiring a manual
Retry. Hidden apps do not send recovery attempts; duplicate wake signals are
coalesced. Verified routes remain visible, and denied authorization still goes
directly to Login. Recovery reuses the same status, alert and shared button styles.

## Verification

The token unit test scans production frontend source and rejects palette literals (including named CSS colors and RGB/HSL), CSS font-family/font shorthands and literal React fontFamily stacks outside the token file. It also rejects literal overrides of shared tokens, including spacing, type, radius and shell dimensions, in component CSS, embedded CSS strings/templates and literal inline custom properties. Font checks inspect the complete family value, including the family portion of shorthand declarations, rather than accepting any value starting with a variable. Existing scoped legacy color/text aliases and token-based color mixes remain valid when their inputs resolve to registered color tokens; spacing and font tokens are not color inputs. Shared scales, font roles and canonical color definitions cannot be reassigned by a page, even through another variable. Font-family references must resolve to registered shared font roles. Inline font checks inspect static expression branches, concatenation and template interpolation; preference IDs remain data. Only the canonical token-file path is exempt, so a feature cannot introduce a second palette by naming its stylesheet tokens.css. Synthetic preview data is excluded because it represents API payloads rather than app styling.

`npm run test:ui` builds the real app and runs `playwright.offline.config.ts`. The fixture router serves assets and responses entirely in the browser test process, denies mutations and external requests, and closes WebSockets. It starts no preview, backend, provider or model. It checks WebKit and mobile/desktop Chromium, narrow widths, shared wordmark geometry, accent and font substitution, light/dark surfaces, full proposal review and reachable collection endings. Existing browser regression suites remain separate.

## How subsequent sessions preserve the standard

Root `AGENTS.md` and `CLAUDE.md` require this contract before UI work. `frontend/AGENTS.md` carries the scoped implementation checklist, and `.cursor/rules/ui-design-system.mdc` is always applied in Cursor. Keep these entry points short; this document remains the detailed source of design decisions. Instructions travel with the accepted repository revision. An older checkout must incorporate the accepted instruction changes through its normal branch workflow; a rule in a new revision cannot retroactively update every existing session.

Before adding a page or control, find the nearest existing pattern. Reuse `MobileShell`/`DesktopShell`, `WorkspacePageHeading`, `UiIcon`, `EmptyState` and appropriate existing controls. Extend a shared component/style when the same pattern is needed again. A feature's business logic belongs to its feature; its visual language belongs to the shared system.

Use scale tokens for new or changed spacing, type and radii, even where older styles contain literal measurements. Do not establish another spacing scale in a page. Structural geometry such as borders, icon viewboxes and viewport calculations can require literal dimensions; explain intentional exceptions affecting rhythm in the PR. Adding a genuinely missing token or shared pattern means updating the common source, relevant tests and this contract together. Routine choices within the contract do not require another user approval.

For example, a new collection page should use the common heading and scale:

```tsx
<WorkspacePageHeading title="Reports" description="Review your recent reports." />
```

```css
.reports-list {
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-panel);
  color: var(--color-text);
  background: var(--color-surface);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
```

### UI acceptance evidence

The Today workspace shares `HomeDialog` for native modal focus, scroll locking and focus restoration; pin actions and nickname settings use the same quiet secondary controls and labelled search fields from `home.css`. The home, quote and nickname patterns use the canonical type/spacing/radius scales, `--control-height` and `--page-gutter`. The native dialog retains `margin: auto` against the global reset. Dialog and reading-column maximum widths, responsive viewport breakpoints, line clamps and focus-outline geometry are structural measurements; their spacing and typography remain token driven. Briefing details reuse the common heading, Markdown source/link renderer and account/model picker, with a compact captured-report label and expandable supporting sections. Conversation briefing source rows wrap long nicknames with canonical gaps/gutters and quiet 44px actions; source rows and retry alerts each own their gutter, so nested errors never double the inset. All collection routes retain the shell-owned wordmark and navigation.

Every PR changing rendered UI records the shared components/tokens reused, intentional exceptions and validation results in the PR template's UI design section. Inspect changed screens on narrow mobile (including 320px) and desktop, light and dark themes, and representative alternate accents/fonts. Check loading, empty, error and populated states; long content and larger text; keyboard focus and accessible names; 44px touch targets; final-item scrolling and keyboard/safe-area behaviour when relevant. Provide screenshots or a specific visual inspection record. Update the offline browser fixtures to cover new routes and interactions rather than relying on the existing route list to test a new page automatically.

Ordinary mobile and desktop conversations share `ChatArea` and its `AgentActivity`
disclosure. They do not render an Outputs panel in the transcript or fetch
output/contributor state automatically. The explicit Collaborate action in
Workspace opens selected work in the shared `HomeDialog`; closing it stops reads
and returns focus to the trigger. Its host lives above responsive screens so a
viewport change does not discard the requested work view. Changing conversation
closes it. The dialog owns its gutter once; staged account/model fields occupy
the full form width instead of inheriting compact inline-chat geometry.
Nested `HomeDialog` cancellation remains in the top form, including while its
submission guard refuses dismissal. Shared scroll-lock owners restore the original
body overflow only after the last dialog closes, including simultaneous navigation
unmounts; closing one dialog cannot unlock another active dialog.

The work view reuses `OutputContributorPanel`, ordinary `AccountModelPicker`,
optional Library guidance, existing source/delivery/retry/Stop APIs and their
eligibility reasons. It does not enroll accounts, convert the parent chat or
establish the full standard runtime picker/owned-driver cutover. Existing native
conversations retain their separate history and controls. Offline checks cover
mobile/desktop layouts, light/dark and alternate appearance, lazy reads, empty
and failed work, nested dialogs, restored focus and the quiet parent transcript.

Run `npm run test:design` for the static contract. CI runs it in a named step as well as the full suite. Run `npm run test:ui` for rendered changes, with additional component/behaviour checks appropriate to the feature. Document inapplicable checks rather than silently omitting them. Reviewers evaluate design consistency alongside correctness.

The static guard catches defined source patterns; it is not a complete CSS/JavaScript analyser. It protects token ownership but does not yet ban every raw margin/padding value or prove visual quality. Spacing/layout consistency also relies on shared component reuse and review evidence. Browser checks verify specific geometry and behaviour; they are not pixel screenshot baselines. New styling mechanisms need corresponding guard coverage. Do not weaken tests or expand fixture exemptions to bypass the contract.

## Inbox collection pattern

Adviser subscription management reuses `HomeDialog` for focus, dismissal and scroll containment, and its shared secondary controls. It stays behind the existing account/model/thinking picker. Account rows and labelled fields use semantic colors, spacing/radius scales and `--control-height`; no separate palette, font or page masthead is introduced. The sign-in action explicitly identifies the Mac where the system browser opens. Offline tests cover collapsed controls, deliberate sign-in, supported thinking selection, reachable dialog actions and unchanged terminal input on phone and desktop in dark and light themes with alternate appearance preferences.

Inbox reuses the shared collection rows, full-content inspector, heading, icons and notification request controls. Its named views are Needs you, Briefings, Proposals, All and Archive. Source, Type, Status and Date are secondary refinements, with removable active filters. Technical provenance appears in expanded details. Search crosses named views; pagination and list/detail return preserve the query. The navigation badge counts unresolved actionable requests, not unread files. Archive is recoverable and remains separate from reading and resolution.

Inbox keeps a reading surface of at least three shared control heights on phones. If the heading and refinements exceed the available vertical space, the collection itself can scroll while its list remains usable. Check short native viewports and large text with body scrolling locked.

## Chat activity disclosure

Composer utilities use quiet shared icons, with their names available to assistive
technology. Commands uses the shared list icon instead of a text slash; its
hover/focus label uses semantic surface, type, spacing and radius tokens. Narrow
composers retain visible labels in the More menu. Visible glyphs stay small while
their unboxed targets retain `--control-height`; changing the control does not
replace the draft or change command selection.

User-message context uses `ContextInjectionDisclosure` beside the readable prompt.
Selected names appear with the optimistic send; the recorded echo supplies the
injected reference bodies without replacing the user's draft text. Complete legacy
context envelopes are projected into the same disclosure during history recovery;
recognizable nested delimiter examples preserve the full original prompt.
The content starts collapsed and stays collapsed as metadata arrives. Its toggle
uses `UiIcon`, semantic colors, shared type/spacing/radius tokens, a
`--control-height` target, `aria-expanded`, and `MotionPresence`. Source paths wrap;
long reference headings wrap without displacing the touch-sized copy action;
each reference has a separate copy action and a keyboard-scrollable plain-text
body. The body cap of `min(40dvh, 24rem)` is structural viewport geometry that keeps
large injections from expanding the whole chat. Editing, copying and read-aloud
operate on the user prompt; opening context does not start prompt editing.
The offline context-injection fixture exercises selection, the live echo, replay,
large content, narrow mobile and desktop, theme/accent/font substitution, keyboard
disclosure and reduced motion with no backend or provider.

`AgentActivity` groups consecutive normalized thought/tool blocks between responses, including across provider message boundaries. Its one-line latest-activity preview uses the shared type/spacing/radius scales, semantic muted/error colors, `UiIcon`, a `--control-height` button with visible focus and `aria-expanded`, and `MotionPresence` for details. Failure counts, including failures inside delegated agents, remain visible when collapsed. Delegated agents stay inside the same shared disclosure, with their total and running count in its preview; nested cards use shared disclosure motion. Existing tool/thought controls retain full detail, while approvals, progress, web-access results and deduplicated setup cards stay outside the disclosure. Group identity follows the session and captured seat/account generation. Activity and thought content start open and remain readable while awaiting a reply, including between provider messages and after tool completion. Visible text from the same speaker collapses preceding activity; another speaker's reply and a new user turn cannot complete it. Manual reopening after a reply persists through further updates. No timer collapses thought content within this group. Empty or whitespace-only text does not split activity. Automatic collapse returns keyboard focus from closing details to the header while preserving focus elsewhere, including the composer, with both normal and reduced motion. No provider or account selects a separate visual treatment.

## Terminal output layout

The terminal retains the shell-owned masthead and uses one compact toolbar for its title, current destination, adviser, controls disclosure and options. Adviser and destination details start collapsed, preserving most of the remaining mobile viewport for output. The command composer retains its 44px controls; duplicate destination/input captions and routine connected metadata do not occupy a separate row. Connected status remains available to assistive technology; errors and reconnection actions remain visible.

Use the shared motion presence helper for terminal disclosures and options without resetting drafts, account selections or subscriptions. A token-styled **Live output** action overlays the output only while history is being browsed. Swipe and wheel gestures operate on retained shell history, with labelled alternatives and an unconditional return-to-live action in Terminal options, including after navigation. Offline checks cover the compact layout, unchanged masthead, narrow phone widths, alternate appearance preferences, keyboard behaviour, output movement and return to live output without shell input. The sr-only clipping geometry and bounded popover width are structural exceptions; spacing, type, colors and control heights use shared tokens.

## Ordinary chat Access

`WorkspaceControls` accepts always-visible actions alongside its collapsed summary.
Access uses this slot on mobile and desktop so pending approval overlays cannot cover
its entry. Its read-only observation and nested Connections view reuse `HomeDialog`,
Connections grouped rows/facts, `UiIcon` and shared tokens. Returning leaves the
composer mounted. Unknown availability and stale observations remain explicit; viewing
Access cannot authorize a tool or start a session.

On phones the Workspace summary truncates long text while its accessible name keeps
the full account/model details. The expanded settings panel measures the space before launch actions or the composer and
scrolls within that space. When desktop flow cannot fit the fixed header, Done action
and a settings row, it switches to the same bounded overlay used on phones. The
overlay may overlap part of a tall composer and remains above visible navigation
and the chat/desktop center's clipping boundary, including its separate status row.
Closing it restores access to the retained draft.
The settings body owns scrolling between those actions. A 60dvh cap is
the fallback before measurement, bounded by the viewport. These bounds are structural overlay geometry;
colors, type, spacing and controls remain shared.

## Draft image preview and drawing

The shared composer opens draft images from its thumbnail strip and Sources drawer
through `ImageAttachmentEditor`. The editor extends `HomeDialog` with a fullscreen
class, retaining native modal focus, Escape dismissal, scroll locking and focus
restoration. This interaction uses the same attachment state for every runtime.

Keep preview selection separate from the labelled removal button: the image is a
preview action, and its remove control has a distinct 44px target at the corner.
Composer thumbnails use shared control/spacing tokens and are slightly larger than
the prior 64px treatment. Drawer rows expose the same preview action without
nesting the remove button inside it.

The fullscreen surface uses semantic background/text/border colors, shared type,
spacing and radius tokens, and the device safe areas. Drawing tools use `UiIcon`
and labelled controls for Draw, Undo, Clear and pen color. Toolbars wrap or scroll
within narrow and larger-text viewports; no action can fall below the safe area.
Canvas dimensions follow the image aspect ratio, and pointer positions map to the
original pixels rather than the displayed size. This is structural image geometry,
not a new spacing or palette scale.

Drawing remains a local draft until Save image exports a PNG attachment. Closing
or cancelling preserves the original image and message text. Apply changes by
attachment identity within the current conversation; removing that attachment or
switching conversations must invalidate an outstanding edit. Preview keyboard
input cannot submit or interrupt the chat behind the modal. Offline component
and browser checks cover these behaviors across runtimes, mobile and desktop,
light/dark themes, alternate appearance preferences and larger text.

Offline acceptance captures show [the larger composer thumbnail and separate
removal control](assets/image-composer-mobile-dark.png), [drawing on a narrow
phone with larger text and alternate appearance](assets/image-drawing-mobile-light.png),
and [the full-screen desktop preview](assets/image-preview-desktop-dark.png).
The intercepted browser fixture checks saved PNG pixels and the exact attachment
bytes submitted across four runtime bindings on mobile WebKit, mobile Chromium
and desktop Chromium, without backend or provider calls.

## Approval cards

`PermissionBanner` uses a quiet token-styled surface and compact outlined
44px actions in one row. Allow once, Allow for session and Deny remain explicit; durable
integration grants keep their existing conversation label alongside session
retention. The server supplies the human scope explanation when available.
Request details start open in a native labelled disclosure with `UiIcon`,
keeping full long input accessible and collapsible. Visible Once, Session and Deny
labels retain full accessible action names. Shared CSS
entrance motion remains in effect. The card body scrolls independently while
its decision row stays reachable on narrow phones and with larger text.

Structured questions retain their choices and written answer fields, Send answer
and Cancel. They do not offer session authorization. Response progress disables
duplicate decisions; errors retain the card and allow retry. Local expiry removes
the card without submitting a user denial; the server owns timeout resolution.
Inbox request details use the same quiet action labels and server-owned scope
caption, with Allow for session available for each authorization and no retention
for questions. Native notification actions revalidate displayed input and scope;
the Watch rechecks the complete reviewed request through its authenticated phone
relay before submitting a session decision. Ordinary Watch chat uses a quiet
44px Review request entry into that same complete review surface; it never
approves from a truncated preview. A successful or expired review clears only
the matching pending card, preserving a newer request. Watch questions expose
Cancel and direct answers to the full iPhone form.

Offline approval fixtures cover 320px mobile WebKit/Chromium and desktop Chromium,
light/dark themes, Mint/Georgia appearance, larger text, long request details,
keyboard focus and 44px controls without a backend or model call.

Reviewed Telos mutations use the same ordinary `PermissionBanner` on desktop and
mobile, selected only by the host's `reviewKind` marker. Request details contains
whole completed public messages and retained material revisions, with no initial
selection. The exact compiled source text, boundary, brief and version pins remain
inspectable before Once saves that packet. Changing a selection invalidates its
preview. This request offers Once and Deny; a session allowance cannot approve
unseen future source selections. Other tools retain their existing scope/actions.
The source controls reuse shared fieldsets, semantic tokens, normal disclosure
and the card's independently scrolling body with reachable 44px decisions. Late
reads are fenced to the request/session/login. An uncertain save locks its exact
request for recovery, even when the pending card resolves before its HTTP reply.
Only the host can replay a prepared save as a recovery card. It restores its
original packet after an authenticated read and offers Retry same save and
Dismiss. Recovery continues that reviewed attempt; Dismiss neither undoes an
uncertain item save nor discards its retained evidence. A fresh approval still
uses its original deadline, explicit selection, Once and Deny. Source context and
the proposed brief stay hidden until authentication is rechecked and clear on
authentication loss. Retained source text wraps beside bounded native checkboxes;
labels and decisions keep the shared touch target while the card body scrolls.
Save to Telos leads with one structured brief in the existing Outcome, Why this
matters, Done when and Milestones language. Source text, actual author/date and
material title/revision/source lead the review; raw proposals, IDs, hashes and
native generation/configuration proof stay under a closed Source details
disclosure. Missing native provenance does not create unknown seat/configuration
rows. Ordinary tools keep their original heading, raw request and scope controls.

## Artefact sharing links

Markdown Telos artefact links reuse `FileShareLink` and a compact file-options
surface. Ordinary file links retain their primary in-app opening action and one
quiet options trigger; previews group Open, Download and Share behind that same
trigger. Telos filenames open their read-only saved revision inside Files and retain one
quiet options trigger, following the same pattern as ordinary files. Choices appear only on request using `HomeDialog`, its focus/scroll
ownership, shared control-height targets and motion-presence helper. The action
state stays with the trigger so closing/reopening cannot duplicate a pending
operation. Successful actions dismiss the options and restore focus. A returning composer
only takes initial focus when no other control owns it. On iOS, the system Share sheet also offers Save to Files. The offline
artefact fixture checks compact closed controls, revealed choices, Escape/focus
restoration, exact revision and original bytes across mobile/desktop appearances.

## Agent profile draft cards

Pending profile proposals appear after the transcript inside the existing ChatArea
scroll surface, even with Workspace closed. Empty drafts and manual seat drafting
remain available through Workspace. The cards reuse SymposiumProfileProposals, its
labelled controls, shared profile styles and semantic tokens. New proposals receive
an opaque generated ID; users edit the agent's name and guidance. Internal role and reviewer recipe controls
are available under the native **Advanced profile settings** disclosure. Explicit Save
confirms the profile is in the Agent Library and provides a Library link. Editing
never saves automatically. Offline fixtures cover direct save, empty/error states,
long instructions, keyboard activation, 320px/390px mobile and desktop, dark/light
themes and alternate accent/font preferences.

## Google Workspace policy status

`GoogleWorkspaceControls` retains the existing Connections surface and controls,
shared tokens and focus behavior. Copy distinguishes Docs authoring, legacy
read-only Docs access, and unavailable Docs policy evidence; credential readiness
remains a separate status. It exposes no new write toggle. The inventory lists
Docs editing only when the effective policy was checked.

Isolated, fully intercepted component views were inspected on 320px mobile WebKit
with Dark/Mint/Georgia and 1280px desktop Chromium with Light/Teal/System for
enabled, legacy and unknown Docs policy. They preserve keyboard focus without
horizontal overflow. Captures show [mobile Docs authoring](assets/google-docs-mobile-dark.png)
and [desktop legacy Docs access](assets/google-docs-desktop-light.png). These
component checks use no backend, credential, or model. The full-app offline fixture
also covers enabled and legacy policy on mobile WebKit/Chromium and desktop
Chromium; broad build/browser acceptance runs in CI when local memory pressure
prevents the full suite.

## Historical explicit Local first-command selection

This section records the guarded first-command checkpoint. The current ordinary
conversation contract above applies to qualified continuation routes; these limits
remain the fallback for unsupported or unqualified scopes.

The gated ordinary-chat entry extends the existing Workspace disclosure and
account/profile pickers with controlled metadata and Run on. It uses native labelled
selects, existing account-model fields and chat-agent-profile styles; color, spacing,
type, radii, control heights, focus and disclosure motion remain shared. It adds no
page theme. An untouched enrolled draft retains OpenShell; unavailable choices
retain their labels and reasons. Explicit Local uses a separate strict first-command
HTTP route while existing event-stream transcript and permission handling stay shared.
Configuration metadata never establishes runtime readiness. The shared settings
disclosure scrolls within the remaining space after repository and composer controls
on desktop, with a viewport cap. Its mobile overlay stops before
the first repository or launch action and updates when that action appears, retaining
keyboard focus and the existing disclosure motion.

Mobile and desktop write the same account/profile/target/capability intent into
saved drafts. Model/thinking and published revisions are never silently replaced
when unavailable. Local requires a prepared repository, a published agent and the
original permission policy. It disables unsupported context additions, command
pickers, worktree toggles, web grants and subsequent sends; attached context remains
removable without deleting draft text or images. Bound conversations display the
Local first-command limit on reload and keep account/profile/runtime choices fixed.
Unknown conversation metadata also blocks helper starts and context/model/mode/profile
mutations until Retry resolves its binding. A recovered Local binding shows First command
without inferring account readiness. On phones the status uses a shrinking grid column
and an 8ch structural cap beside the always-reachable Access action; its full text stays
in the accessible description and tooltip. Readonly findings, history and safe Stop
remain available; review action controls stay disabled.
Persisted account/model/thinking hydration remains separate from user edits, so
metadata arriving before the runtime check still supplies the actual conversation
settings without replacing device defaults. Running Local conversations expose Stop
and retain follow-up drafts and existing queues, while queue creation and draining
remain blocked. The composer validates the complete command envelope, including
UTF8 metadata and attachments, and explains removal/resizing when it exceeds 1 MiB.
Recovery shows the original command tuple and resends its retained envelope only
on a deliberate operator action. Authentication restoration does not replay it.

The intercepted Local browser fixture covers review, preparation, immutable POST,
bound settings and disabled-gate draft restoration on mobile and desktop in light
and dark appearance with alternate accent/font settings. Screenshot evidence goes
to the Playwright artifact output paths for review. Component/hook/client regressions
require no backend, credential, native provider or model. Rendered browser acceptance
and inspection remain required in hosted CI when local memory pressure precludes
building or browser execution; fixture presence alone is not visual acceptance.

## Approved Agent settings fidelity checkpoint

The earlier composer mock `mitzo-agent-picker.html` in the runtime separation
handover is superseded by the single top disclosure described above. Source implementation and behavioral qualification are separate from
rendered fidelity. The hosted offline runtime fixtures now target the approved
composer hierarchy, card descriptions, dismissal/focus, retained images and
settings, bounded internal scrolling at 390 × 844 and 320 × 740 with larger
text, and desktop light/dark Mint/Georgia with Reduce Motion. Final current-head
hosted screenshots, visual inspection and independent acceptance remain pending;
this source checkpoint is not a claim that the approved layout has passed.

### Explicit collaboration control inspection

The isolated actual collaboration controls were inspected offline in 320px mobile
WebKit and 1280px desktop Chromium, dark/light themes, Mint/System and
Teal/Georgia. Checks cover bounded dialog geometry, full-width staged account
fields, nested dialog dismissal and focus restoration. Captures show
[mobile selected work](assets/collaboration-entry-mobile-dark.png),
[desktop selected work](assets/collaboration-entry-desktop-light.png) and
[mobile contributor setup](assets/collaboration-add-mobile.png).
The isolated inspection omits the application shell. The all-intercept app
fixture separately covers lazy work reads, ordinary account selection, exact
output/digest submission, empty/error/retry and the quiet transcript; hosted
`npm run test:ui` remains required CI evidence. No backend or model is used.

## Single conversation settings verification

Focused offline browser checks render the actual WorkspaceControls and shared
agent fields on 390px/320px mobile WebKit and mobile/desktop Chromium in dark/light
appearance with Mint/Georgia and Reduce Motion. They check a closed initial state,
outside interaction, Escape and focus, retained selections and message text,
secondary disclosure, 44px fields, narrow viewport bounds and typing navigation.
They start no backend or model. Page regressions separately verify that settings
are mounted only in the top disclosure, including prepared and saved drafts.
Full-app `npm run test:ui` remains CI acceptance; isolated component captures do
not establish acceptance of unrelated routes or native keyboard behavior.

Component captures show the [clear mobile composer](assets/chat-settings-mobile-dark.png)
and [desktop settings disclosure](assets/chat-settings-desktop-light.png). The
[short mobile capture](assets/chat-settings-short-mobile-dark.png) verifies reachable
settings and fixed actions over a tall draft. The same fallback is checked inside
the real DesktopShell at 300px height, with its separate status row, in the
[short desktop capture](assets/chat-settings-short-desktop-light.png). Existing mobile
conversations retain their full account/agent/model/thinking/execution/workspace
details in this top panel, including legacy conversations without a runtime binding.

## Approved conversation composition

Conversation chrome keeps Account, Model and Thinking first in the single top
settings disclosure, followed by Agent and Repository. Run on is a primary field in the approved compact popover; repository preparation
retains its account-bound controls, and session details stay on request. Repository keeps the existing account-bound catalogue,
preview and preparation flow; it does not accept an arbitrary unverified checkout.
The ordinary collaboration entry stays beside Resources in the composer. Unsupported
Terminal and collaboration actions explain their unavailable state rather than
opening a runtime they cannot control. Send, queue, interrupt and command actions
use distinct shared UiIcon shapes and accessible names.

Settings group headings, Access, Resources, the welcome wordmark and selection
accents all resolve the Settings appearance picker's `--color-accent`. Semantic
warning/error/status colors keep their existing roles. There is no second chat
palette. OpenShell and GitHub marks are monochrome masks using currentColor,
from the official [OpenShell brand asset](https://github.com/NVIDIA/OpenShell/blob/main/docs/brand/assets/openshell-mark-mono-white.svg)
and [GitHub Octicons](https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg).

Resources uses the shared native HomeDialog with Sources, Context, Outputs and
References tabs. Sources preserves submitted context content when recorded;
Context includes reviewable boot/session context and selected next-prompt blocks.
Outputs only lists registered session outputs. References retains multiple roles
for the same URL (shared by you, found during research, linked by the agent,
created by the agent, workspace), groups by website, and pages eight groups/links
at a time. Search, category, scroll position and opener focus survive a detail
view. PR state comes only from a successful structured publication snapshot;
checks/reviews remain unreported without evidence, with no background polling.

The usage wheel distinguishes current model occupancy from cumulative request
usage and shows user turns, agent requests and compactions. Positioned compaction
markers and Context history share a detail view. The durable lifecycle endpoint
reads bounded compaction events, not the transcript, and refreshes on lifecycle
changes. Exact condensed ranges, retained summaries or token figures remain
explicitly unavailable when the adapter did not report them. If execution ends
during compaction, its marker records interruption or an unknown outcome, clears
the active wheel state, and never claims successful context reduction. Historical sessions
can have counts without positioned records. Access likewise explains Unknown
when the selected runtime cannot report live access evidence.

Access uses provider-independent Unknown guidance: configured accounts and
services do not establish live access. The runtime-readiness foundation expands
session identity and permission observations across ordinary provider families;
unmeasured commands, attachments and service operations remain unknown. The copy
reuses the existing HomeDialog, muted text and token-based cards without changing
controls, layout or motion. Focus restoration, scrolling, overflow and the changed
paragraph were checked in isolated actual-component Chromium renders at 320px and
1280px, light/dark themes, Teal/Georgia and Lavender/System. Captures show the
[mobile light dialog](assets/runtime-readiness-access-mobile-light.png) and
[desktop dark dialog](assets/runtime-readiness-access-desktop-dark.png).
The full intercepted browser fixture also covers this state; complete application
build/browser acceptance remains a CI check. The local complete frontend bundle
exceeded the required 1 GiB heap; isolated renders and unit/design checks passed.

Offline checks render actual shared controls on mobile WebKit/Chromium and desktop
Chromium, with light/dark appearance, Mint/Teal accents, Georgia and Reduce Motion.
They cover word-by-word italic live transcription, command insertion without draft
loss, nested boot review, PR back navigation, bounded references, compaction
position/evidence and composer placement. Captures show the
[mobile conversation](assets/approved-chat-mobile-dark.png),
[accent-aware settings](assets/approved-chat-settings-teal.png) and
[desktop context](assets/approved-chat-context-desktop-light.png).
These are intercepted fixtures; no backend, model or production service is used.

## Saved contextual launch ownership

Unsent briefing, meeting preparation, Work and Inbox launches are saved device drafts
before navigation. Their exact prompt, source snapshot and selected account belong to
that draft URL. New chat and opening another conversation release the active launch,
so its briefing header, launch panel and composer guidance cannot follow the user.
Drafts restores that launch only when its own record is opened. Acceptance consumes
only the submitted draft revision; failed sends keep it, and outstanding sends stay
locked across reloads when their draft is reopened, using the original command ID.
Briefing and generic launch commands share durable recovery across tab replacement;
each remains a separate new conversation even after a client restarts.
Generic launch drafts retain account/model edits; acceptance preserves unsent
follow-up text as a separate draft, including pending composer saves. These changes reuse existing draft rows,
conversation controls and briefing surfaces without new styling or motion.

Offline launch regressions passed on mobile WebKit and mobile/desktop Chromium
in dark/light appearance with Mint/Georgia. Inspected captures show the
[fresh mobile chat](assets/fresh-chat-mobile-dark.png) and
[fresh desktop chat](assets/fresh-chat-desktop-light.png), with briefing chrome
restored only through the saved draft. No backend or model is used.

## Agent creation advisor

The Agent Library workbench stacks its advisor above the existing profile editor,
including on mobile. New agent creation expands the panel; the labelled disclosure
uses `useMotionPresence` to retain the conversation, question and picker on collapse.
It reuses `AccountModelPicker` in adviser scope, `UiIcon`, the existing profile form,
semantic colors, UI/mono fonts, spacing/radius scales and 44px control targets.
The conversation has a bounded, keyboard-scrollable log. Proposed profiles expose
review details and an explicit apply action before the ordinary Save draft and
Publish revision actions. Stale proposals cannot replace newer form edits.

Offline Agent Library fixtures exercise advisor success/error, explicit selection,
form application and draft recovery, keyboard focus, long content and scrolling,
320px mobile and desktop layouts, light/dark themes and Teal/Georgia appearance.
The ordinary Agent Builder chat profile retains its separate namespace fixture.

Inspected captures show [new agent creation on mobile](assets/agent-creation-mobile-dark.png)
and [the desktop advisor above the profile form](assets/agent-creation-desktop-light.png).
These are fully intercepted fixtures; no live model, backend or production service
was used.

## Agent Library tasks and shared settings

Agent Library extends its existing profile workbench with Profiles and Tasks &
schedules, plus Assigned tasks within profile detail. Use in session delegates to
ordinary setup with the selected immutable revision. Assign task retains an exact
published binding. The full editor, context, import/export and history remain;
Symposium selection stays inside a session.

Task setup uses AgentSettingsPicker, controlled AccountModelPicker and
ChatExecutionPicker with the ordinary runtime catalog. Its retained selection is
separate from advisor and session defaults. The shared panel measures its own
available space outside chat, keeps fields mounted when closed, scrolls internally,
and restores trigger focus on Escape/Done. Library actions use quiet outlined or
soft surfaces; type, spacing, radius, focus and touch heights use shared tokens.
Collection/profile tabs support arrow keys and Home/End. No palette, font or motion
scale is added. Existing shell and panel bounds remain structural geometry.

Task input stays recoverable through navigation, refresh and failed/conflicting
writes. Paused schedule intent and unavailable execution/history/next-run state
remain explicit. Offline fixtures cover 320px phones and desktop, light/dark,
alternate accents/fonts, larger text, keyboard focus and exact retry requests.
Isolated actual-page renders include MobileShell/DesktopShell and shared controls;
full-app offline acceptance remains the hosted CI test:ui gate.

Inspected captures show [mobile task settings](assets/agent-task-settings-mobile-dark.png),
[desktop task settings](assets/agent-task-settings-desktop-light.png) and
[the mobile assigned-task collection](assets/agent-tasks-mobile-light.png).
They render the actual page, shells and controls using intercepted data only.
The 320px settings body scrolls while Close/Done remain reachable above navigation;
Escape restores summary focus. Save failure/reload retries retain identical input,
profile ID/revision/hash, selected account, model/thinking and target.

Task-local working copies also retain incomplete model choices when another task
is opened. A newer saved task revision leaves those choices intact until explicit
Reload saved task; catalog hydration/review changes no task revision or retry key.
Native task selects reuse the context editor's explicit token-based height because
WebKit ignores their minimum height; offline geometry checks require 44px targets.

## Session library and context summaries

Today pins outside the recent page read their recorded observation by session ID, without resuming a provider. Disabled context display makes no extra reads; obsolete requests abort, and missing or failed observations remain explicitly unavailable. Confirmed deletion clears the selected preview, and a confirmed rename updates off-page pin snapshots and the selected title. Failed mutations preserve the saved selection and title.

Today renders the latest recorded context observation separately from cumulative
request usage. A measured count without current model-capacity evidence keeps its
limit explicitly unreported; absent counts never become zero and stale capacity evidence never establishes a
percentage. Session pins and recent sessions share `SessionContextUsage`. The
visibility switch lives in Settings → Appearance, retains the existing device
preference key, and propagates across mounted views and browser tabs.

The library reuses `DesktopShell`, `MobileShell`, `UiIcon`, `HomeDialog`, shared
motion presence and semantic palette/type/spacing/radius tokens. `SessionActions`
provides the same full-width icon rows in the mobile history sheet and the web
context menu, including the separate conversation and Today pin actions. The
context menu supports right-click, Shift+F10, arrows, Home/End and Escape with
focus restoration; the mobile sheet retains the 500ms hold and cancels on movement.

`ConversationPins` is shared by Chats and the desktop chat sidebar. Device pins
retain a title for sessions outside the loaded page, with up to four rows visible
and additional pins scrolling inside the group; collapse state persists. Main list
titles wrap fully. Sidebar/pin rows retain bounded titles with the full title in
their accessible name and saved-history reader. Deleting histories removes device
shortcuts only after the server accepts deletion.

Desktop Chats uses the available width with a saved-history inspector. The
labelled vertical separator supports pointer drag and keyboard adjustment, retaining
a 26–52% preview width. History reads are abortable and selection-fenced, show only
saved user/assistant text and never attach or resume a provider. Repository paths,
branches, IDs and cumulative usage live in details. A work link requires an exact
recorded `telosTaskId`; a repeated folder name is not a task association.

Desktop conversations keep the conversation sidebar on the left and the command
center (Telos/tasks) on the right, collapsed by default. In Chats, a single click
previews a recent, pinned or search-result conversation; a double-click opens it.
Enter or Space on a recent/search row opens it directly. Row action buttons keep
their separate behavior. Mobile continues to open with one tap and uses its
existing long-press preview/actions. The shared iOS UI ships in the separately
built Capacitor bundle; deploying the web app does not update an installed app.

Mobile details retain cumulative token usage, including recorded zero totals;
unknown totals remain absent. This uses the existing muted detail text and compact
formatter, separately from context occupancy.

The mobile history sheet bounds its reader and keeps its action group on screen;
long headings/details remain scrollable. Geometry exceptions are the separator's
1px rule and 3px grip/meter, its percentage bounds, and viewport-constrained scroll
areas. Colors, typography, action rhythm and radii stay on the shared scale. The
token guard now rejects undefined session-library scale references.

The focused offline fixture mounts the production list, sidebar, shells, Today and
Appearance components with intercepted traffic. It passed mobile WebKit,
mobile Chromium and desktop Chromium in dark Mint/Georgia and light Blue/Arial,
including 320px overflow, long titles, four visible pins plus overflow, collapse,
long press, right-click, resize, keyboard dismissal and the Appearance preference.
Unit regressions cover touch cancellation/tap suppression, empty/error/loading
history, stale selection, pin persistence and missing/stale context limits.
No backend, provider turn or model call was used. This is component-route evidence;
full app integration remains with CI. Canonical staging and its pipeline are stood down; this work performs no deployment.

Inspected captures: [desktop library](assets/session-library-desktop-dark.png),
[light desktop](assets/session-library-desktop-light.png),
[mobile library](assets/session-library-mobile-dark.png),
[mobile history/actions](assets/session-preview-mobile-light.png),
[mobile cumulative usage](assets/session-preview-usage-mobile-light.png),
[desktop Today context](assets/session-context-desktop-dark.png),
[mobile Today context](assets/session-context-mobile-dark.png) and
[Appearance preference](assets/session-appearance-desktop-light.png).

Local validation: 267 focused unit regressions, the design contract and six browser
scenarios (plus two browser startup checks) pass, along with frontend type checking,
workspace package builds and 152 route tests. Full frontend build and broad server
type checking exceeded the required 1 GiB local heap; those checks are deferred to
CI without increasing the local limit. No production or staging changes were made.

## Agent tool selection

Agent Library keeps its advisor above the editor. The Tools tab and Tool library
view reuse the existing collection heading, tabs, form controls and grouped quiet
rows. The inline picker uses MotionPresence, labelled search and Add/Remove
actions, Escape/Done focus return and the existing control-height touch targets.
Colors, type, spacing, focus and radii come from tokens.css. Compatibility and
connection requirements are visible beside each tool; selection does not grant
access. Offline Agent Library fixtures cover selection recovery, publication,
exports, usage references and the picker at 320px and desktop across light/dark
themes with Lavender/System and Teal/Georgia.

Focused actual-page tool selection checks passed on mobile WebKit/Chromium at
320px and desktop Chromium at 1280px, dark/light with Lavender/System and
Teal/Georgia. The fixture verifies keyboard Escape/focus return, 44px touch
actions, search, removal, recovery, publication/export, usage references and
catalog error/retry. Inspected captures show [mobile selection](assets/agent-tools-mobile-dark.png),
[desktop selection](assets/agent-tools-desktop-light.png),
[mobile tool browsing](assets/tool-library-mobile-light.png) and
[desktop tool browsing](assets/tool-library-desktop-dark.png). These isolate the
actual page from the shell, use a fixture checked against the real registrations,
and start no backend or model. Full-app fixtures remain a separate CI gate.

The Tool library keeps profile creation actions in the Agent library view. Profile
usage remains unavailable while its catalog loads or fails; the shared status and
error patterns show loading or an explicit Retry profiles action before usage
references or an empty result appear. The actual-page offline review fixture
`tests/offline/agent-tool-library-review.spec.ts` covers pending, failed, retried,
referenced and unreferenced states on 320px mobile WebKit/Chromium and 1280px
desktop Chromium in both themes, Lavender/System and Teal/Georgia. Inspected
captures show the [mobile profile usage error and retry](assets/tool-library-profile-error-mobile.png)
and [desktop profile usage loading state](assets/tool-library-profile-loading-desktop.png).
These isolated renders use intercepted requests and no backend or model. The
full-app Agent Library fixture retains its separate CI acceptance journey.

## Sandbox controls

More → Sandboxes uses `WorkspacePageHeading`, `MobileShell`/`DesktopShell`,
`UiIcon`, `EmptyState`, grouped Connections rows/fields, `HomeDialog`, shared
secondary controls and disclosure motion. Settings use Save/Cancel with retained
failed drafts and a revision fence. CPU/memory resource controls inherit shared
type, spacing, radius and control-height tokens. WebKit selects use that token as
an explicit height as well as a minimum; the native appearance remains intact.
Disk stays visibly unavailable when the native adapter cannot enforce its limit.

Spare details keep provider/account unassigned; conversation cleanup retains the
existing ownership, checkpoint and retention policies. Failed actions remain
visible inside the active dialog. Late cleanup previews are fenced to their
selected conversation. Opening inventory cannot allocate a sandbox or start a
model. The page has no private palette, font, wordmark or navigation height.

The fully intercepted sandbox fixture verifies configuration, refusal/confirmation,
More navigation, modal dismissal, long titles, final-row access, 44px touch targets
and bounded scrolling at 320px mobile WebKit/Chromium and 1280px desktop Chromium,
in dark Mint/System and light Teal/Georgia with larger text. Inspected captures:
[mobile dark](assets/sandbox-controls-mobile-dark.png),
[mobile light](assets/sandbox-controls-mobile-light.png),
[desktop dark](assets/sandbox-controls-desktop-dark.png) and
[desktop light](assets/sandbox-controls-desktop-light.png).
These are mocked component-route checks; native runtime qualification and full-app
build/browser acceptance remain separate. See the
[pool operating contract](../operations/openshell-warm-pool.md).

## Tool catalog browsing

Tool browsing uses the shared `ToolLibraryCatalog` collection component. Quiet
cards lead with a category icon, tool name, a two-line description and behavior
badges. Required tools and unavailable explicit selections remain visible.
Native Details disclosures retain the full description, version, runtime,
permission requirements and profile references. Search and Category combine,
announce result counts, offer an explicit empty state and Clear filters, and
survive switching between library views. Profile usage loading/error/retry
remains separate from an unused profile result.

The component reuses `UiIcon`, `EmptyState`, the collection heading and existing
labelled form controls, shared semantic colors, type/spacing/radius scales,
`--control-height`, focus styles and native disclosure motion. The 22rem grid
minimum is structural responsive card geometry, bounded to the available width;
two-line clamping is a list preview with the complete text in Details.

Offline actual-page acceptance checks 28 registered tools on 320px WebKit and
Chromium phones and 1280px desktop Chromium, dark Lavender/System and light
Teal/Georgia. Checks cover category/search combinations, no results/reset,
keyboard disclosure, 44px controls, retained filters, usage loading/failure/retry,
profile references, larger text and final-card scrolling. The existing profile
selection/recovery/publish/export fixture remains covered. Inspected captures show
[mobile dark cards](assets/tool-library-cards-mobile-dark.png),
[mobile light cards](assets/tool-library-cards-mobile-light.png),
[desktop light cards](assets/tool-library-cards-desktop-light.png) and
[desktop dark cards](assets/tool-library-cards-desktop-dark.png).
These fixtures intercept all traffic and start no backend or model. Component
checks, the design guard, frontend type checking and focused lint pass. The full
`test:ui` command passed package/frontend type checking but its production Vite
build exceeded the required 1 GiB local heap; full app build acceptance remains
with CI. Shell-owned masthead/safe-area behavior is unchanged; these focused
captures isolate the actual page without the shell. No deployment is performed.

Configured stdio discovery extends this same card collection and editor. The
explicit Refresh configured servers action uses existing compact actions, status,
error/retry and cancel controls; reading the page starts no server. Source names
distinguish duplicate tool names in cards and accessible Add controls. Details
show unavailable-source reasons and new-session guidance. Discovery never changes
an editor's selected receipt or a published revision.

The intercepted `configured-tool-selection.spec.ts` actual-page matrix covers
refresh failure/retry/loading, duplicate sources, category filtering, keyboard
Escape/focus, publication and portable revision export in mobile WebKit/Chromium
at 320px and desktop Chromium at 1280px, both themes, Lavender/System and
Teal/Georgia. Six page checks plus two startup checks pass with one worker.
Inspected captures: [mobile dark](assets/configured-tools-mobile-dark.png),
[mobile light](assets/configured-tools-mobile-light.png),
[desktop dark](assets/configured-tools-desktop-dark.png),
[desktop light](assets/configured-tools-desktop-light.png). These isolated actual
page renders omit shell-owned navigation; full-app checks remain a separate CI
gate. No new CSS, palette, motion or layout scale is introduced.

Verified obsolete warm spares retain Replace, confirmed Remove and Recheck in the
existing Sandboxes `HomeDialog`, including paused and manual pools. The server's
fresh retirement capability is independent of recipe compatibility; unknown or
unsettled physical ownership exposes only Recheck. These controls reuse existing
secondary/destructive buttons and shared focus, spacing and motion. Facts stack label above value on mobile and retain the existing desktop grid,
keeping larger type readable. Offline rendered checks cover
320px mobile WebKit/Chromium and 1280px desktop Chromium, dark Mint/System and light
Teal/Georgia with larger text, desktop tab navigation, mobile focus/touch targets,
confirmation, failure preservation and replacement. Captures show
[mobile dark](assets/sandbox-obsolete-mobile-dark.png),
[mobile light](assets/sandbox-obsolete-mobile-light.png),
[desktop dark](assets/sandbox-obsolete-desktop-dark.png) and
[desktop light](assets/sandbox-obsolete-desktop-light.png).

## Symposium participant presentation

The shared `ConversationAgents` surface follows the approved fresh-agent mock:
compact participant header, one Agents dialog, inline Reads future discussion /
Replies by default, a separate read-only conversation preview, and fresh Add agent
setup. `HomeDialog`, `useMotionPresence`, `UiIcon`, ordinary account/profile fields
and shared color/type/spacing/radius/control-height tokens own its presentation.
The dialog body scrolls independently of the heading/footer; narrow participant
names truncate instead of increasing header height. Checkbox/radio geometry is
explicitly bounded so the shared full-width input rule cannot push labels offscreen.

Ordinary chat retains its actual `ChatInput`, voice, attachments, commands, resources,
queue and lifecycle controls. `ComposerResponders` adds an explicit stable-ID @
selection without replacing that input. The retained native adapter also renders
`ChatInput`, but keeps text-only single-recipient approval and its original Stop /
uncertainty ownership. It does not acquire ordinary dispatch or multi-recipient
support through this presentation change. Existing native settings remain on request.

Policy changes require an actual supplied owner. Fresh setup uses the ordinary
catalog and retains editable intent; its review action stays disabled without
trusted source/capacity/preparation composition. No preview content is represented
as a frozen server review. Exact artifact selection, joining-brief confirmation,
ordinary allocation/delivery and full shared-conversation composition remain later
integration work. Opening setup and previews does not call a model.

The all-intercept `symposium-approved-design` fixture renders the actual mobile /
desktop chat screens with simulated data. It checks WebKit, mobile Chromium and
desktop Chromium, 320/390/1280px, light/dark, Mint/Georgia and Teal/System,
body overflow, reachable footers, separate recipient drafts and history previews.
The fixture-only preview banner is hidden during captures so it cannot cover the
actual header. Captures are UI evidence, not live admission or provider qualification.

Inspected captures: [mobile conversation](assets/symposium-conversation-mobile-dark.png),
[mobile Agents](assets/symposium-agents-mobile-dark.png), and
[desktop fresh setup](assets/symposium-setup-desktop-light.png).

Native excerpt sharing remains in Message actions, guarded by exact source identity /
membership generation and explicit recipients. Agent Details retains reusable-profile
drafting through its original owner. Opening either action does not deliver context
or grant account access. Retained native conversations direct fresh-agent setup to a
new ordinary chat; no existing history or provider thread is moved.

The integrated retained transcript shows speaker and role first. Its native Message details disclosure preserves the exact historical account/model/thinking/artifact provenance on request; it never substitutes the agent's current settings for a past reply.

Agents and Share excerpt use the established portalled-dialog motion pattern: `useMotionPresence` retains the dialog body for exit, while `HomeDialog.inactive` immediately removes the closing portal from interaction and accessibility. The Agents opener receives focus explicitly so WebKit can restore it after a pointer-opened dialog closes.

Retained recipient selection is locked while its queue receipt is pending, keeping the submitting shared composer mounted. A confirmed receipt clears only the submitted draft; edits made meanwhile remain. Read-only agent previews include both authored replies and that agent's delivered prompts/excerpts with their original receipt states.

## Compact chat settings (16 October 2026)

The approved compact popover supersedes the earlier full-width settings layout.
It reuses WorkspaceControls, AgentSettingsFields, the real account/model/agent
pickers and ChatExecutionPicker. Account and Model/Thinking come first, followed
by Agent and the two OpenShell/Local Mac controls. Repository preparation retains its existing
account-bound controls. The original monochrome
OpenShell asset stays visible. Existing account confirmation, repository locks
and bound-runtime rules remain authoritative; display changes grant no capability.
The 24rem popover width is structural component geometry, bounded by shared page
gutters. Its opaque surface uses the common tokens, with one scrolling body and
reachable close/Done controls. Short-screen bounds are measured in rendered pixels.
Settings motion uses the shared popover presence and retains the mounted fields.
The trigger’s accessible name includes its visible Settings label and selected context.

The 17 October restoration brings back the earlier approved **Account & model**
and **Agent & workspace** groups and accent-colored heading from
[the retained approved design](assets/approved-chat-settings-teal.png).
The compact popover geometry, full-width composer and primary Run on controls
remain in place. Account defaults, clear-default and model refresh live in the
closed **Account options** disclosure; required account confirmation and catalog
warnings remain visible. This reuses `chat-settings-group`,
`chat-settings-advanced`, `UiIcon` and the existing semantic/spacing/type tokens.
Opening settings starts its scrolling body at Account while preserving mounted
selections, confirmation state and composer drafts. Both mobile and desktop use
the same field set.

The restoration passes 107 design checks, 83 focused component/page regressions
and 17 intercepted browser checks including browser startup. The browser fixture
uses the real `AccountModelPicker` with synthetic catalog responses and covers
saved defaults, refresh, account/model/thinking selection, dismissal/focus,
retained drafts and reopening at Account. Inspected captures show
[390px mobile dark](assets/restored-chat-settings-mobile-dark.png),
[1280px desktop light](assets/restored-chat-settings-desktop-light.png),
[320px mobile with larger text](assets/restored-chat-settings-short-mobile-light.png)
and [300px-high desktop with larger text](assets/restored-chat-settings-short-desktop-dark.png).
Constrained panels reduce header/footer padding using the shared spacing scale
to keep a complete runtime row reachable while retaining 44px actions. Themes,
Mint/Teal accents and Georgia/System fonts remain effective. Workspace builds and
frontend TypeScript checks pass; `npm run test:ui` reaches Vite but exceeds the
required local 1 GiB heap, so full production build acceptance remains with CI.
These fixtures start no backend and make no model calls.

New and existing composers use the full chat pane with the same shared gutters.
Commands, image attachment, Terminal, Resources, collaboration, context, voice and
send/queue/interrupt controls retain their original order and behavior. Resources
keeps its icon, accessible name and resource count, without a visible text label.
The rounded composer row owns focus feedback; the textarea has no second square
focus box. Appearance preferences and larger text remain effective.

Missing web-access controls settle into an explicit unavailable state after bounded
attachment retries. A ten-second deadline bounds the complete read, including
response bodies and provider metadata, aborts stalled transport and restores Check
again. Late results cannot replace a newer retry. Check again exposes its pending
state, leaves the explanation visible and does not change permissions. Native
Symposium activation and integrated
review controls appear only in authoritatively classified native Symposium chats;
ordinary chat retains its separate existing collaboration action. An unavailable
native collaboration can copy its unsent text to a fresh saved chat draft. The
original conversation is retained; no provider binding or repository authority is
silently migrated.

Reusable profile drafts opens the existing editor in HomeDialog, including a real
empty or error state. The portal keeps the same editor and catalog revision when
moving between pending transcript cards and the dialog. Opening/closing performs
no save, preserves edits, and releases native modal/scroll ownership when closed.
HomeDialog’s optional open property supports this retained form; existing callers
keep their conditional modal behavior.

Offline component and intercepted browser checks cover dark/light Mint/Georgia,
320px/390px phones, 1280px desktop, 300px desktop height, keyboard dismissal, retained
selections/drafts, account and execution choices, icon-only Resources, rounded
focus feedback, opaque bounds and scroll-to-final-action. The real voice/commands/
resources/context fixture remains in coverage. No backend, credential or model is
used. Full application build and the complete UI suite remain CI acceptance.

Inspected captures: [desktop popover](assets/compact-chat-desktop-dark.png),
[desktop composer](assets/compact-chat-desktop-light.png),
[short phone settings](assets/compact-chat-mobile-short.png) and
[retained profile draft editor](assets/compact-chat-profile-drafts.png).

The shared Symposium transcript always uses All independently of the legacy compact-seat selection. Expanding an anchor-only chat must retain every agent’s finished and streaming replies. Independent previews refresh after completed replies, delivery changes and a five-second fallback; closing cancels their read and removes their timer/listener. Refreshing retains the existing history while the next page is read.

## Retained Telos source navigation

`TelosItemSources` keeps originating exchanges in Sources and preserves unknown
legacy selection, author and dates explicitly. The existing output list excludes
`source_capture` packets. Opening a reviewed source resolves its retained proof
and navigates to the full ordinary chat at its recorded exchange; it creates no
session and changes no account, model or assignment. `TelosSourceWorkLink` reuses
`SessionWorkLink` in one compact contextual row with shared gutter, control-height,
spacing and text tokens. It adds no second back action or settings surface.
Generic conversation associations remain available in Resources through
`ConversationWorkLinks`, including every item sharing one original discussion.
S8 composes this same association into the complete approved item/chats/work row.
Source navigation fences late responses on chat/item changes and leaves the
ordinary transcript, composer, Resources, settings and history intact. Offline
source browser fixtures cover narrow mobile and desktop, light/dark appearance,
alternate accent/font, source anchoring and the return link.

## Frozen Symposium joining review (16 October 2026)

The owner-driven Before joining surface follows the approved
`symposium-fresh-agent-review.html` flow and `06-fresh-agent-context-review.png`:
back/title/close, fresh-session separation, context mode and counts, an attributed
included-context disclosure with exact saved artifact versions and filenames,
the editable joining brief and its original explanation, the flat Agents policy
row, and left-aligned Back / Join conversation. Brief edits request a new frozen
review in the same screen; no extra review step or manual freeze control is added.

`HomeDialog` supplies an optional shared back affordance. Existing callers retain
their header layout. The review uses `UiIcon`, shared semantic colors, fonts,
spacing/type/radius/control-height tokens and existing dialog focus/motion owners.
The 32.5rem maximum width reproduces the approved 520px structural dialog geometry;
the content height subtracts its two 1px borders to prevent an outer scrollbar.
The body scrolls independently while the heading/footer remain reachable.
Review-only typography, button and field rules preserve the other accepted dialogs.

The application must explicitly supply the authenticated source/capacity/ordinary
preparation owner. No production owner is installed by this presentation slice;
ordinary setup therefore retains its explicit unavailable review state. Display
metadata must identify every exact artifact pin before confirmation. Confirmation
uses the exact server-returned snapshot, settings and request identity; uncertain
review/confirmation retries retain their original complete request. Back / Review
resumes the edited frozen brief when setup is unchanged; closing and reopening
also retains failed initial review attempts and their Check again action. Only an
explicit setup change creates a new review intent. Pending joins
recheck their original receipt. Only an authoritative linked receipt closes the
review and permits a new fresh setup. Full application restart discovery remains
with the future ordinary owner; this UI introduces no receipt/session store.

Focused offline hook/component/HomeDialog/design checks pass (144 tests), with
focused ESLint and source-alias TypeScript checks. Runtime manifest/source-closure
checks also pass (164 tests including the focused UI checks). Correlation IDs and
review hashing use the shared browser-crypto helper on supported remote HTTP
without secure-context UUID/SubtleCrypto APIs. The intercepted browser fixture
uses synthetic callbacks and no backend, credentials or model. An independent
reviewer compared the final code and five actual component captures against the
approved HTML and screenshot: [desktop dark](assets/symposium-joining-desktop-dark.png),
[desktop light](assets/symposium-joining-desktop-light.png),
[320px mobile top](assets/symposium-joining-mobile-dark.png),
[320px mobile scrolled](assets/symposium-joining-mobile-dark-bottom.png), and
[390px mobile light](assets/symposium-joining-mobile-light.png).
Desktop/mobile checks cover light/dark, Mint/Georgia and Teal/System, exact context
content, long brief scrolling, pinned/reachable controls and retained edits.
The full browser acceptance run is recorded separately with the PR checks.
These captures qualify this bounded presentation, not application admission,
saved-file artifact access, all-account/runtime operation or native iOS behavior.

## Native biometric enrollment

Native login offers an unchecked **Enable Face ID on this device** option (or the
device's biometric label). Its description states that the passphrase is saved in
secure device storage and protected by the enrolled biometrics. Failed legacy
unlocks explain how to enroll after signing in. Enrollment failures remain visible
and let the user continue with passphrase login by unchecking the option. This
uses the existing login form and buttons, shared semantic color/type/spacing
scales, and a checkbox label with the shared minimum control height. No new
palette, font, motion or dialog pattern is introduced.

The all-intercept `login-biometric` fixture renders the actual login component
with a synthetic native bridge, at 320/390px mobile WebKit/Chromium and 1280px
desktop Chromium. Dark Mint/Georgia and light Teal/System checks cover unchecked
consent, keyboard toggle, wrapping, horizontal overflow, visible actions, minimum
label height and protected storage arguments after login. Inspected captures:
[mobile dark](assets/face-id-enrollment-mobile-dark.png) and
[desktop light](assets/face-id-enrollment-desktop-light.png).
These offline checks use synthetic credentials and no backend or model calls;
real iOS Keychain/Face ID prompts still require separately authorized device testing.

## Cold launch and offline quote handoff

`StartupScreen` is the single full-screen brand surface while `ProtectedRoute`
validates the existing session. The underlying application root is inert only
while this surface is visible; authentication success or login redirection restores
normal interaction immediately. The decorative animation does not grant access,
retain a ready page, or change existing timeout/retry/logout rules.

`LiquidLogo` samples the existing wordmark into bounded round droplets. One fall,
a shallow spread, and a gathering rebound resolve into the original wordmark.
Sampling, theme color and geometry happen once; animation frames perform no
layout reads. Device pixel ratio is capped at two, and resize, backgrounding,
unmount and Reduce Motion stop the animation. The shared motion helper contracts
the wordmark into the quote mark and flies that mark to the actual Today quote
link if it appears within a bounded window. Input never waits for either flight.

The sixteen approved absurd phrases are selected once and retained through retry.
After the introductory motion, a locally available attributed literary quote
appears. Published daily selections and the quote visibility preference are cached
by API origin. After Today loads, optional, cancellable reads prepare the next
seven server-selected dates. A bundled approved quote covers first launch or a
cache miss without claiming to be that day's server selection. No workspace data
or credentials enter this cache. Real connection failures retain an explicit
message and Retry below the quote.

The new decorative liquid/quote/handoff timings live in `tokens.css`. All colors,
fonts, spacing and text sizes use the existing semantic tokens; the logo's 256:94
geometry and bounded 32rem reading width are structural. The entrance phrase keeps
its position when the quote appears. The standalone launch surface owns viewport
coverage; it adds no second visible collection masthead or navigation.

Offline actual-component browser checks cover 320px mobile WebKit/Chromium and
1280px desktop Chromium, dark Mint/Georgia and light Teal/System, fast success,
slow success, retry, missing cache, expiry/login redirection, Reduce Motion,
larger text, scrolling, keyboard Retry, 44px touch controls and uninterrupted
input during the home handoff. These fixtures intercept all requests and use no
backend, credentials or model. Inspected captures:
[mobile logo](assets/startup-logo-mobile-dark.png),
[mobile quote](assets/startup-quote-mobile-dark.png), and
[desktop quote](assets/startup-quote-desktop-light.png).

Focused unit/design checks, workspace package builds and frontend type checking
pass. `npm run test:ui` reached the production Vite build and exhausted the required
1 GiB local heap; the full build/application browser suite remains CI validation.
This verifies frontend behavior, not a measured iPhone cold-start speedup. Physical
Face ID/Keychain and device startup timings remain separately authorized device
checks. Staging and production are untouched.

## Reviewed API tool configuration

Tool library retains its compact cards, filters and profile usage. Configure API
tool opens an inline `MotionPresence` disclosure with the existing labelled
fields, quiet actions and status/error patterns. The first template reads one
Home Assistant entity. Connection selection reuses existing managed connections;
there are no endpoint, method, code, header or credential editors. Implementation,
input/output mapping and documentation are available on request. Published cards
retain their reviewed template, source path and fingerprint in Details.

Save draft, Verify API read and Publish tool remain separate actions. Verification
explains its API read and reuses the existing app reauthorization. Failed saves
and verification retain input. Editing invalidates local proof; Escape/Done
returns focus and closing preserves the mounted draft. Cancel aborts verification through the retained-owner IPC boundary; owner drain waits for the actual request cleanup. Request cancellation and its deadline use AbortController with listener/timer cleanup so supported older WebKit does not require newer static AbortSignal helpers.
Colors, fonts, spacing, focus, control height and motion use shared styles; no
new CSS or palette is introduced.

The all-intercept actual-page fixture covers 320px mobile WebKit/Chromium and
1280px desktop Chromium in dark Lavender/System and light Teal/Georgia, keyboard
focus, retained edits, failure/retry, publication, 44px actions and scrolling.
These checks use fake responses without backend, credentials or models. Full-app
build/browser acceptance remains a separate CI gate. The application shell and
advisor/editor placement are unchanged.
