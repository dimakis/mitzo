# Symposium starting-context selection (finding18)

Candidate from accepted main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`, on
`fix/symposium-starting-context-finding18`. Ordinary contributor; canonical feature
lead remains `b0ea73a5-3a4a-8374-84b2-6fedb68501f8` for `0e7adf5e27292950`.
This is the Symposium source selector, separate from the native context inspector.

## Scope and prior work

The 21 November instruction explicitly requests compact selectable messages,
actual author/time/type, expandable formatted preview, search/author filtering,
collapsible recorded progress, stable counts and exact retained-artifact distinctions.
The implementation preserves the active fresh-agent ledger, compact settings editor,
Before joining review/refreeze, original request recovery and immutable selections.

Inspected current source guide, repository/frontend instructions, motion/UI contracts,
approved fresh-agent references and source-context item `358d56cb7e4352ff`, including
accepted #1328. Closed unmerged #1379 (`0ca328701c59ea9c661114307ace710ec6eaecc9`)
provides the inexpensive excerpt/lazy formatted expansion pattern. Reused that pattern
with existing shared disclosures and sanitized Markdown; no branch was copied.
S5 #1442 (`3197a24180796e05c153f6f67875550c0ca71c19`) owns shared transcript origin/reply
presentation; P1 #1437 (`caa0f5f5650bc41188ebbf1f48cf73d46194f0a5`) owns the specialist
context envelope; S3 #1434 (`a5b272aeeb0908abb564d9e0ff1d50d2cd705050`) owns durable
source validation. This change has no code dependency on those candidates.

## Owned interfaces and behavior

- `ConversationContextSelection` renders existing eligible text-message IDs and
  exact artifact `(artifactId, revision, sha256)` pins. Search, author filters,
  preview, progress disclosure and selected-only review never alter selections.
  Missing selections remain counted and explicitly removable. No select-all or
  automatic file/reply inclusion was introduced.
- `ConversationAgents` supplies its known ordinary source-agent name only for rows
  without their own recorded provenance. Peer sender and recorded seat provenance
  take precedence over role labels; missing author/time are labelled honestly.
- The application joining adapter adds a lazy read of the existing typed
  `sourceArtifacts` endpoint with its existing source, connection and authentication
  fences. It rejects wrong-source or retired-authentication responses. The catalog
  hook cancels hidden/retired reads, preserves selections and exposes sanitized
  failure diagnostics and an explicit retry.
- `SharedConversation` supplies that read only after retained membership exists.
  First-time Add agent explains the unavailable catalog. Inspection never calls
  `begin`, review, preparation, joining or inference to make artifacts available.
- Available and unavailable retained references remain distinct from local paths.
  The existing catalog has no author or access label, so those are shown as not
  recorded rather than invented. Availability permits selection for existing review;
  it is not a grant. The later source compiler still revalidates exact bytes/access.

No changes to public source schemas, reviewOf provenance, review/refreeze hashes,
storage, sharing authority, access grants, composer, Agents-panel ownership or
native context capture. The selected context still crosses the existing reviewed
owner only after explicit Review joining brief.

## Verification

Tests use task-local dependencies, one worker and a 1 GiB Node heap. The focused
selector, real typed-client/catalog consumer, approved setup, application joining
adapter and joining/refreeze hooks passed 89 tests in six files. Existing joining
review, Agents and usability regressions passed 20 additional tests. Two additional
real-host regressions prove the unbegun/existing association distinction and zero
sharing mutations on inspection. All 111 focused cases passed across these runs;
the final lazy-preview change reran its eight selector/host cases successfully.
The design suite passed 109 tests with one pre-existing skip. Targeted ESLint,
formatting and scoped source-alias TypeScript checking of the changed components,
adapters, tests and browser fixture passed. The existing joining review regression proves exact artifact selection,
snapshot counts, explicit refreeze and original confirmation identities.

New interaction coverage checks filters and hidden counts, stale ID/version removal,
safe formatted preview, no image/file fetch, keyboard Escape/focus restoration,
recorded peer identity and explicit progress metadata. Catalog consumer coverage
uses the real `MitzoApiClient`/joining adapter: read-only endpoint shape, unavailable
reference selection, failure/retry, wrong-source rejection, auth retirement and
late-response cancellation. No browser fixture is presented as backend acceptance.

Offline browser discovery/bundling succeeds for six theme/layout cases plus two
browser startup checks. The focused actual browser attempt ran zero UI cases:
task-local browser executables were absent. Installing Chromium/WebKit into this
task failed when the CDN closed the Chromium download connection. No screenshot
or visual inspection is claimed. The committed fixture covers 320px/desktop,
dark Mint/System and light Teal/Georgia, keyboard control, 44px targets, horizontal
bounds and screenshot capture for CI. Full `test:ui`, full compilation, final
render inspection and physical iOS qualification remain open.

## Remaining boundaries

Ordinary `FinishedMessage` does not expose a progress/final discriminator. The
selector collapses progress only when a caller supplies recorded presentation
metadata; the fixture marks that metadata synthetic. This is not proof of production
progress classification. Extending the source adapter needs its own agreed contract.
Likewise artifact authors/access require recorded metadata from their existing owner;
the current absence is explicit. First-time pre-sharing artifact selection would
require a deliberate read-owner contract change, not an implicit begin operation.

Publication is a draft candidate only. Exact-head combined CI and trusted Centaur
LGTM remain merge gates; no merge, deployment, model benchmark or live inference
was performed. A same-family Astra peer review caught the unbegun-source catalog
prerequisite and it was corrected; this is not independent Centaur approval.
