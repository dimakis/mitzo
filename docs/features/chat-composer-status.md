# Combined composer status

Design approved by Dimitri on 4 November 2026: “I love this. I want it above the
composer,” with the explicit restriction to preserve message dates, copy/read-aloud
controls, and existing composer icons and features. The retained prototype is
`docs/design/approved/chat-status/status-above-composer.html`; only its status
placement and status/draft interactions are approval references. Its simplified
message bubbles and toolbar are not approved replacements for existing controls.

## Presentation and retained behavior

Ordinary phone and desktop chats use one always-mounted status row above the
existing composer. Its height comes from the shared `--control-height` (44px),
preserving mobile touch targets. Text stays on one line and truncates; details
open in the shared `HomeDialog` without changing conversation geometry. There is
no new palette, typography scale, animation timing, or settings layout.

When there is one existing status action, such as Retry or Continue with Codex,
it remains directly available in the fixed row. Full controls remain in details;
multiple independent actions use Review. This preserves existing recovery and
continuation affordances while keeping the combined row bounded.

`ComposerStatusProvider` collects existing feedback without owning dispatch or
recovery. Separate writer/view contexts prevent feedback updates from repeatedly
rendering their source components. Status sources retain their existing ownership,
polling, callbacks and authorization checks. Without a mounted composer, original
feedback remains available in place.

Warnings and failures take precedence over routine progress. Identical issue
messages count once. Multiple issues show an attention count; resolving one leaves
the other visible. While the agent is running, routine busy recovery feedback does
not rename the conversation “Reconnecting.” Full provider recovery information and
its original actions remain in details. The current permission request produces
“Needs your approval”; its existing approval interface remains authoritative.

The queued count opens the existing Up next tray, with editing, ordering,
attachments, reply context, pause/resume, explicit recovery and removal intact.
Server queue previews, cancellation, capacity recovery and uncertain-effect checks
also retain their original controls. Viewing details sends no new command. A
composer ownership change closes the old details view.

Routine draft saving is silent; storage failures remain visible. Submitted image
previews leave the composer with the submitted text, while the exact payload stays
retained for its receipt. Starting another draft removes the submitted images from
that new draft. A synchronous refusal leaves the original draft visible; failures
after a later edit retain the original payload behind existing explicit recovery.
Late receipts cannot erase newer text, images, another tab's revision, or a
different conversation's work. Unknown delivery keeps the existing uncertainty
fences and restoration behavior.

The persistent queue/interrupt hint and changing running placeholder are removed.
The explicit correction action uses the direct icon-only lightning button beside
Queue and Stop, with its accessible name and restriction tooltip. This placement
supersedes the original Send options menu following Dimitri's 6 November request.
Native and legacy correction routes keep their original semantics; Enter-key
behavior and all dispatch/retry/target fences are preserved.

### Screenshot corrections, 6 November 2026

Dimitri reported an unavailable correction with a screenshot attached, initially
appearing to recover after switching apps, then confirmed the image was the
blocker. He rejected the second one-item overflow and explicitly requested an icon
like the other composer actions. The append-only approval revision is recorded in
the chat-status design ledger; the earlier status reference and approval remain.

The composer, native route handler and steering request schema previously enforced
text-only corrections. Codex's pinned **0.160.0** protocol already accepts image
inputs for `turn/steer`, with an exact active-turn precondition:
[TurnSteerParams.json](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/json/v2/TurnSteerParams.json),
Git blob `7dbdefa046aed1d29ec163f9c526e8e58c06e644`, verified 6 November.
This is a Mitzo input restriction, not evidence that the provider lacks image
steering. No live provider call was used for verification.

One shared protocol schema now validates both client retention and server admission.
Screenshots travel as native image data URLs, appear in the saved transcript and
stay inside the original at-most-once correction receipt. Reload and uncertain
delivery retain image bytes and the original target; changing either cannot
replace the correction. Explicit steering from Up next supports the same images.
Context changes continue to require a new command.

A separate regression reproduces a dispatch lock when animation-frame callbacks
are suspended: after an acknowledged correction, another correction was ignored
until the next frame. Send and interrupt release their short dispatch guards
without waiting for a paint; pending delivery still prevents duplicate submission.
This is a reproduced defect, not a claim about which state caused the original
phone incident.

Validation for this change: the affected composer/steering/design run passed 359
tests with one existing conditional skip; an additional invalid-image regression
then passed with the full 11-test steering hook suite. The 12 focused native
steering regressions and 9 HTTP route checks pass. Workspace packages compile,
focused hook/schema type checking and changed-source lint pass, and reviewed
source fingerprints are refreshed for `v1.0.924-steering-attachment-http`.

The larger ordinary-workspace HTTP fixture fails during initial native bootstrap
with `Local Codex entry unavailable`, before steering. The unchanged `10f84e3a9`
baseline reproduces the same failure in a separate checkout with the same offline
dependencies. Its text-and-screenshot cases remain required CI coverage.

The offline browser matrix lists all 12 application cases across phone WebKit,
phone Chromium and desktop Chromium, both themes and alternate accents/fonts.
It now checks direct icon geometry and screenshot correction delivery, with a
`chat-queue-interrupt-image-<theme>.png` capture before sending, matching the existing
CI responsiveness-artifact selection. Approved execution still
retained the macOS Seatbelt marker, so the repository guard stopped Playwright
before launch. No local rendered inspection or screenshot is claimed; hosted
browser checks and capture inspection remain pending. No live provider call or
production activation was performed.

Landing follow-up: hosted browser interaction tests passed 150 cases and failed
two viewport cases because the remaining `tests/browser/composer-layout.spec.ts`
fixture still selected the removed Send options menu. The corrected fixture
retains the direct controls' 44px width/height and viewport bounds, and adds
icon-only content, the lightning symbol, absence of the old menu and input focus
after clicking. The local read-only follow-up found no defects in this delta.
The approved host task worker passed the environment guard but first lacked its
browser cache; after selecting the existing matching installation, macOS denied
browser process registration at startup. No application test ran locally and
that launch route was not retried. Hosted verification remains authoritative.

Centaur review `5808694748` also identified the native steering endpoint missing
from the authenticated attachment-sized HTTP parser. It now uses that existing
parser before the general 10 MiB parser. Parser regressions include a 12 MiB
encoded image correction and ordinary, missing, internal and revoked operator
authentication for the steering route; native target and receipt checks stay in
the owning route.

The message renderer, dates, copy, read aloud, reply menus, tool/activity rendering,
account/model controls and approved Chat settings are unchanged. The actual
composer retains commands, attachment/PDF import and editing, terminal, expand,
workspace/isolation, session resources/context, collaboration, token usage and voice.

## Validation evidence and limits

Focused regressions cover status aggregation, simultaneous issues, approvals,
restriction explanations, queue controls, draft storage, original toolbar actions,
message actions, correction focus, late receipts, uncertain delivery, route
adoption and ownership changes. Regression fixtures use the actual components,
parser/store and existing delivery callbacks. Tests were written and observed
failing for the new status rail, image handoff, combined queue presentation,
approval label and correction restriction before their implementations.

The final local affected-component/route/design run passed **654 tests**, with one
existing conditional skip. Changed-source lint reported no errors and one
pre-existing ref-cleanup warning in WorkspaceActionMenu. Source fingerprints pass
for runtime revision `v1.0.852-combined-composer-status`. Message rendering, copy,
read-aloud, ComposerTools and QuickChatSettings source files retain their original
bytes from the base revision.

The extended offline `chat-queue-steering` fixture retains queue/steering/reply
checks and adds constant transcript/status geometry, long status text, date/copy/
read-aloud controls, the original composer controls, screenshot handoff and
preservation of the next draft. It defines 12 application cases across mobile
WebKit, mobile Chromium and desktop Chromium in dark Mint/System and light
Teal/Georgia. All requests are intercepted, voice uses a synthetic callback, and
no backend, credentials, microphone or model is used. The fixture bundles and its
matrix lists successfully.

Local browser execution was attempted through approved unsandboxed execution, but
the host still reported `CODEX_SANDBOX=seatbelt`. The repository guard refused
before browser launch. No browser binary was retried and the host marker was not
altered. Browser rendering, layout measurements and screenshots remain CI checks;
no local visual verification is claimed. CI should retain the generated
`chat-status-dark.png` / `chat-status-light.png` captures with its offline results.

Workspace package compilation and focused changed-frontend module type checking
against those freshly built declarations passed. The standard full frontend type check hit
the repository-required 1 GiB Node heap limit; full frontend types and the complete
production/offline matrix remain CI gates. No staging or production action was
performed.

### Landing follow-up, 4 November 2026

The current accepted base `b8ae361cf` is integrated. Clipboard paste now uses the
visible draft's attachment count, matching file/PDF imports. Regressions first
failed, then passed for both 99 and 100 retained outgoing images, two newly pasted
images, and the original receipt arriving afterward without removing the new draft.

The combined local composer, route, Symposium, accessibility and design checks
passed **590 tests**, with one existing skip. Changed-source lint and the source
manifest check pass; runtime revision `v1.0.856-recovery-summary-scope` also
retains status/queue screenshots in the existing hosted visual artifact. Hosted
browser interaction tests passed; the manifest revision line's formatting was
corrected after the first hosted core check flagged it.
Existing integration and browser fixtures now open the status dialog before
checking queue/recovery controls. Compact-composer coverage retains the original
88px input/tool bound and separately checks the approved 44px status row. PDF
coverage checks immediate preview removal and restoration of all twelve retained
pages after rejection, including a failed subsequent import.

Browser fixtures enumerate successfully. A focused local browser attempt stopped
at the repository's macOS Seatbelt guard before launch; hosted browser and joined
acceptance remain required. No staging or production action was performed.
