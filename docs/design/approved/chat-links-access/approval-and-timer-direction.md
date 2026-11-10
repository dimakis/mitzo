# Additional UI direction, 10 November 2026

Dimitri supplied these instructions in the same implementation conversation,
`e137e614-dff3-8059-b715-7fca773fa2b7`, after approving the v007 mock.

> I want it consistent. The accent color and no boxes around them

The Chats search action must focus the search field. Preserve the current theme,
accent and font settings, SVG icon style, touch targets and visible keyboard focus.

> Should be more clean and cut straight to the point “gh cli command egress” as an example.

Approval requests in Inbox and the popup should identify the concrete operation,
directory and requested access. Internal JSON belongs in request details; decisions
remain reachable without scrolling through it. Preserve scope, expiry, revocation,
questions, source reviews, response errors and the original request identity.

> Timer card needs work too. Also, the ability to delete a timer and for it to not be a wall of text.

Show a bounded prompt title, schedule, state and next run. Keep the complete prompt
in a disclosure. Explicit deletion stops future checks and removes the timer from
the list while retaining earlier command/delivery evidence and chat history.

> Upon switching to the chats page. messages “chats” page jumps when mitzo reads the bits from the session. From plain list to active list with useful state etc.

Use already observed freshness on entry. Reserve metadata/status geometry while
late observations arrive; do not silently reorder the painted initial list for
hydration. Preserve later live activity, browsing holds and Show latest.

This is explicit design direction, not a claim that implementation screenshots
have already received visual acceptance. CI evidence and final review remain required.
