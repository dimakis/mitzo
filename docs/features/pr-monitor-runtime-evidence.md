# Passive PR Watch: application integration and qualification

21 November 2026. Ordinary contributor `f0616a37-9e94-8c40-9291-f6ea0d459dac`,
slice `f33fa8e53e954ec3`. This is a dependent implementation draft on
[PR #1427](https://github.com/dimakis/mitzo/pull/1427), whose candidate remains
`f9c4286135f0621ffd53474f70d7d300bef4f7e7`. It does not change historical Telos
allocations or delivery/UI/merge ownership. The original observation evidence
document describes that earlier candidate; this document supersedes its runtime,
Centaur and event-retention gaps only as described below.

## Delivered behavior

The application now composes the observation controller from the existing
EventStore, connection store, interactive authentication, account binding and
authenticated native GitHub GET owners. `SessionPromptService` supplies its
existing tick, maintenance hold, removal and drain lifecycle. No additional
scheduler, command admission or model-generation port is introduced. Construction
and registration do not enable Watch. An explicitly reviewed, expiring Watch is
required before background reads; Auto-fix and Merge remain separate.

Registration reads `/user` and the canonical PR twice, checking current managed
read-only connection assignment, account and repository scope before and after
each read. It persists a paused subscription with numeric authenticated principal,
canonical repository/PR identity and a frozen execution scope. The same registration
request is idempotent. Scope mutation and a transport that ignores abort are tested.

Retained ordinary admission supplies the background conversation fence without
reopening a browser or starting a provider. Removed/hidden/stopped conversations,
account revision loss, workspace/mode/binding changes and connection changes fail
closed. Cold SQLite/auth restart tests reconcile a missed force-push and prove
persisted logout blocks subsequent reads even without an in-memory browser login.

Watch revocation first commits a separate durable pause/checkpoint, then updates
authority. An injected SQLite authority-write failure leaves Watch paused across
restart and exposes the exact pending request for retry. Current interactive
operator authentication can inspect retained status and revoke after execution or
account context disappears. Issuance still requires current reviewed scope.

Centaur evidence supports the repository's actual head marker, `Centaur Review`
heading and structured Convergence fields, from both review and issue-comment
records. The configured `CENTAUR_REVIEWER_LOGIN`, or repository owner fallback,
is compared case-insensitively. Stale heads, ineligible authors, ambiguous reports
and unsupported human-decision reports cannot produce automatic actionable work.
A blocking report becomes one bounded report-level finding with a digest and exact
source reference. Prose is not retained as a command; a clean report is not merge
authorization or the independent final landing review.

Each refresh allows at most 16 actual authenticated HTTP calls in 20 seconds,
including identity and closing-head verification. A no-workflow refresh uses nine;
three, five and seven workflows use 12, 14 and 16. Eight workflows produce explicit
partial state at 16 calls, with no actionable outbox. Quota discovery, pacing,
headroom, concurrency limits and backoff remain enforced. The initial paced burst
is now 16, still bounded by the principal's allocated background share.

Retained event history keeps all current-generation identities up to 1,000 events
or 1 MiB, and up to 100 superseded-generation events or 128 KiB. Capacity pauses
Watch with `retention_limit`; it never silently forgets current-head deduplication.
Compacted generations cannot recur: returning to an older SHA creates a new
generation. `compactedEvents` and lifetime distinct-event counters expose this.
The public event projection remains limited to 20 references/16 KiB.

## Shared consumer contract

All endpoints are beneath `/api/sessions/:id/access-grants`:

- GET `/pr-monitor` returns `executionAvailable`, nullable `executionDigest` and
  bounded `PrMonitorProjection[]` subscriptions. Current interactive operator
  authentication and a visible ordinary conversation are required. Retained status
  remains readable when execution is unavailable.
- POST `/pr-monitor` registers a paused subscription. Input is `requestId`,
  `connectionId`, numeric `connectionRevision`, `owner`, `name`, `pr`,
  `expectedExecutionDigest` and recent-authorization `csrf`. Response contains
  `projection` and exact `reviewedScope`. It requires same-origin JSON, existing
  Access intent/live ownership, recent reauthorization and a five-per-minute limit.
- POST `/pr-watch/:subscriptionId` issues/renews explicit Watch with existing
  revision/scope/duration/CSRF fields. POST its `/revoke` suffix retains the existing
  revision/request fields; revocation does not require an available account.

Protocol owner: `packages/protocol/src/pr-monitor.ts`. The projection adds numeric
`compactedEvents` and nullable `revocationPending` containing request and expected
revision fields. Reference kind includes `comment`, using an exact GitHub
`#issuecomment-N` URL. UI must not infer current execution availability from an old
successful snapshot. Delivery must independently revalidate freshness, authority,
head/generation, eligibility revision/digest and outbox timing through its own owner.

## Offline validation

287 tests across 16 focused files passed using one Vitest worker and a 1 GiB Node
heap. This includes the original 12-file suite plus controller, application fence,
Centaur parser and scheduler lifecycle tests. Protocol/harness/client builds and a
focused server TypeScript check passed, as did changed-file ESLint, Prettier and
`git diff --check`. Full root TypeScript previously exhausted the permitted 1 GiB
heap; full application/repository checking remains CI work. No paid model calls,
live collector activation, production deployment or merge was performed.

Atomic implementation commits (tests and implementation together):

| Commit                                     | Increment                                           |
| ------------------------------------------ | --------------------------------------------------- |
| `2ed6d6ceca7eeaf7260984ce0591d97d9490f308` | Existing scheduler lifecycle integration            |
| `9268baf61585bc37e7ec0238d68bd581f6556910` | Canonical paused registration and connection fences |
| `dcb60d7462f9d12ed139e17dc8fa8ca0ab68a53f` | Access registration/projection routes               |
| `33fca587e7f74994af41649a21847947a0429704` | Application owner wiring and retained admission     |
| `e9c1ca10e5cfa2e65bc114bb89aeb41ec4d4edab` | In-flight mutation and abort fences                 |
| `bc9d92be944f086bdf710b562ffea7cf9344cf27` | Durable failed-revocation checkpoint                |
| `e9d380309b86ad8082d5a9b0fca034254d9ca322` | Actual bounded Centaur format parser                |
| `170de98d3dfbac848668aa560d7d948648c96dce` | Review/comment collection and author policy         |
| `cec99fcce3631a8363d980486dfaa97af4c4a189` | Bounded multi-workflow refresh                      |
| `af6082349deb9adc6c06a9ba81b9a0d0ea10d4b6` | Retained status/revocation after account loss       |
| `cc6f67645c0364474d23c4886e433e1330704044` | Cold restart and multi-page qualification           |
| `cc8fca029efa1a52a6cb7533900adceac4124c54` | Replay-safe bounded event history                   |

Regression tests were first observed failing for the new implementation increments.
Additional cold-restart and exact-budget tests qualify already implemented paths.

## Explicit remaining gaps and landing gates

- UI controls/reconnect rendering and delivery/Auto-fix/merge are other slices.
  This delivers the passive backend path and shared projection, not a completed
  end-user feature or any native execution authority.
- Other authenticated GitHub consumers do not yet share this quota owner. Initial
  explicit registration uses three bounded foreground reads outside its principal
  quota. Cross-consumer fairness and aggregate quota integration remain open.
- Event payload retention is bounded; request receipts and quota reservation
  ledgers still need replay-safe compaction. Multiple-controller leases are not
  implemented. A single application scheduler is assumed.
- The revocation test proves failure after the initial pause checkpoint commits.
  Storage rejecting that first checkpoint cannot be claimed durable; the in-process
  consent owner blocks capture and returns unconfirmed revocation.
- Actions jobs and bounded Centaur/strict JSON findings are supported. External
  commit statuses/check suites, verified push/webhook hints and automatic detection
  of reopening a closed PR remain open. Closed PRs require explicit renewed Watch;
  large fanout or unsupported evidence remains partial.
- CI and exact-current-head independent Centaur final LGTM/merge recommendation
  remain mandatory landing gates. Neither PR is authorized to merge or deploy.
