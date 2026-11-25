# PR monitor observation: implementation and qualification

Status on 21 November 2026: **tested implementation draft, not live activation or a completed feature**.
Ordinary contributor conversation `f0616a37-9e94-8c40-9291-f6ea0d459dac`, Telos slice
`f33fa8e53e954ec3`. Historical allocation and canonical ownership are unchanged.
Base: `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772`.
Accepted architecture evidence: slice `d55d0cc700b64680`, design commit
`5b40118c96d882767f39c897d7e17dc5edad9eab` (read from its retained checkout; not in this branch).

## Delivered contracts

- `packages/protocol/src/pr-monitor.ts` defines versioned subscription, scope,
  snapshot, finding, retained observation and bounded projection types. Operator,
  conversation, connection revision, canonical repository/PR and head generation
  remain separate identity fences. Review text supplies no command fields.
- `EventStore.prMonitor` borrows the existing SQLite owner. It atomically retains
  subscriptions, request fingerprints, Watch consent, snapshots, event identities
  and eligibility/outbox changes. `projection(operatorId, conversationId, id)`
  bounds event evidence to 20 references and 16 KiB; `hiddenEvents` reports omitted
  history. Internal `read`/`list` include retained history and must not be returned
  directly as a public UI response.
- `PrMonitorConsent` extends the existing Access owner. The controller must supply
  current interactive-login provenance, persistent logout checks, live conversation
  validation and attested connection scope. Restart reconciliation checks the
  original persisted login, expiry, connection revision and current Watch revision.
  Removed/merged subscriptions cannot be renewed. A reopened closed PR requires a
  newly reviewed Watch, which establishes a fresh baseline.
- Existing Access routes add POST `pr-watch/:subscriptionId` and
  `pr-watch/:subscriptionId/revoke` beneath the conversation Access router.
  They require its existing live owned-session context. Issue additionally requires
  recent same-origin authorization and exact reviewed scope. Without the optional
  consent adapter they return `pr_watch_unavailable`; these routes do not register
  a new subscription or activate a controller.
- `PrMonitorObserver` collects bounded GET evidence, checks the canonical PR again
  before publication, coalesces concurrent requests for an exact subscription
  revision, and reconciles retained due subscriptions. It has no model-generation,
  delivery, command or merge port. Deadline: 20 seconds; budget: 10 actual HTTP
  requests; page: 100 entries/1 MiB. Pending/pass newer workflow attempts suppress
  older failures, including queued runs without jobs. Eligible review authors are
  an explicit finite policy. Incomplete refreshes withdraw outbox eligibility while
  preserving the last successful snapshot. Backoff is retained and diagnostics are
  fixed codes, not raw GitHub/review/error text.
- `createPrMonitorGitHubReader` uses an injected authenticated transport, validates
  `/user` principal, reads exact attempt/job references, and accepts only a strict
  versioned JSON finding report for eligible actionable reviews. Arbitrary review
  text is never interpreted as execution authority. `executeTrustedGitHubReadResponse`
  extends the existing fixed native GitHub GET owner to retain bounded status/quota
  metadata, filtering response headers.
- `EventStore.githubReadQuota` retains REST reservations by authenticated principal:
  conservative remaining/reset observations, headroom, background allocation,
  bounded probes, pacing, request/point/concurrency limits and no refunds.
- `createPrMonitorObservationRuntime` composes consent, quota, reader and observer.
  Its `reconcileDue`, `stopConversation` and `close` hooks belong to the existing
  scheduler/controller lifecycle. Construction performs no reads and starts no timer.
  A composed offline test verifies eight authenticated transport calls, eight quota
  charges, retained projection, zero model turns and shutdown fencing.

## Offline evidence

234 tests passed across the following 12 files, one Vitest worker, Node heap capped
at 1 GiB. No paid model requests, live GitHub collector activation or staging tests
were run.

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  packages/protocol/__tests__/pr-monitor-store.test.ts \
  packages/protocol/__tests__/github-read-quota.test.ts \
  server/__tests__/pr-monitor-consent.test.ts \
  server/__tests__/pr-monitor-observer.test.ts \
  server/__tests__/pr-monitor-github.test.ts \
  server/__tests__/pr-monitor-runtime.test.ts \
  server/__tests__/session-capability-router.test.ts \
  server/__tests__/session-capability-grants.test.ts \
  server/__tests__/interactive-auth-core.test.ts \
  server/__tests__/github-log-read.test.ts \
  server/__tests__/github-native-read-projection.test.ts \
  packages/protocol/__tests__/event-store.test.ts --maxWorkers=1
```

Protocol/harness/client `tsc -b` passed. A focused server check extending the root
tsconfig and including `server/pr-monitor-*.ts` and `server/github-read-response.ts`
passed with `--noEmit` at 1 GiB. The full root server check exhausted that heap;
full-repository typecheck remains a CI gate. Changed TypeScript files were checked
with ESLint and Prettier, plus `git diff --check`.

Tests were written and run failing before their implementation increments. The
initial persistence test failed on the absent owner. Later regressions reproduced
an oversized combined batch, stale eligibility after failed collection, baseline
replay, a general comment incorrectly clearing blocking review state, old workflow
failures surviving a queued replacement, a missing bounded projection and renewal
of a deleted conversation. Tests and implementation are committed together:

| Commit                                     | Increment                                     |
| ------------------------------------------ | --------------------------------------------- |
| `445ba8d5933369dbd1a33ea6afd8ac3e539dd557` | Atomic persistence and event eligibility      |
| `cb59c99c0b9effce25f1a031d10eba4a1e4f63fa` | Durable Watch consent/logout fences           |
| `34f3e51cbe85a1c87fe4a35be2e5a19c554ebd15` | Bounded current-head collector                |
| `2245d8fb376ff4011936feff48860385eedd6351` | Durable principal quota                       |
| `a2654efd6531622250b5ba9b5594112dc29b99ac` | Authenticated GitHub normalization            |
| `d66858d4b612c57087b6eae784d3ef2d0f50a726` | Batch/lifecycle/reconciliation bounds         |
| `18c05cfbfb79d9f64e99044c871aa7d75a90f178` | Review supersession and guarded Access routes |
| `5b998774431987db33953ccc3ba23465edee8fd7` | Runtime composition and drain                 |
| `4a68aef9fc8e28adbcf3b2a0986be64069a707e0` | Incomplete eligibility and renewed baseline   |
| `0101fcf1273aa22c2f38b0af908ec0f97d57ed49` | Queued workflow supersession                  |
| `4230195a5c106fce788864964c25f66b9b916cb7` | Bounded versioned projection                  |
| `de33e58345fd66f698d3aef4e4023868ec951a7a` | Removed-subscription renewal fence            |

## Remaining work before activation or completion

1. Install the factory through the existing authenticated GitHub/connection owner
   and scheduler lifecycle, including owned subscription registration, current
   conversation/account loss checks and UI projection endpoints. The app currently
   constructs Access grants without this adapter. Do not create another scheduler.
2. Route other authenticated GitHub readers through the same principal quota and
   qualify cross-consumer fairness/capacity. Oldest-attempt rotation is bounded but
   is not a proof of the architecture's shared-consumer fairness requirements.
3. Qualify the strict JSON review report against actual accepted Centaur findings
   and resolution evidence. Unstructured eligible blocking reviews remain partial.
   Actions jobs are covered; external commit statuses/check suites are not. Large
   fanout or unsupported evidence remains partial rather than reporting success.
4. Add verified webhook hints, preserving bounded authenticated reconciliation.
   Closed subscriptions currently stop polling and require explicit renewed Watch
   after reopening; automatic reopen detection is not delivered.
5. Qualify durable history/request/quota retention and compaction at capacity. The
   public projection is bounded; the internal retained event history still grows.
   Add injected database-write-failure/restart qualification, especially unconfirmed
   revocation. Transaction rollback is tested; crash-safe revocation failure handling
   is not claimed. Multiple-controller collection leases are not implemented.
6. Delivery slice `6f5b37ed09bead30` must revalidate current authority, freshness,
   head/generation, eligibility revision/digest and outbox availability before its
   own native admission. It owns cancellation/uncertainty, Auto-fix and merge gates.
   Nothing in this observation slice grants a command or merge permission.

A same-account Astra specialist review failed during preparation, remained uncertain
after recovery and was stopped without a contribution. It is not an LGTM.
Exact-current-head Centaur final LGTM/merge recommendation and all required CI remain
landing gates. This draft grants neither merge nor production deployment.
