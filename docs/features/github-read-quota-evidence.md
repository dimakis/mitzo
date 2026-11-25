# Shared authenticated REST quota and reservation retention

21 November 2026. Dependent implementation on PR #1432, exact head
`7f4c572da48a918ebff189d33406a97b7b486fa0`. PR #1427
`f9c4286135f0621ffd53474f70d7d300bef4f7e7` remains in its ancestry. This work uses an
independent ordinary contributor checkout and does not change Telos assignments.

## Behavior

The existing EventStore `githubReadQuota` now admits explicit PR registration,
background observation and ordinary authenticated `GitHubRead`/TaskExecution
reads. Public reads retain their separate transport and consent boundary. The
credential owner remains the existing trusted native GitHub reader. No second
database, scheduler, credential owner or UI is introduced.

Registration's `/user`, opening PR and closing PR reads each reserve and consume
one charged receipt. Identical concurrent registration requests coalesce through
the existing controller. Registration still creates a paused subscription; it
does not issue Watch consent or activate observation. CSRF, recent interactive
authorization, current account/connection/execution fences and the five-per-minute
route limit remain in place. No live registration or Watch activation was run.

Before a trusted numeric identity exists, one durable identity escrow probe is
allowed per minute under the same global concurrency bound. Failed or cancelled
probes retain debt. A successful trusted `/user` response attributes that debt to
`github:N`; the request's caller cannot choose the attested principal. Later
identity probes use the last attested principal for admission and verify the
actual numeric identity again. A changed identity conservatively charges the new
principal as well, without refunding the original admission. Unknown-identity
Retry-After survives restart. Ordinary authenticated repository reads therefore
perform a charged `/user` attestation followed by a charged endpoint read.

Foreground/background requests share 20% headroom, half the available background
allocation, a paced background burst of 16, 60 requests/120 points per minute,
four global in-flight reservations and two per connection. The observer retains
its independent 16-call/20-second refresh bound. The adapter charges each actual
transport call rather than assuming a fixed refresh cost; additional external-CI
reads consume that same bound. Missing/invalid metadata produces backoff, and
Retry-After is retained independently of whether quota metadata is usable.

## Retention contract

- New IDs are `q1:<durable epoch>:<uuid>`, minted by the quota owner.
- An exact `reserve` retry returns the original ID and expiry. Conflicting inputs
  fail. A separate durable `start` claim allows at most one HTTP dispatch; finished,
  consumed, absent or expired receipts cannot dispatch again.
- At capacity, minting compacts only receipts outside the full minute accounting
  window whose expiry has passed, and advances the epoch in the same SQL
  transaction. Forgotten old IDs cannot become fresh reads. Retained old receipts
  still return their original expiry and one-use state.
- New admission bounds the ledger to 4,096 reservations. Each request/principal/
  connection field is bounded to 200 UTF-8 bytes; the reservation logical payload
  stays below 4 MiB. The shared EventStore database/WAL is not claimed to have that
  physical file-size bound. Principal state is capped at 128 rows and is not
  silently forgotten. Capacity fails closed with a retained-quota diagnostic.
- Legacy reservations migrate as already consumed. Uncertain expiry and finish
  never refund charges. Unknown-identity debt survives receipt compaction.

Event payload history and `pr_monitor_requests` authority receipts are untouched;
their replay and retention obligations are different. Multiple-controller leases
and the initial revoke-checkpoint storage failure remain outside this work.

## Validation and blocker

Passed: **19 focused checks** using Node 24's SQLite implementation and the actual
quota/admission/parser source, one worker and a 1 GiB heap. These cover shared
foreground/background contention, concurrency/request/point/headroom/burst bounds,
unfinished restart, exact/conflicting retry, one-use/expired dispatch, compaction
at capacity, old-epoch replay, row/logical-byte bounds, SQL transaction rollback,
transport failure/cancellation, changed authority/account, missing/stale metadata,
HTTP-date Retry-After and bootstrap backoff across restart.

Reproduce with:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node --experimental-transform-types \
  --test --test-concurrency=1 scripts/verify-github-quota.offline.mts
```

The fallback harness adapts Node SQLite's synchronous transaction boundary to the
production owner's API. It **does not qualify better-sqlite3, the real controller,
consent, runtime or native transport suites**. Those existing suites remain in the
tree, with added Vitest registration/admission/transport/retention regressions;
they have not been run in this checkout. TypeScript builds, ESLint and Prettier
also remain unverified. The previous PR's 287 passing tests and targeted builds
are baseline evidence, not a claim about this head.

The qualified dependency installer lost the required proxy environment, hit npm
registry `ENOTFOUND`, and timed out. Original TaskExecution request
`2cbf791f-8454-420c-868f-c3a41659fdf0` remains uncertain. The supported receipt
lookup has not proved its process group stopped; process inspection is blocked by
the host fence. No installer retry, alternate installation or borrowed dependency
tree was used. The coordinator supplied the corrected #1428 installer hashes for
use only after that original operation is reconciled. This is a validation blocker.

No paid/live model tests, browser tests, full builds, CI monitoring, live Watch,
merge or deployment were performed. CI and exact-head Centaur final LGTM, merge
recommendation and the valid App gate remain later landing requirements.
