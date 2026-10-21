# Telos lifecycle workspace controls

S7's additive UI consumes S6's existing lifecycle schemas, operator-authenticated
routes and actor-bound receipt semantics. It adds no role setup, backend/runtime
ownership or ordinary chat changes.

The item lifecycle row sits below the existing heading and priority selector.
Pause, acknowledgement and application are distinct owner-reported facts; Resume
releases the selected root's operator pause and does not claim other holds ended.
Inherited hiding links to its actual containing item. Archive and recoverable Trash
retain identity, child dispositions, history, sources and saved material. Restore
uses the actual current result, including a pre-Trash archived disposition.
Permanent deletion has a separate exact-item, typed confirmation and remains
subject to the backend's leaf, reference and verified host-quiescence checks.
An unconfigured host callback stays fail closed; UI presence proves no capability.

`WorkspaceActionMenu` reuses the existing quiet session action/menu styles,
`UiIcon` and shared motion helper for non-session workspace actions. It preserves
keyboard movement, dismissal and focus before opening the existing `HomeDialog`.
The lifecycle row and native sort selector use semantic type, spacing, surface,
focus, radius and control-height tokens. No palette or font source is added.

The existing tree navigation journal keeps its query, category, pins, manual
expansion and chosen sort. Default owner order is unchanged until the user chooses
a sort; priority/date ordering affects siblings only, ties stay stable and unknown
creation dates remain unknown. Outcome views uses the actual active/archive/trash
collection query. Item navigation carries its original collection, scroll, profile
and opaque Home/Files context; refreshing a lifecycle read changes the detail's
data view without rewriting that return destination.

The retry journal is keyed to the existing server-verified interactive auth-session
identity and API base. It persists only the schema-validated original command.
Mount/reconnect never writes. Uncertain delivery needs an explicit identical retry;
refusal requires explicit current-state review. Authentication changes abort stale
reads/writes, retain the original scoped uncertainty and close destructive dialogs.
Deletion recovery requires a fresh typed confirmation even when current reads fail.
A validated successful deletion selects the retained return before collection
invalidation; the generic missing-item redirect cannot overwrite that navigation.

Focused intercepted-fetch route tests exercise the actual client, hooks, menu,
dialog and workspace navigation. Separate component tests cover stage copy,
refusal, invalid/stale review, keyboard/focus and exact recovery. Unit checks do not
prove desktop/mobile geometry or actual host deletion availability. The current
private fixture foundation is development evidence; Core owns final lifecycle and
corrective integration, pins/runtime, review and CI. S9 owns matching-source App
and browser acceptance. No S7 browser/native/backend/model run or deployment is
included in this source packet.
