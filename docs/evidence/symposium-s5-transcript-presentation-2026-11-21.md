# S5 transcript presentation candidate — 21 November 2026

Base: `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76` (fresh remote main).
Branch: `fix/s5-transcript-presentation`. Ordinary contributor; Telos linking deferred.

## Boundary and behavior

- Trusted specialist sends retain optional `origin: { sessionId, requestId }` separately
  from operator authorization. Public `CollaborationMessageInput` cannot supply it.
  Acceptance and exact-send retries check that origin; observation/Stop retain their
  existing receipt owners. Verified ordinary reply sources and S3 qualification are unchanged.
- Presentation uses the actual origin for agent assignments. Original canonical,
  projection and ordinary message IDs remain intact. Frozen replies and exact aliases
  preserve author, quoted text, source navigation and delivery identity after completion
  and reload. Ambiguous native packets cannot invent a quoted prompt.
- Native start sequences order ordinary finished/live rows; shared sequence and exact
  command/source anchors merge the independent sources. Independent sequence domains
  and clocks are never compared. An old live echo cannot duplicate its completed row.
- Optional `CollaborationView.seatOrder` derives from retained membership revisions,
  including removed participants. The client appends newly observed members without
  recycling old slots. Shared labels, recipient marks and bubbles consume one palette
  provider, mounted across ordinary/shared transitions.
- Activity groups identify the real seat. Readable operation summaries replace raw
  JSON in their headers; existing disclosures retain all technical input and results.
  The 35% name cap reserves room for the summary on narrow screens; the full name stays
  in the accessible control label and expandable attribution.

Historical records that never retained automated origin remain unchanged. This change
does not infer an author from nearby text or manufacture chronology without source
evidence. No dependency on S3 draft #1434 is required; its optional start/steering
qualification fields and frozen-capture validation are not changed here.

## Verification

Test-first regressions initially produced seven failures: missing trusted origin,
missing retained roster order, incorrect author mapping, lost reply linkage, native
completion ordering, color collisions and activity attribution. A separate mounted
live/completed chronology test failed before its ordering repair.

The combined focused run passes **192 tests in 13 files**, covering the real specialist application adapter, persistence/reopen,
public input rejection, retry identity, message delivery/recovery, mounted transcript
and ordinary/shared composition, scroll stability, activity and roster colors.
Shared protocol/harness/client package compilation passes. Touched-file ESLint passes.
The design suite passes 109 tests with one pre-existing skipped check.

The offline `symposium-transcript-presentation` fixture bundles and lists six scenarios
(light/dark across desktop Chromium, mobile Chromium and mobile WebKit). It covers
author/recipient presentation, streaming/completion/reload, removal without recoloring,
keyboard disclosure, technical detail, touch height and overflow. Browser execution
could not run: the executor had no installed binaries and Playwright's CDN repeatedly
closed the browser download connection. No screenshots or visual acceptance are claimed.

The full server typecheck exceeded the required 1 GiB heap. Full server/frontend build,
the complete unit/browser suites, phone/desktop visual inspection, current-head CI and
final Centaur approval remain delivery/merge gates. No model call, merge, deployment,
staging action or production test was performed.
