# Responsive chat preview

Run `npm run dev:ui-preview`, then open `http://127.0.0.1:3102/ui-preview.html`.

The preview renders the production `ResponsiveChatView`, `SessionList`, and `MobileShell` with 48 sample conversations. It switches between complete desktop and mobile chat screens at the same 768px breakpoint as the app. The fixtures replace network access for this entry point only; account mutations and external actions are unavailable. It is a layout preview, not a live assistant. Voice is unavailable because no voice service is connected.

Check at 390px, 767px, 768px, and a wide desktop viewport:

- Mobile: Chats opens the scrollable conversation list and bottom navigation. Select an older conversation, search by title, expand/collapse Workspace, and open Session resources.
- Desktop: expand Conversations, compare Active and All, scroll the list, select a long title, and collapse navigation independently.
- Confirm the composer stays within the viewport and UI controls use the same font as messages. Code retains its monospace font.

The production entry point does not import the fixtures or network substitutes.
