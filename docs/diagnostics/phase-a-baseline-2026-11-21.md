# Phase A offline measurement baseline — 21 November 2026

The existing prompt timing harness now records repeated-check denominators,
process/host resources, event-loop delay and concurrency alongside first-send and
follow-up latency. This is a measurement change; it changes no production owner,
authority check, send path, Git operation, prewarm retry or trace attribution.

[Machine-readable baseline](../evidence/phase-a-baseline-2026-11-21.json)
was captured at `2026-11-21T17:44:34.123Z` from clean source
`145f7d1e25e373cc7fb73cf6687c43263a7ee995`. At capture, production sources were unchanged
from fresh remote main `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772`.
The JSON pins the lockfile, runner, fixture, reducer and principal measured owners
with SHA-256 digests. The runner checks those digests, HEAD and dirty status again
before publishing a report. This report commit follows the measured code commit.

The later integration of main `9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`
adds Claude turn attribution. The retained JSON remains evidence for the original
capture only; it is not a measurement of the integrated PR head. Focused offline
regressions validate integration behavior without qualifying new latency numbers.

## Reproduce

Use Node 24 and the pinned project dependencies in an isolated checkout. The
normal setup entry is `npm run setup:dev -- --install`. Do not borrow a production
home, configuration or server. From the repository root:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  server/__tests__/phase-a-measurement.test.ts \
  server/__tests__/prompt-trace-timing.test.ts \
  server/__tests__/prompt-trace-timing.e2e.test.ts \
  server/__tests__/local-codex-observation.test.ts \
  --maxWorkers=1 --hookTimeout=30000

node --import tsx scripts/validate-prompt-timing.ts --runs 3 \
  --output .test-tmp/phase-a-baseline.json
```

The runner accepts 1–10 serial isolated runs. It uses one worker and a 1 GiB
heap, with CI=true and TZ=UTC. A 30-second setup allowance excludes module-loading
contention from the measured window; the child process is still bounded at 60
seconds. A disposable loopback listener is required, with no external service or
model access. The existing optional dispatch budget and timing boundaries are
documented in [offline prompt timing](offline-prompt-trace-timing.md).

This capture used Node **24.10.0**, npm **11.21.2**, ABI **137**, macOS/Darwin
**27.2.0 arm64**, Apple **M4 Pro**, **14 logical CPUs**, **48 GiB RAM**. Other
ordinary workers were active on the host; it was not an isolated performance lab.
Dependency setup could not resolve the npm registry through its selected executor.
The pinned lockfile was installed offline from a writable workspace copy of the
existing npm cache (`npm ci --offline --ignore-scripts --include=dev`). Contexgin's
pinned source was compiled with the project's TypeScript compiler; the repository
SQLite owner was built with node-gyp and matching local Node headers. The actual
SQLite binding and HTTP fixture ran successfully. Dependency manifests and host
sources were unchanged, and no setup change is part of this PR.

## Measured result

Latency is **owned command HTTP-handler entry → controlled stdio write completion**.
It excludes browser/network transit before handler entry and provider inference.
The existing reducer separately retains queue, preparation, ACK and first-output
boundaries; overlapping phases are never added into a fabricated end-to-end time.

| Command                     |   N | Median ms |  Min ms |  Max ms |
| --------------------------- | --: | --------: | ------: | ------: |
| First command / cold driver |   3 |   378.543 | 378.207 | 404.011 |
| Explicit warm follow-up     |   6 |   226.589 | 221.620 | 256.229 |
| Queued follow-up            |   3 |   276.898 | 264.234 | 294.908 |

No request p95/p99 is claimed with this sample size. The fixture's delayed ACKs,
accepted output, FIFO order, retained workspace/thread and consumed receipts are
verified by the existing real-owner E2E assertions.

All three runs recorded the same **116 started and 116 ended selected check spans**,
with zero unfinished or unattributed spans. Counts include fast successes and
failures; they do not use slow-only production log messages. These are counts of
the existing `local_codex.*` phase invocations associated with each command trace,
not an inventory of every authorization function or a count of exclusive disk reads.

| Command in each run   | Workspace check | Workspace revalidation | Credential check | Repository credential check | Keychain read |
| --------------------- | --------------: | ---------------------: | ---------------: | --------------------------: | ------------: |
| First                 |              16 |                      1 |               16 |                           3 |             0 |
| First warm follow-up  |              14 |                      0 |               14 |                           0 |             0 |
| Second warm follow-up |              12 |                      0 |               12 |                           0 |             0 |
| Queued follow-up      |              14 |                      0 |               14 |                           0 |             0 |

The zero keychain count describes this synthetic subscription workload. It says
nothing about API credential costs. Each phase also retains a failed count and
cumulative wall time; nested or overlapping phase wall times are **not CPU time**.
The baseline workload has no failed sends, so it cannot estimate an operational
failure rate. Failure handling is covered separately by offline regressions.

| Run | Window ms | Process user+system CPU ms | Sampled max RSS MiB | Loop samples | Loop max/p99 ms | Host CPU busy fraction |
| --- | --------: | -------------------------: | ------------------: | -----------: | --------------: | ---------------------: |
| 1   |  1555.984 |                   1429.344 |             499.078 |           21 |         281.543 |                  0.330 |
| 2   |  1590.047 |                   1409.718 |             505.438 |           21 |         278.135 |                  0.298 |
| 3   |  1639.379 |                   1538.978 |             483.688 |           21 |         290.193 |                  0.396 |

The resource window begins immediately before the first send and ends when the
last command completes. Process CPU includes the test driver, server code,
logging, SQLite and measurement overhead in the same process; it is not exclusive
controller CPU. Host CPU/free-memory observations include unrelated processes.
RSS/heap and host free memory are sampled every 20 ms plus start/end; delayed
timers can miss peaks, so these are sampled extrema, not kernel high-water marks.
The JSON retains sample counts, start/end memory and minimum sampled host free memory.

Loop histograms run at 20 ms resolution with no slow-window threshold. Their
percentiles are **within-window timer-delay percentiles**, not request latency
percentiles. With only 21 samples, p99 equals the maximum. Empty histograms export
`delayMs: null`, not a fabricated zero. No measurement-overhead subtraction or
causal diagnosis of the observed stalls is claimed.

## Route, concurrency and coverage

The reducer requires each actual `codex.turn` span to resolve to the fixture's
`chatgpt-subscription` route, `ordinary-personal` account and `fixture-model`.
It exports the account alias **synthetic-personal**. Missing, mismatched or real
account/model values fail qualification. The qualified engine is **local Codex
with an in-process synthetic peer**. Claude, API-account, OpenShell and Gemini
comparisons remain unmeasured. The implementation chat's Astra account is not the
workload's model route.

Each run has **one retained session**, **four commands**, a peak of **two outstanding
commands** and **one active turn**. Outstanding means handler entry through turn
completion; active means the `codex.turn` interval. The queued command is counted
as outstanding while its predecessor is active. This is a repeatable small-load
baseline, not a 10/25/50/100/200-agent test or evidence of hundreds-agent readiness.

The in-memory collector reconciles selected phase starts and ends and reports
unattributed or unfinished phases explicitly. Duplicate, missing-start, invalid
time and route-conflict data are rejected. The follow-up validation commit
`a1f52dd2` additionally refuses unknown phase outcomes and treats wholly absent
check instrumentation as incomplete; it does not change the measured workload
or metric calculations. No production exporter, retention or
query-coverage guarantee follows from this collection. Raw prompts, exceptions,
credentials, paths and arbitrary span attributes are excluded from the report;
existing synthetic trace/span IDs remain available for timing correlation.

## Audit reconciliation and next comparisons

This implements the bounded measurement prerequisite from audit chat
`c25176b4-da7f-89ac-b55f-bf09de2c1761` and feature `3379c5330bdc1b02`.
That audit inspected release `4471ca8f279de22f6c133a0e5fd26956f802a803`; its
slow-only log distributions are not comparable to this complete offline sample.
The accepted send-latency work, including #1409, is already in the base. This PR
extends the existing `validate-prompt-timing.ts` harness instead of duplicating it.
Async Git (`a111e7e6658c460d`), send latency (`facabd5d29f01bc9`), prewarm diagnostics
and Claude attribution remain separate work.

Delivered: reusable collector, integration into the real-owner offline fixture,
source/environment-pinned JSON, reproducible command and failure-path tests.
Remaining: more synthetic route adapters, sustained concurrent-session workloads,
observability-overhead experiments and before/after captures for future production
changes. Re-run the same workload and environment on each compared commit before
claiming improvement. No model inference, production load, merge or deployment
was performed. Landing still requires CI and Centaur's exact-current-head final
LGTM with a `merge` recommendation.
