# Direct Inbox approvals

Dimitri requested this change on 10 November 2026 in the originating Mitzo
conversation: “I don’t like the fact I need to click the details to get the
approval button on the card. It should be one click, no scroll.” The supplied
phone screenshot shows the Inbox session-approval inspector.

Pending approval entries now offer Allow once, eligible Allow for session, and
Deny alongside the existing review navigation. The full inspector puts the same
controls before its scrolling evidence. Questions retain their answer form.
The server continues to own request identity, expiry, scope and settlement.
Resolved, archived and expired entries have no direct approval controls; pending
decisions disable controls and rejected submissions leave a visible error.

The implementation reuses collection records, notification controls,
ApprovalRequestSummary, semantic accent colors, UI font and spacing/radius scales.
The approval grouping retains the existing collection surface; decision buttons
are separate from the review button, with no nested interactive elements.

## Validation as of 10 November 2026

- 151 focused unit/design checks passed, with one existing skipped design check.
- Changed TypeScript passed ESLint; changed files passed Prettier and Git whitespace checks.
- Expanded the existing notifications browser fixture for direct and inspector
  decisions, full visibility before clicking, 44px targets, long input, phone and
  desktop layouts, dark Mint/System and light Teal/Georgia preferences.
- The full UI build exceeded the required 1 GiB local Node heap. A smaller
  fixture containing the real Inbox components compiled successfully, but macOS
  denied Chromium process registration. An escalated native run was also blocked
  by the repository's sandbox guard. No rendered screenshot or visual acceptance
  is claimed. Full typecheck/build and browser execution remain required in CI.

Prepared from local Mitzo source revision `9f165ea599d8`. This record documents
the requested behavior and local verification; it does not establish merge or
production deployment.
