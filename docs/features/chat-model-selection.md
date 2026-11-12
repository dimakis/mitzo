# Chat model selection

Verified offline on 12 November 2026. This records source behavior and regression
evidence; it does not establish historical provider usage or production activation.

An existing Codex chat can choose a different model and thinking level for its next
message. Each admitted command freezes its own selection. Running work, older
queued commands and the original account, profile and execution binding retain
their recorded identities.

Two defects made a successful choice unreliable or misleading:

- Existing-chat intent lived inside the mobile/desktop screen. A responsive
  remount restored the previous admitted model before the next message was sent.
  It now shares the conversation-scoped draft owner, after checking the original
  account, profile and execution binding. Changing conversation owners clears it.
- Session lists, search results and live/persistent overview rows read the original
  session metadata even though ordinary continuations record their newer model on
  command receipts. Those projections now use the latest admitted selection, as
  the reopened picker already does. A failed receipt read keeps the chat visible
  with an unknown model and a sanitized diagnostic. Legacy chats retain the saved
  metadata fallback when no ordinary receipt exists.

Receipt-read failure is explicit display metadata, including its server observation
time. Rows, search and an open preview retain the newest model observation across
search clearing, disconnect and reconnect. A newer successful HTTP or overview
read restores the known model. Equal-time uncertainty wins conservatively. These
wall-clock observations are presentation hints, not durable ordering or command
authority. The cached-known → unreadable → recovered regressions address Centaur
finding `CEN-3E5EAB55D8A1` (review 5867598224, 12 November 2026).

The existing WorkspaceControls header and AccountModelPicker remain the UI pattern.
No layout, token, typography, palette or motion change is included. Merely editing
the picker does not change an already admitted command or prove provider execution.
Unsent existing-chat edits survive responsive remounts; a full reopen restores the
last admitted selection.

The hook regression reproduces the remount, verifies the frozen next-command
model/thinking and checks conversation isolation. Real HTTP metadata/list tests
cover a changed continuation, unavailable optional catalog and unreadable receipt.
Overview tests cover live and retained chats. A metadata restore failure preserves
its visible retry state and emits a sanitized diagnostic while retaining the cause
in the local failure state.

The owner-switch regression also visits a second conversation without editing it,
then returns to the first after its admitted thinking level changes. The shared
draft owner discards the abandoned selection when ownership changes, so reopening
uses the latest admitted settings. Same-owner responsive remounts still retain
the unsent choice. This was reproduced before the correction and verified offline
on 11 November 2026; it does not establish production behavior.

The intercepted `chat-model-settings` browser journey also checks the header,
picker and frozen command after recreating the screen in phone/desktop projects,
light/dark themes and alternate appearance. Local browser startup was blocked by
the native sandbox guard before launch. Hosted CI passed all browser projects on
the preceding reviewed head; each updated head still requires browser validation.
Browser verification remains a CI gate;
the source/unit/HTTP checks do not substitute for it. No real model call, staging,
deployment or historical-session mutation was performed.
