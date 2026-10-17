# Approved design ledger

This ledger is the source of truth for approved interfaces. Start here before editing
an existing screen, resolving a UI merge conflict or rebasing UI work. A newer commit
or incoming branch does not supersede a design approval.

`ledger.json` records the active revision for each surface, the human approval,
reference bytes, required behavior, owned source files and regression checks.
Chat settings is the first entry; other surfaces can be added using the same format.

## Feature changes and rebases

Read the relevant entry and its reference. Preserve its visual hierarchy, controls,
provider/runtime identity, interaction and accessibility rules. Resolve conflicts in
favor of that approved contract while incorporating the feature's behavior. Run the
entry's checks against the final combined branch, not only the pre-rebase commit.
If a check fails, repair the implementation. Do not remove a check, weaken an
assertion, replace a reference or regenerate an approval to accommodate drift.

## Intentional redesigns

Show the proposed design to the user and obtain explicit approval before changing
the active revision. Append a new revision with the approval evidence, reason,
references and checks; retain the earlier revision and its original reference.
An explicit user instruction prescribing the particular visual change can supply
that approval; record it without asking the user to approve the same change again.
A feature request that says nothing about layout does not authorize a redesign.
An agent's opinion, a rebase, a passing test or a screenshot capture is not approval.
The first Chat settings approval is quoted from its originating conversation.
Implementation captures are evidence of what shipped, not a substitute for the
approved mock or a new approval.

## Enforcement and limits

`npm run test:design` checks that each active entry has approval evidence, intact
reference hashes, protected contract-test hashes and existing active source/test paths. The mandatory offline settings
browser tests enforce row order, neutral surfaces, provider/runtime marks, touch
geometry, responsive bounds, retained drafts, focus and the real editors. CI runs
these with the combined feature branch and retains screenshots for review.

These are semantic and rendered layout checks, not a claim of pixel equivalence.
Critical contract tests are fingerprinted too: a stale rebase cannot silently replace
them with assertions for an older layout. Screenshot evidence alone is not an automatic visual-diff gate. Font rendering,
shared CSS changes and untested details still need visual review against the pinned
reference. Never claim that rebases cannot change the UI: approval rules, CI and
review must all remain in place. Changes to the ledger, references or protections
require the same explicit design approval as changes to the protected interface.

Main's protection was checked on 17 October 2026: it requires up-to-date `ci`,
`Connections browser regression` (the aggregate of the selected browser and offline
layout suites), native checks and `Centaur final LGTM`, with administrator enforcement.
The ledger checks run inside `ci`; the rendered design contracts run through the
required browser aggregate. This work does not change repository protection settings.
