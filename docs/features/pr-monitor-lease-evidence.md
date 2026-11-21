# Passive Watch: shared SQLite observation custody

21 November 2026. Ordinary contributor `ce05b581-8455-8cc8-ab30-2804ed3fdce0`,
coordinated by `d933a61d-7363-85ab-a329-93e6dc5a2050`. Dependent draft on
[#1432](https://github.com/dimakis/mitzo/pull/1432), pinned to
`7f4c572da48a918ebff189d33406a97b7b486fa0` (including #1427
`f9c4286135f0621ffd53474f70d7d300bef4f7e7`). Source candidates, Telos items and
assignments remain unchanged. This contributor claims no canonical ownership.

## Behavior and persistence

Previously, two observers could collect the same subscription independently.
Success compared subscription and snapshot revisions in its transaction, but
failure compared only subscription revision after a separate caller-side snapshot
check. An older failure could clear a newer snapshot's delivery outbox.

`PrMonitorLeases` borrows the existing EventStore database through `PrMonitorStore`.
An immediate SQLite transaction acquires a claim for the exact operator,
conversation, subscription and subscription revision. Each acquisition gets an
opaque random token and a strictly increasing fencing generation. An existing
unexpired claim coalesces the competing observer before any authenticated read or
quota charge; it produces no failure write.

The claim lasts 30 seconds, allowing cleanup beyond the existing 20-second
collection deadline. It is never extended. The observer checks custody through
the existing before/after authenticated-read callback, including the GitHub
adapter's individual HTTP reads. Both success and failure require the claim
inside one immediate transaction, before and after their writes. Both compare
subscription and snapshot revisions in that transaction. Revocation checkpoints,
renewal and conversation stop/removal invalidate prior tokens in their existing
mutation transactions. Cleanup releases only the matching token and generation.

One row per retained subscription keeps its fencing generation and observed clock
high-water mark across release and restart. Backward/invalid clocks or expiry
invalidate a matching token conservatively. If the final publication fence fails,
the observation rolls back and that exact token is retired separately, preserving
the observed clock bound. A failed persistence operation grants no claim. If
cleanup cannot be confirmed, the observer logs the stage and sanitized SQLite code;
expiry remains the recovery boundary. Cleanup cannot replace an original failure.

Observation custody grants no login, command, delivery, Auto-fix or Merge authority.
The existing scheduler owns tick and drain; no heartbeat or second scheduler was
added. A noncooperative in-flight request can still finish after takeover. Its
publication is fenced and its quota charge remains; this is not an exactly-once
network guarantee. Quota reservation and authority receipt retention are unchanged.

## Interfaces and integration

- `EventStore.prMonitor.leases` supplies `acquire`, `assert` and compare-token
  `release`, using the same SQLite owner. No second database is opened by the feature.
- Internal `publish` now requires `claim` and `now()`. Internal `fail` takes a
  structured argument including `expectedSnapshotRevision`, `claim` and `now()`.
  The observer is the production consumer of both methods.
- UI projection and optional fields are preserved. No HTTP contract changed.
- Observer changes are confined to custody, publication/failure plumbing and
  sanitized diagnostics. External-CI normalization/findings and quota/controller
  registration remain with their sibling owners; no sibling commits were imported.

## Offline qualification

312 tests across 18 files pass: the original 287 tests across 16 files plus 25 new
lease/consumer regressions. Vitest uses one test worker and a 1 GiB Node heap. One
test creates two independent EventStore worker-thread handles, then releases an
atomic barrier to attempt acquisition simultaneously; exactly one receives custody.

Coverage includes separate subscription claims, crash/reopen expiry takeover,
stale success/failure/release, revoke/stop/delete/renew during an awaited read,
SQLITE_BUSY acquisition/release, transaction rollback, final success and failure
expiry fences, backward clocks, bounded storage, and drain with a successor still
reading. A composed runtime test exercises the real consent, GitHub reader, quota
owner and observer boundaries with injected offline HTTP: late response takeover
retains the successor snapshot and all 19 charged reservation records. Existing
SQLite consent, runtime, scheduler, authentication and EventStore regressions pass.

Protocol, harness and client TypeScript builds pass. A focused server check of
`server/pr-monitor-*.ts` and `server/github-read-response.ts`, extending the root
configuration, passes at 1 GiB. Changed-file ESLint, Prettier and `git diff --check`
pass. Full application build/typecheck and exact-head CI remain landing gates;
there is no claim of full application verification. No browser, live model,
live Watch activation, merge or deployment was performed.

Tests were observed failing before claim implementation and observer integration.
Further failing regressions drove preservation of clock bounds after a rolled-back
publication and accurate publish-stage/SQLite diagnostics without mislabeling HTTP
failures as storage failures.

## Existing owner limitation and landing gates

Simultaneous EventStore construction on the same file produced `SQLITE_BUSY` in
the pre-existing `EventStore.migrateSymposium` update at `event-store.ts:3904`
(transaction ending at line 3929), before claim acquisition. That migration owner
is outside this change. The concurrency test initializes each EventStore in turn,
then races acquisition using independent live handles. Concurrent process startup
needs separate database-owner qualification or serialization. This gap was reported
to the coordinator; migrations were not modified to conceal it.

The guarantee is limited to controllers sharing one SQLite file on the same host.
Mixed-version controllers that bypass claims must not run concurrently. It does not
claim distributed deployment safety. A failed initial revocation write still cannot
be described as durable; the existing consent owner's fail-closed behavior remains.

Later landing requires exact-head CI, trusted Centaur final LGTM and `merge`
recommendation, the valid App-bound status and zero blockers. This draft authorizes
none of those later actions. If publication uses `main` as the base, review the
incremental comparison from exact #1432 SHA above to this candidate's published head.
