# PR monitor UI recovery and consumer qualification

21 November 2026. Ordinary contributor continuation of UI slice `02cbcc1cf8f74af0`.
No canonical Telos assignment, historical allocation, delivery owner or pending
session proposal was changed. The original contributor's public task and latest
research were recovered before implementation. Its retained checkout was clean at
`805fbd9c9`: no commits, dirty files or additional drafts were found for recovery.
The existing `SessionDetailsDialog` entry point and independent-control contract
were retained. Original work and checkout remain untouched.

## Candidate and scope

This dependent candidate originally used [PR #1432](https://github.com/dimakis/mitzo/pull/1432)
at `7f4c572da48a918ebff189d33406a97b7b486fa0`, which includes
[PR #1427](https://github.com/dimakis/mitzo/pull/1427) at
`f9c4286135f0621ffd53474f70d7d300bef4f7e7`. The prerequisite commits are retained
unchanged. The follow-up integrates published #1432 repair
`897ecd35fd2d3fc5c52a1b04d22139b3584bc6c0`, including #1427 repair
`41f95cd272919afdab46742d20ee0bc7ff14a86f`, as a parent merge without refreshing main.
The subsequent required conflict repair integrates #1432
`4d9803b9a7004c276ed2d86e9c216b8f53d44516`, including #1427
`7c78504282b39c40d8a3be37ba1404fe388300cd` and accepted main `9fa5d6fa`.
This resolves the parents' actual merge conflicts; no independent main refresh
was performed. Only the artifact runtime revision required manual reconciliation.
Review the current UI increment from `4d9803b9a7004c276ed2d86e9c216b8f53d44516`;
land prerequisites first.
The runtime contract is [documented by its owner](pr-monitor-runtime-evidence.md).

The existing desktop/mobile Session details dialog now contains grouped PR rows:
canonical link, full observed head, retained PR/CI/review evidence, last success,
next refresh, stale/error diagnostics, bounded activity and runtime dependencies.
Only a recorded merged snapshot renders merged. No CI/review observation grants
merge authority. Unsupported Auto-fix and Merge when ready remain visibly disabled
with their separate missing-owner explanations.

Add PR uses the existing managed GitHub read-only connection inventory, recent
app reauthorization and registration owner to save a paused subscription. Watch
requires a separate, explicit scope/duration review. Stop uses its existing owner,
including after account/execution loss. Registration and Watch issue never happen
on mount, focus, reconnect or status refresh. No delivery engine, agent wakeup,
model call, second scheduler or production activation is introduced.

The shared consumer validates the real bounded version-1 projection and owner
mutation receipts. The only persistence addition is optional `watchRevokedAt`,
projected from the existing authority row, so revoked consent is not guessed from
a paused lifecycle. Older runtimes lacking that field still show their retained
lifecycle. Two route generic annotations repair inherited TypeScript errors without
changing route behavior.

## Failure and recovery behavior

- Reads and mutations have 15-second browser deadlines. Late responses, logout,
  conversation changes and retired reads cannot restore old authority.
- Browser online/focus/visibility and existing EventBus reconnection refresh
  retained status only. A 30-second browser freshness lease gates new consent;
  the local clock schedules no GitHub reads or agent work.
- Refresh failures preserve labelled retained evidence. Missing live execution
  disables registration/issue but keeps retained status and Stop available.
- Scope/revision changes while a Watch review is open require a new review.
  Merged/removed subscriptions cannot renew Watch. Expiry, revocation and the
  durable pending-revocation checkpoint remain distinct.
- Browser request identity and original scope survive closing/reopening details
  within the same page/login. Retry is always explicit and uses the same request.
  Passphrases and CSRF proofs are not retained. Authentication changes clear this
  browser recovery cache. Full page reloads lose unresolved browser-only issuance
  and registration requests; inspect retained status before new consent. Durable
  server revocation checkpoints remain recoverable across full reloads/restarts.
- A failed reauthorization before dispatch is distinguished from an uncertain
  write. Neither an HTTP success with a malformed receipt nor a failed Stop is
  presented as confirmation.

## Validation

The final focused run passed **389 tests in 24 files**, with one existing skipped
design-reference test. It includes 12 rendered interaction/failure tests, three
adapter-to-consumer integration tests, the real EventStore/projection/consent and
GitHub reader/controller suites, and the complete design guard suite. Tests were
observed failing before the corresponding implementation increments.

The integration test uses the actual observation controller, interactive authority,
GitHub adapter and EventStore, then the production consumer decoder. It injects an
adapter failure, verifies retained stale evidence, recovers a missed force-push,
loses execution access and verifies persisted revocation through the same consumer.
No network GitHub collector or model is used by these tests.

Protocol, harness and client TypeScript builds and production frontend build pass.
Changed-file ESLint, Prettier and `git diff --check` pass. Full root server typecheck
and repository-wide CI remain landing checks.

The dependency-repair follow-up passed 33 focused tests in six files: controller,
consent, Access router, rendered UI, actual adapter-to-consumer integration and
source-artifact drift checks. The parent supplies the typed connection fixture;
its identical router annotations reconcile without behavior changes. Combined
source-artifact validation passes at runtime revision `v1.0.1272-pr-monitor-ui`,
preserving all 2,623 parent registrations and refreshing the three UI-modified
registered sources. The earlier 389-test/build evidence remains attributed to the
original UI candidate; full test-inclusive TypeScript/CI on the new combined head
and the previously blocked browser validation remain landing requirements.

The actual-conflict repair then passed 43 focused tests in seven files, adding
the inherited Claude turn-attribution regression suite to those six suites.
Source-artifact validation passes at `v1.0.1275-pr-monitor-ui`, retaining all
2,625 registrations from the corrected parent and accepted main. The only manual
conflict resolution was this runtime revision label; the three UI source hashes
remain intact. Current-head full CI, TypeScript and browser gates remain open.

## UI design and remaining browser verification

The implementation reuses `SessionDetailsDialog`/`HomeDialog`, `MotionDetails`,
`MotionPresence`, semantic status colors, shared type/spacing/radius tokens and
44px control-height role. It adds no persistent composer panel. Exact heads and
long titles wrap within the quiet grouped rows; activity is disclosed on request.

`npm run test:ui -- --grep 'PR monitor:'` built successfully, but browser startup
was blocked in this host executor. After locating installed browsers, Chromium
failed its macOS Mach service permission check (`bootstrap_check_in`, permission
denied 1100); WebKit startup timed out. No sandbox bypass was attempted. **The six
browser cases did not run, and screenshots/visual inspection are not claimed.**

The committed intercepted fixture covers the real Session details dialog at 320px
and desktop widths, light/dark themes, Mint/System and Teal/Georgia, keyboard
consent, failed reads, reconnect/account loss, Stop, focus return, draft retention,
overflow and touch geometry. Run it on an admitted browser host before landing:

```sh
npm run test:ui -- --grep 'PR monitor:'
```

Keep this PR draft. CI and independent exact-current-head Centaur final LGTM/merge
recommendation remain required for later serialized landing. The backend's
delivery/Auto-fix/landing ports, webhook/reopen behavior and other runtime limits
remain those documented in #1432; this UI does not imply they exist.

## Local commit provenance

- `f38d1e270`: shared projection decoder and actual adapter/consumer test.
- `153a4e2d6`: grouped rows, registration/consent, reconnect and offline fixture.
- `821e185f2`: owner receipt validation and persisted revocation evidence.
- `cff31f142`: exact unresolved request recovery across dialog remounts.

Original public research: chat `3675c5ae-c625-85fe-b707-f718da5e6c88`, initial task
at sequence `7195333` and latest investigation through `7211674`. The exact backend
contract was confirmed once with contributor `f0616a37-9e94-8c40-9291-f6ea0d459dac`.
