# Symposium approved fresh-agent surface

The reference bytes retain the user's 16 October 2026 approval recorded in Telos
artifact `d2b5bce4090c39a595457335763271b5`, revision 1. The HTML and review image
are original approved references. Registration does not create a new approval.

`SymposiumApprovedSetup.test.tsx` protects the approval identity, reference pins,
runtime ordering, footer copy, repository display, unavailable review and retained
draft on Cancel. `symposium-approved-design.spec.ts` exercises the actual shared
chat components with intercepted transport across mobile/desktop and light/dark;
it also checks footer reachability, focus, drafts, overflow and runtime order.
`symposium-joining-review.spec.ts` covers the separate Before joining surface.
These browser fixtures establish presentation behavior only.

Combined branch rendering, independent comparison and actual application joining
acceptance remain pending while recovery and reconciliation are integrated.
No implementation screenshot is represented as the approved mock. Web evidence,
native iOS inspection, backend composition and live runtime qualification have
separate acceptance records; this ledger entry does not establish them.
