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

Empty messages with a repository preparation retain their exact receipt and account/model binding. Discard confirms and releases unused preparations before removing the local draft; unavailable or uncertain cleanup keeps the draft and reports the error. Pending attachment imports remain fenced to their originating composer. Clearing an ordinary draft leaves an editable blank composer whose URL can be reloaded.

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

The existing shared picker owns Agent, Account, Model, Thinking and Run on across
mobile and desktop. Reuse its workspace controls and token styles. OpenShell is
the default; Local Mac is deliberate. Resolve only pristine unselected target
intent from trusted inventory, and preserve stale/unavailable account, model,
thinking and target choices with a useful reason. Runs with describes the derived
software rather than adding another runtime control.

Bound ordinary Codex conversations lock account, exact published user profile and
execution target. Server-supported conversation scope enables model/thinking edits
for future commands, normal guarded follow-ups and the native queue. Each queued
request keeps its original settings snapshot. Unsupported mode/context/web helpers
remain independently disabled. Metadata loading/failure never enables legacy
fallback; Retry preserves the conversation and draft.

New session elsewhere creates a separately owned blank draft with copied intent
and no inherited repository preparation. The explicit retained-intent flag keeps
that blank draft recoverable without changing ordinary empty-draft behavior. Its
separate preparation creates a separate checkout. The original conversation,
provider history, branch and pending work remain under their existing owners.
Unavailable cold custody is a visible server reason, not a replacement environment.

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

Ordinary mobile and desktop conversations share `ChatArea` and its `AgentActivity` disclosure. They do not render an Outputs panel or fetch output/contributor state. The underlying output reference and contributor APIs remain available for stored work; ordinary chat does not automatically present that workflow. Offline checks cover both conversation layouts, collapsed and expanded activity, ongoing thoughts/tools, keyboard focus and alternate appearance preferences.

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
scrolls within that space, retaining those controls under larger text and viewport changes.
A 45dvh cap is the fallback before measurement. These bounds are structural overlay geometry;
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

## Explicit Local first-command selection

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
