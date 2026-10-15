---
description: Create clickable UI mockups and interactive visual prototypes in chat
mutating: true
---

Create or refine a clickable mockup for $ARGUMENTS.

Use this for exploring an interface in the conversation. If the user asks to implement a production feature or publish a website, follow that request instead of substituting a mockup.

## Deliver an interactive artifact

Write a self-contained `.html` file inside the current task workspace at `mockups/<slug>/v001.html`, using a descriptive, unique slug for each design. Keep the same descriptive link title across revisions. Use inline CSS and JavaScript, embedded data, and native HTML controls. No package install, build server, backend, CDN, remote font, or external image is needed. Mitzo previews scripts inside an isolated sandbox: network requests, external subresources, form submissions, popups and access to the parent app are blocked. Relative assets cannot load. Do not depend on localStorage, cookies, host globals or a messaging bridge. Keep state in memory and simulate data locally.

In the final response put one Markdown link to the absolute file path in its own paragraph, with no surrounding sentence in that paragraph. For example: `[Explore the task board](/absolute/task/workspace/mockups/task-board/v001.html)`. Mitzo renders that standalone HTML link as an expanded, clickable preview. Give a short explanation outside the link only when useful. Never paste the source into chat or use another app's rendering markers.

## Make the prototype useful

- Reuse the product context, visual language and references already available. Choose realistic content and a coherent primary workflow. Make ordinary design choices without an interview; ask only when a missing requirement changes what should be built.
- Make meaningful controls work: navigation changes views, tabs switch panels, selections update details, dialogs open and close, and forms validate locally. For form actions use `type="button"` with a click handler and `reportValidity()` when needed: sandboxed browsers can block native submission before an `onsubmit` handler runs. Identify simulated actions in the interface where a user might otherwise mistake them for a real external effect.
- When design alternatives would help, include a small labelled switcher that changes the actual layout or styling. Keep choices few and purposeful. Preserve the chosen variant during ordinary interactions.
- Use scoped CSS, semantic controls, visible labels, keyboard focus and Escape dismissal for dialogs. Provide accessible names for icons, status announcements for changing results, and usable touch targets. Support 320px phones and desktop; avoid clipped content and unnecessarily nested scrolling.
- For a new design, define its colors and typography in the artifact. App CSS and design helpers are not injected into the preview. Support light/dark appearance when relevant, and respect reduced motion. When mocking an existing product, follow its design contract.
- Read the completed file back. Verify its primary workflow in an available permitted browser when possible; otherwise state what was checked and what remains unverified. Do not start a live backend or make model calls just to test a local mockup.

For refinements, inspect the existing design directory, read the selected revision, and write the next unused numbered file (`v002.html`, `v003.html`, and so on). Never overwrite an earlier revision. Return the new revision’s standalone link with the same design title. Use a new slug for a different design or an intentional fork. Existing unversioned files can remain separate; do not move or delete them implicitly.

Resources → Mockups collects HTML links from this chat, groups these numbered files by design, and lets the user search and reopen revisions. This is a workspace-file collection, not a durable publication or backup; unavailable files show a read error.

Collapsing and reopening the inline preview preserves its in-memory state; leaving the chat or opening the full file viewer starts a separate preview. Do not promise persistence across reloads or automatic feedback to the agent.
