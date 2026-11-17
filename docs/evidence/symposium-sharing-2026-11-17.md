# Symposium message sharing — 17 November 2026

The operator approved the revised sharing design and the bounded related fixes in
shared conversation `9a999953-4124-44d6-8638-3c4b80d2174f`, operator sequence 74.
The existing header, composer, message bubbles, Reply quote and date/time treatment
are retained. Earlier shared-composer approval references and protected check hashes
remain unchanged; the design ledger appends the scoped approval.

This increment builds on PR #1379 at `e861941faa81c363e616374924d79b193797506d`.
It changes the message menu and existing review surface, using shared tokens,
HomeDialog, ordinary source readers and exact forwarding/recovery owners.

## Result

- Send to agent and Select messages are menu actions. Blocked sharing stays visible
  with its reason and, where applicable, original-operation recovery. The canonical
  shared transcript gets the same actions as the ordinary-history wrapper.
- Recipient rows show known recorded type, name, profile/revision, model, thinking
  and account. Missing configuration is explicit; none of this establishes readiness
  or transfers execution permission.
- Source selection shows exact authors and recorded dates, short cached excerpts,
  and full Markdown only on expansion. Opening selection does not fetch another
  transcript or recreate the conversation's rendered message tree.
- Interleaving failures no longer claim that overlapping assistant messages were
  user steering. The `snapshot_changed` guard remains in place. The earlier explicit
  steered-turn diagnostic remains understood for existing callers.
- A pre-existing ChatArea generic-inference error reproduced against the original
  PR head under the same source type check. An explicit `ReactNode` type argument
  fixes it without a runtime change. Duplicate DOM setup in the composition fixture
  was consolidated so individual tests do not depend on earlier tests' side effects.

## Verification

Red was observed before the diagnostic and sharing changes, including the canonical
shared-message action gap. Focused checks then passed:

- 135 tests across nine protocol/history/menu/shared-conversation/forwarding/sending
  files, with one worker and a 1 GiB Node heap.
- 32 ChatArea and metadata tests across two files after the type-only correction.
- Three real authenticated application/UI forwarding and lost-confirmation checks
  across two files. Initial missing installed internal dependency was corrected by
  reusing the existing `sqlite-file-owner` package; subsequent runs passed. Existing
  React `act` warnings are retained in the test output.
- 109 design checks passed, with one existing environment-conditional check skipped.
- Changed-source semantic TypeScript checks passed for all six modified frontend
  implementation files; this is not a full-project compilation.
- Affected ESLint/Prettier and registered source fingerprint checks passed.

Accepted main `f986db0cc3794147c2ac95f10d35965769c8efba` was integrated into
the isolated feature branch. Only the runtime revision marker conflicted; all
registered source keys from both parents were retained and source fingerprints
verified. Seven integration suites then passed all 105 tests, covering the changed
sharing consumers, transcript adapter and accepted Claude composer/steering changes.

Offline browser coverage was added to the actual shared-composer fixture for phone
and desktop, dark/light and alternate appearance. It checks menu selection, agent
details, recorded dates, on-demand Markdown, unchanged header/draft, native Reply,
zero forwarding writes before confirmation and no private participant-history read.
Playwright listing succeeds: the composer selection contains 26 tests including
browser-startup controls. Listing is not browser execution.

Rendered checks remain pending. The preceding explicitly approved browser attempt
failed at Chromium's macOS process registration before page load (`permission denied
1100`, SIGTRAP); it was not repeated. CI must run the new browser cases and provide
captures for inspection. No local screenshots, physical-device success or production
activation are claimed. All tests here replace external execution/provider effects;
no real model calls were made.

## Remaining boundaries

The live-discovery refresh problem and support for legal steered-turn ordering remain
separately bounded repairs. This increment does not delete transcript validation,
change frozen source/audience contracts or replay uncertain delivery. It does not
resolve all 24 findings in Telos feature `0e7adf5e27292950`.

PR #1379 is now draft and held behind #1387. Preserve that dependency hold. After
#1387 lands, reconcile its repository-source diagnostic with this branch's earlier
diagnostic, retain the sharing and generic interleaving fixes, and regenerate pins.

Source commits, publication, current-head CI/Centaur review, merge and production
activation remain separate. The previous PR head's CI was failing; its prior Centaur
recommendation cannot qualify the new head. A specialist authorization attempt failed
before saving a policy; no new specialist contribution or independent review is
claimed by these local checks.
