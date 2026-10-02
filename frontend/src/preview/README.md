# Responsive chat preview

Run `npm run dev:ui-preview`, then open `http://127.0.0.1:3102/ui-preview.html`.

The preview renders the production `ResponsiveChatView`, `SessionList`, and `MobileShell` with 48 sample conversations. It switches between complete desktop and mobile chat screens at the same 768px breakpoint as the app. The fixtures replace network access for this entry point only; external actions are unavailable; selected agent actions change in-memory fixture data only. It is a layout preview, not a live assistant. Voice is unavailable because no voice service is connected.

Check at 390px, 767px, 768px, and a wide desktop viewport:

- Mobile: Chats opens the scrollable conversation list and bottom navigation. Select an older conversation, search by title, expand/collapse Workspace, and open Session resources.
- Desktop: expand Conversations, compare Active and All, scroll the list, select a long title, and collapse navigation independently.
- Confirm the composer stays within the viewport and UI controls use the same font as messages. Code retains its monospace font.

The production entry point does not import the fixtures or network substitutes.

The **Add agent** and conversation delivery controls are interactive simulations. `preview-1` starts with two seats and room for one custom agent within the three-seat cap. `preview-3` retains the three-seat review scenario and refuses additional agents at capacity. Open Workspace controls, choose Add agent, enter custom guidance or load a saved profile, confirm the sample account/model, choose permissions, and acknowledge the account boundary. Because the sample account differs from the existing anchor, type `ADD CROSS-ACCOUNT SEAT`. The queued message appears in conversation deliveries; Approve, Send, and Stop update fixture state only. Send leaves a simulated executing delivery so Stop can be inspected; no generated reply is fabricated.

The banner identifies the simulated backend. Changes reset on reload. This preview does not verify native admission, policy enforcement, cancellation cleanup, persistence, authentication, or any real account/model execution. Catalog writes and other external mutations remain unavailable. The session route is `/chat/preview-1` inside the preview's MemoryRouter; open `/ui-preview.html` in the browser.

**All** is a read-only combined timeline. Open a named agent stream to write to that agent; each stream keeps its own draft. The `@ Switch agent` button or a trailing `@` search opens the recipient picker. Select an admitted agent explicitly to switch streams; drafts stay with their original agent. Queueing is disabled while recipient selection is open. Closing the picker preserves literal `@` text, and email addresses do not change routing. Removed agents remain in history but cannot be selected as recipients. A single remaining anchor has its own composer and no recipient switcher.

Seat colors follow the stable seat identity across tabs, attributed messages, received context, and delivery recipients. Names remain visible; color is a decorative accent rather than the only way to distinguish agents.

Routine agent reads use the simulated durable `/symposium/status` projection: saved agents show “Added”, without claiming a live connection. Explicit actions still use simulated responses; no provider or native checks run in this preview. The production UI requests checked connection details only when troubleshooting is explicitly opened.
