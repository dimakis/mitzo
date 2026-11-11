# Shared tool and approval headers

Dimitri approved `shared-headers-v001.html` in Mitzo conversation
`27a9fc7f-a330-8d00-bfe7-de0e2fab4224` on 10 November 2026:
“Yep. For every tool. Build it”. This follows the explicit direction:
“Approval button should be up at the top. Easily clickable beside the main thing
we’re doing. Not buried at the bottom.”

The reference is an exact copy of the interactive mock shown in that conversation
(`mockups/approval-tool-cards/v001.html` in the originating management workspace).
It establishes the shared operation header, top primary action, secondary menu,
optional evidence disclosure and quiet settled rows across web Chat and Inbox.
The phone/desktop, theme, font, state and tool-family selectors are mock controls,
not new product settings.

`OperationCard` owns the layout and disclosure. `ApprovalCard` owns the common
approval presentation, retaining the existing source-review controller and
notification/chat response transports. Known command and access facts remain
visible. Original evidence is inspectable without moving the decision below it.
Specialized setup, task review, worker receipts and delegated activity use the
same header while preserving their original validated links and ownership.
Actionable setup and review receipts stay outside collapsed activity.

The existing native Watch review surface, chat settings, composer, source-save
semantics and approved nested child inspection remain under their own contracts.
This approval changes web tool/approval presentation; it grants no execution,
publication, merge, source-adoption or deployment authority.

Validation is recorded in `docs/features/inbox-direct-approval.md` and the PR.
Local browser process registration is blocked by macOS in this environment; no
new rendered screenshot or production acceptance is claimed. CI must run the
updated offline fixtures on phone WebKit/Chromium and desktop Chromium.
