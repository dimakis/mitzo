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
