# Stable Agents roster, Details and composer status

Candidate prepared from accepted main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`
on `fix/s7-stable-agents-roster`. This is ordinary contributor work; backlog slice
`9cbefb2317720bc4` is a scope reference, not a claimed Telos assignment. No merge,
deployment, live model call or acceptance is implied. The PR records the exact
candidate head.

## Behavior and boundary

Reuse the existing Agents dialog, flat seat rows, shared HomeDialog focus/motion
and mounted ComposerStatusRail. Streaming activity never determines row order or
keys. Committed display observations retain known configuration within the current
source/auth owner; current membership, policy and actions are not cached authority.
Recorded join/message settings populate profile/account/model/mode independently
of activity readiness. Missing metadata retains known values with an explicit
last-known notice. Details separates membership and runtime activity, exposes
diagnostics and Refresh, and preserves read-only inspected details after removal.
Back restores focus to the same seat, or Add agent after removal.

The single nonwrapping status line uses the shared control height. Wide containers
show names/status; containers at or below 480px show counts. The left summary
registers with the existing dialog owner. The right recipient button invokes the
existing `chooseResponders` owner and does not open Agents. Header trigger markup
and its local panel state remain intact.

Additive interfaces:

- `ConversationAgent`: typed `membership?: 'joined' | 'removed'` lifecycle data;
  separate membershipLabel, profile, accountId, mode, configurationNote, diagnostic
  and activityState display fields.
- `ConversationAgents`: `renderAgentActions(agent)` / `renderAgentResult(agent)`
  reserve seat-keyed lifecycle slots; `onRefresh` / `rosterError` expose recovery.
  S4 retains removal, revision-checked membership writes and original Stop receipts.
- `ConversationAgentsPanelContext`: source-scoped display data and registration
  of the existing panel opener. It does not own another dialog.
- `ComposerStatusRail.onRecipientsClick`: ChatInput supplies
  `responders ? chooseResponders : undefined`, as agreed with S6. No toolbar edits.

## Parallel integration notes

No prerequisite PR is required to compile this candidate. The feature lead owns
combined integration; do not replay peer implementations or rebase for main drift.

- S9 draft [#1435](https://github.com/dimakis/mitzo/pull/1435), head
  `854bb33eb7107062fd01d9f92451f333a3a4b798`, has the same base. Preserve its
  optional `sharedIdentity` trigger label and `sharedIdentity={host.identity}` in
  SharedConversationAgents. It reuses the existing trigger/panel owner.
- S5 owns SeatLabel/seat-color and its SeatColorProvider. Nest this opener provider
  alongside that provider within the existing SharedConversationHost context.
  This candidate does not change color assignment or transcript wrappers.
- S4 has no implementation prerequisite. Keep unresolved removed-seat operations
  in S4's non-operational recovery rows. Generic action/result slots do not invent
  membership mutation or Stop reconciliation. Existing global Stop recovery remains.
- S2 draft [#1436](https://github.com/dimakis/mitzo/pull/1436), head
  `b59ae22774fa167bbf53135369405679dc451f74`, is independent. Preserve
  `ChatStatusMessage status={sending.notice} busy={sending.submitting}` and its
  distinct `ChatInput.onQueue` / receipt acknowledgement during integration.
- Source manifests need the normal narrow union of changed pins and one combined
  runtime revision. This candidate uses `v1.0.1271-stable-agents-roster`; it does
  not overwrite the independently published S9 revision or imply adoption.

## Reproduction and local evidence

Tests were written before the corresponding fixes. Initial regressions exposed
missing profile/mode Details, loss of inspected-seat identity, and the absent
shared status opener. Later missing-metadata retention and source-pin tests also
failed before their fixes. Final focused coverage exercises the actual
SharedConversationHost API consumer, activity broadcasts, disconnects, keyed DOM
identity/focus, header/status reuse, draft preservation and separate recipients.

All local commands used one worker and a 1 GiB Node heap:

- 70 focused UI/state tests passed across 13 files: ConversationAgents*,
  SharedConversation*, OrdinarySharedConversation, ComposerStatus, roster
  projection and owner-retention hook.
- `npm run test:design -- --maxWorkers=1`: 109 passed, one existing skip.
- Roster and joining-review artifact regressions: two passed.
- `npm run check:source-artifacts`: all registered hashes match. Added four roster,
  retention and panel modules and refreshed only changed existing source pins.
- ESLint passed on changed production/test TypeScript. Prettier passed on changed
  source, tests and documentation.
- Protocol/harness/client TypeScript project builds passed. A targeted frontend
  type check using those built declarations passed for the changed shared
  components, hooks and regression tests.
- Offline Playwright discovery/bundling passed: six roster cases across mobile
  WebKit, mobile Chromium and desktop Chromium (plus two startup checks).

## UI design and outstanding gates

Shared semantic tokens, control height, typography and existing dialog/motion
owners are reused. No palette, font definition, reference image or approved-design
ledger revision changes. The 480px container breakpoint selects a compact content
representation; it is structural, not a new spacing/type scale.

The new offline fixture covers 320/390px phones and 400/1280px desktop windows,
light/dark themes, mint/teal accents, system/Georgia fonts, long metadata, status
churn, focus, draft retention, separate recipients and refresh failure/recovery.
These are executable assertions, **not completed visual verification**. Browser
startup was blocked: the initial cache lacked headless Chromium; downloading it
failed, and the installed full Chromium could not register its process/profile
socket under the host sandbox (`Operation not permitted`). No browser launch was
retried after that sandbox failure. No screenshots were produced or inspected.
Mobile/desktop rendering, large text and real browser keyboard behavior remain
gates for an authorized browser environment.

The broad frontend build exceeded the repository's required 1 GiB local heap and
was not repeated with a larger heap. Full frontend build and combined browser CI
remain required. Saved specialist consultation preparation failed and was stopped
with no contribution; no independent review is claimed. Exact-head CI, Centaur's
final LGTM/merge recommendation and any separately authorized live checks remain
before merge. This draft has no merge or deployment authority.

## S4 compatibility follow-up

Incremental delta from published S7 head
`b8506e2d2aaa7f8fe85f0f2a565908881887de22`, without a rebase or peer imports.
S4 commit `67b5944d03d453ab63546bf0de97fff3336abe8b` was inspected read-only from
its own checkout: ConversationAgents, SharedConversation and
ConversationSeatLifecycle interfaces. Its lifecycle implementation remains owned
by S4. No publication retry or restart was performed for that checkout.

The agreed interface keeps `membership` as `joined | removed` and moves S7's text
to `membershipLabel`. Projection maps unavailable participants to `joined` with
the unavailable label and no confirmed policy. Typed removed rows override stale
display labels, retain their stable identity, Details/history and both lifecycle
slots, and hide policy/preview/profile controls. The result slot still receives
the same seat for S4's original Stop recovery; S7 adds no removal or Stop operation.

Test-first follow-up exposed the old display-as-state mapping and policy controls
on retained removed seats. Mapping and render regressions cover unavailable joined
members, deliberately misleading removed-seat labels/stale policy, original
recovery callback delivery, retained configuration, row identity and Details/Back
focus. Final local validation: 72 focused UI/state tests, 109 design tests (one
existing skip), two artifact regressions, changed-file lint, targeted frontend
types, full source-pin verification and offline browser fixture discovery passed.
The runtime revision is `v1.0.1272-stable-agents-membership-label`. The original
browser and full-build limitations still apply; no new rendered verification is
claimed.

At follow-up inspection, #1448 had no submitted reviews or issue comments. Keep
`b8506e2d` as the published candidate baseline; subsequent review should assess this
bounded delta without restarting an unrelated whole-candidate review.

Future integration seam: finding18 [#1450](https://github.com/dimakis/mitzo/pull/1450),
head `cca2d7a83a9a8e7b790182c5fb91e3033d92e9f9`, adds
ConversationContextSelection and an optional joining catalog loader/display
metadata. Preserve its narrow ConversationAgents consumer and host loader exposure
only after `association.begun`; do not introduce implicit begin/sharing or change
selection/refreeze behavior. It is not imported or a prerequisite of this delta.
