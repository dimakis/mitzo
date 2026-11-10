# Consistent, smooth interactions

Direction: Dimitri, 10 November 2026, approved the app-wide consistency and
interaction plan after reporting mismatched Chats disclosure rows, send-time
flicker and abrupt keyboard transitions. Baseline: accepted main `9f165ea5`.
This is one feature with three proposed session-sized slices: keyboard/send
stability, shared visual consistency, and remaining interactions/integration.
The exposed agent tools cannot create a standalone feature or assign its working
sessions. No Telos item or dedicated session setup is claimed by this document.

## Contract

- Keep the existing collection rows, transcript, composer and shared dialogs.
- Equivalent headings, disclosure labels, icons, counts and controls share roles.
  Preserve intentional hierarchy and user-selected font, theme and accent.
- Input and dispatch remain immediate. Motion must never delay a send, retry,
  queue or steering operation, or change its receipt/authorization semantics.
- First-command URL assignment names the current conversation without fading
  its contents. Actual navigation, including Back, retains shared page motion.
- Streaming settles the following scroll before paint. Keyboard opening and
  closing preserve reader intent; ChatArea's resize observer owns following.
- Shared motion supports interruption, focus, retained drafts and Reduce Motion.

## Reproduced causes

The first command replaces `/chat` with `/chat/:id`; MotionRoutes previously
started another opacity-zero page fade. A failing navigation regression proved
this before implementation. Mobile ChatView also unconditionally scrolled to
the bottom on keyboard opening. Its consumer regression reproduced that call
while reading older content. ChatArea applied streaming scroll in a passive
effect, exposing the previous scroll position to a parent layout effect; its
regression now requires the adjusted position before paint.

These are reproduced mechanisms, not a claim to have reproduced every physical
iPhone flicker. Native keyboard/device acceptance remains separate from offline
viewport simulation and unit coverage.

A further failing-before-fix consumer test reproduced a response remount when
streaming finalized: message-action wrappers and final footer fragments changed
the text's ancestry. The shared renderer now retains that structure from the
first text chunk, enabling actions only on completion. Regressions retain the
same text DOM node with and without sharing controls. This applies to ordinary,
queued, corrected and shared responses through ChatArea without changing dispatch.

The shared HomeDialog has one interruptible sheet entrance without replaying on
edits. Its dismissal/busy guards and focus/scroll-lock lifecycle remain immediate.
MotionDetails adds a smooth close to Drafts, backup and provenance disclosures,
with retained forms, Escape/focus recovery, immediate exit inertness, rapid
reopen, Reduce Motion and missing-animation fallback. A reproduced animation
rejection previously left an inert closing panel retained indefinitely; it now
settles and reports a sanitized stage/code rather than silently failing.

## Validation and delivery

The source inventory covers 30 page modules. Shared patterns carry the changes
across these surfaces; differing semantic roles remain intentional.

| Surface                                                              | Shared owners and checks                                                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Today, Chats, Inbox, Work and More                                   | Collection title role, shared shells/navigation; Pinned/Drafts use one disclosure style         |
| Settings, Connections/setup/access, notifications and updates        | Collection titles and shared header-action icon geometry; existing editors and consent retained |
| Agent/Tool/Knowledge libraries, mockups and drafts                   | Shared collection headings, row/section roles and dialogs                                       |
| Calendar, briefings, quote, backups and sandboxes                    | Collection headings and existing bounded reading/forms                                          |
| Conversation, desktop conversation, item details, files and Terminal | Compact pane titles remain intentional; transcript and input share scroll/motion owners         |
| Routing/login modules                                                | No second page title or duplicated keyboard/masthead owner introduced                           |

The reported mismatch was Pinned's explicit `--text-xs` versus Drafts' inherited
base text. They now share a role, weight, padding and count inset. Chats' desktop
title also shares the collection title scale, and the focused Connections setup
title no longer changes to a separate 25px scale at a narrow breakpoint. Header
action glyphs share a 20px box while inline disclosure icons remain 16px.

The first focused run passed 189 tests with one existing skipped test, including
all design guards and the three new failing-before-fix regressions. Local browser
execution remains blocked: the approved task runner timed out during WebKit
startup; native escalation still reports the Seatbelt marker and correctly refuses
launch. No host-check bypass or alternate browser retry was used. The browser
fixture now checks actual Pinned/Drafts font/line-height, icon geometry, label/count
insets and 44px targets in dark/light appearances. Its rendered assertions have
not yet run and require an eligible host or CI.
The focused workspace-package TypeScript build succeeded. The full frontend
type check exhausted the required 1 GiB heap, so full type/build and rendered
checks remain CI work; no larger local retry or production fallback was used.
The separate `ui-response-stability` browser fixture retains the actual response
and composer DOM across stream completion and late acknowledgement of a multiline
send, preserving the next independent draft through constrained viewport changes.
Protected approved-design suites and their fingerprints remain unchanged.

Final focused validation on 10 November: 425 tests passed across 31 files, with
one existing skipped test. This includes all design/approved-design guards,
mobile/desktop chat consumers, Local/legacy send and correction receipts,
attachments, input focus, keyboard classification, response/metadata/subagent
rendering, selection, collection layouts, Inbox, backups and shared motion.
ESLint passed for every changed production TypeScript file. These are local
results, not full CI, physical-device acceptance, a merge or deployment.

CI run `42919225193` at `7b3d002a` passed full frontend source checking. Its
source preflight correctly rejected stale registered fingerprints for the changed
UI modules. Candidate runtime revision `v1.0.1015-ui-smoothness` registers the
complete changed UI/source/test/document closure with updated fingerprints.
This is candidate provenance for review; it changes no approved-design ledger
reference, protected test fingerprint, merge gate or production activation.

Hosted run `42920214994` at `9f5f6c78` passed compile/source preflight, the frontend
build, core checks and browser interactions. The response-stability journey passed
mobile WebKit in both themes. Existing image-preview and Today pin-dialog target
checks measured fractional translated WebKit bounds just below 44px during the
new sheet entrance. Those checks now wait for actual ancestor motion to settle;
they retain the exact 44px assertions and run with normal motion enabled.
The complete successor CI result and Centaur review remain required for landing.

Each logical change starts with a failing regression, then implementation and
an atomic commit. Run the design guard, focused consumer tests and intercepted
browser fixtures on mobile WebKit/Chromium and desktop Chromium. Inspect light
and dark themes, alternate fonts/accents, larger text, constrained viewports,
rapid toggles and Reduce Motion. Record actual results and unverified cases.
No backend, model call, staging or production activation is needed.
