# CI scheduling trial, 12 November 2026

Source baseline: `f7a474ea9b113a4fdb40c169d3e879bf118d2d4c` (fresh remote main).
Research baseline: `3c14fbf1dcece0528dc7150b24a49a2ea413be0e`.

## Trusted obsolete-run dispatch: infrastructure decision pending

The accepted `ci-recovery.yml` and `pr-landing-reconcile.yml` controllers both
need a hosted Ubuntu runner. Source inspection found no independently hosted
GitHub webhook receiver. Moving cancellation into the landing workflow or
another hosted job retains that queue dependency. GitHub Actions concurrency
does not reserve control capacity. Keep per-SHA CI concurrency: a retiring older
candidate must not prevent a new candidate from starting.

The bounded implementation here leaves the trusted cleanup and retry workflows
unchanged. The research measured recovery queues of 9m06, 13m39 and 13m56 for
11–13 seconds of execution. It cannot establish a below-30-second dispatch
guarantee with the currently available architecture.

A separately approved infrastructure change can host an authenticated GitHub App
receiver for requested CI events. Run only accepted default-branch cleanup code,
with repository-scoped Actions write and PR read credentials isolated from all
candidate code and artifacts. Reuse `cleanupSupersededCiRuns` with canonical API
facts and its repository, workflow, PR, branch, current-head and target ownership
checks at mutation. Deduplicate delivery IDs durably; reconcile an uncertain
cancellation against the canonical run before any repeat request. Retain the
existing trusted workflow as fallback. Never give this receiver merge authority.

Before activation, fixtures must cover webhook authentication/replay, stale heads,
forks, repository identity, completion races and uncertain requests. Retain event
delivery time, receiver admission time, cancellation request/response and canonical
retirement receipts. Under load, measure event-to-request against the <30-second
target separately from runner shutdown. App provisioning, reserved runners,
capacity purchase and controller deployment require separate authorization.

## Trial acceptance

Retain all four unit jobs, all ten offline browser jobs (4 WebKit, 3 mobile
Chromium, 3 desktop Chromium), bounded five-case browser lifetimes, native Apple
checks, seven composed delivery/publication cases, artifact checks, combined
result and Centaur exact-head final LGTM with `merge` recommendation and no
unresolved blockers. These engine tests do not establish exhaustive branded
Safari application coverage.

Use a fixed pair of baseline/candidate runs of the same candidate and toolchain
before adopting any performance claim. Preserve unfavorable runs. Compare exact
per-project case identities, assertion/status counts and existing skips. Record
queue, dependency/admission, setup, execution, retries, cancellations and OS
separately; report longest lane, end-to-end latency and total runner-minutes.
Overlapping suite durations are scheduling weights, never elapsed predictions.
No stable p95 can be inferred from this small trial. No merge or production
activation is authorized by this document.

## Implemented trial and local evidence

The three measured unit files move from shard 2 to shards 1, 3 and 4. Overrides
apply after the existing ordinary hash partition, preserving every other file's
owner. Final discovery contains 2,013 files, of which 2,011 remain in unit CI and
the same two declared composed files retain their separate owner. A comparison
against the original implementation over this exact inventory found precisely
the three intended ownership changes. Existing Vitest ordering already runs
longer files first when cached durations exist, after its failed/unknown-file and
isolation priorities; this trial preserves that policy. Fresh CI has no measured
rolling unit history yet, so the ownership change remains a trial rather than a
claim of a stable improvement. Retain subsequent unit JSON reports, including
unfavorable samples, before deciding whether to keep or revise these owners.
The original retained replay reduced maximum summed suite load by 38.8%, but the
second run's partial TS/TSX replay increased it from 1,228.6 to 1,235.1 seconds
(0.5%). Preserve that unfavorable result. Neither replay predicts elapsed time.

Offline browser discovery and the original ten Playwright shard lists agree on
459 cases in each current project. The new partition has the same complete
exactly-once union. Historical timing weights match 420 WebKit, 420 mobile
Chromium and 419 desktop Chromium cases; every unmatched case receives a finite
fallback weight and remains required. No selected case, assertion, screenshot
call or project was removed. Every process still selects at most five cases,
with one worker, zero retries and the existing startup dependencies. Actual
batch reports now retain case durations for later rolling timing refreshes.

The browser aggregate still requires both original job results, and additionally
downloads all ten run-scoped partition artifacts. It validates matching complete
project inventories, exactly-once ownership, successful summaries and actual
complete per-batch reports. Missing artifacts, results, duplicated cases and
unexpected outcomes fail closed. Existing visual artifacts remain required.

The native job has one Python resource owner. It creates and starts the same
fresh simulator before the disposable-Keychain, Swift package, Watch receipt,
Watch approval, app/Watch build and embedded-Watch validation commands. It joins
that boot before installing the exact built app's offline fixture. Every command
failure remains fatal, while independent checks and the diagnostic build retain
their evidence. Cancellation retires only the owned boot process and simulator.
Boot, install, launch, container lookup, bridge, build/check and cleanup stages
have bounded waits and timestamped logs. The `readiness_observation_seconds`
envelope includes compilation overlap; use bootstatus's own streamed elapsed
time for actual cold-boot duration. Logs are retained on successful runs too.
`ci-native-candidate.py --boot-mode sequential` provides an A/B control with the
same checks, app path, fresh fixture, offline origin and bridge assertion.

Local verification used one worker and a 1 GiB Node heap. The 295-test CI-script
suite passed 294 tests. Its unchanged macOS process-title diagnostic failed
because the executor denies `/bin/ps` (`Operation not permitted`); that gate is
retained, and hosted CI must verify it. Focused sequencer/recovery/cancellation
checks passed 102 tests; browser/gate checks passed 48; native workflow/gate
checks passed 52; the later reporter/type follow-up passed 14. These overlapping
groups must not be added. All 19 Python native process fixtures passed. Focused
TypeScript checks, shared package compilation, formatting and diff checks passed.
The fixture Playwright execution launches workers but no browser or model.

See [the machine-readable evidence](../evidence/ci-performance-trial-2026-11-12.json)
for the complete inventory comparison and historical-weight replay. These are
scheduling estimates, not measured browser/native execution gains. Full native
Apple builds, browser execution, current assertion/skip counts and fixed paired
same-candidate hosted measurements remain required; no such benchmark has been
dispatched by this session. Queue, dependency delay, actual longest lane,
end-to-end duration and total runner-minutes cannot be inferred from this local
replay. No production configuration, runner enrollment or capacity changed.
