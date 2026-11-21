# Phase A: bounded multi-session diagnostic — 21 November 2026

This extends [the one-session baseline](phase-a-baseline-2026-11-21.md) with
equal-work, multi-session measurement through actual HTTP, ordinary workspace,
SQLite EventStore, CodexConversation queue and CodexAppServerClient owners.
The initial implementation is commit `703607f2633152d7e6e57d56ad0618f6c2a1ca6a`, dependent
on PR #1426 at `795043576ab5ccfb48a8ef36efb6c79cb708b4df`. PR #1426 is preserved.
No production execution path was optimized or replaced.

The later integration includes parent PR #1426 at
`692e235ab02096474e865d06c1987cd18f5e8905` and main
`9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76` (Claude turn attribution).
Historical captures below retain their original source identities. Focused
integration tests do not qualify latency or resource measurements at the new head.

The completed **single diagnostic sweep** shows materially increasing delay
before HTTP-handler entry under concurrent submissions. Repeated-run validation
is **unqualified**. This is neither a clean-commit performance baseline nor live
provider performance, and supports no hundreds-of-agents capacity claim.

## Evidence and exact provenance

[Retained diagnostic JSON](../evidence/phase-a-multi-session-diagnostic-2026-11-21.json)
preserves the values from the successful capture recorded at `2026-11-21T18:50:10.498Z`
(JSON whitespace normalized for repository formatting). The original capture's
SHA-256 was `471ab4d0209978740f8457ee878694bb5f9e801e76d5c7f61559c9c828459f3c`.
It reports `sourceHead: 795043576ab5ccfb48a8ef36efb6c79cb708b4df` and
**`sourceDirty: true`**. The new harness was still uncommitted. The runner verified
HEAD, dirty status and SHA-256 fingerprints before and after the sweep; those
fingerprints identify the measured source content, not a clean reproducible Git
tree. Do not relabel this capture as measured at `703607f2`.

Between capture and the implementation commit, the measurement reducer added
rejection of absent per-command phase observations and overlapping turns within
one session. The E2E fixture added an out-of-window cross-session substitution
and recovery probe. Neither changed the numerical reduction or measured workload,
but **their source hashes differ** from the capture. The report retains both
original hashes in `sourceFiles`; all other measured file fingerprints match the
implementation commit. Captured production owner files are those inherited from
PR #1426 (main `805fbd9c9e4ce4fed60da643bf73e6a48f5c3772`), not current main.

Environment: Node 24.10.0, ABI 137, Darwin 27.2.0 arm64, Apple M4 Pro,
14 logical CPUs, 48 GiB RAM, one Vitest worker, 1 GiB Node heap, CI=true, TZ=UTC.
Dependencies use the same pinned offline installation described in the earlier
baseline. Other ordinary workers were active; host busy fraction increased from
0.356 to 0.535 across this sweep. Host load, order effects and variance are not
controlled away. The four scenarios ran serially in fresh private fixture
processes; total runner time was 31.952 seconds, including setup/teardown.

## Workload and measurement contract

Each scenario creates 1, 2, 4 or 8 separate sessions/workspaces under one operator,
account and controller. Workspace provisioning precedes the resource window.
Each session receives exactly three commands:

1. A cold first command, submitted in a common batch; wait for all to complete.
2. A warm command, submitted in a common batch; hold each actual turn after output.
3. A queued follow-up, submitted in a common batch; release the held predecessors
   together only after every follow-up is durably queued.

Every synthetic stdio peer requests a 40 ms ACK delay and output 10 ms later.
Timers share the controller event loop and can run late. They begin when the
synthetic peer consumes the frame, so ACK time after write-completion need not
equal 40 ms. There are **no native provider processes or model calls**.
Mac executable qualification is synthetic; SQLite and the named owners are real.
Each session retains its own thread and workspace, FIFO order and consumed
admission receipts. Global overlap is calculated from actual span intervals.

The reducer requires actual resolved turn attributes for **local Codex /
synthetic personal subscription / fixture-model**. Other account, model or route
attributes fail qualification. Per-session route evidence is retained; Claude,
Codex API accounts, OpenShell and Gemini are unmeasured. Repeating the same
synthetic route across sessions is not multi-route qualification.

Client issue is recorded immediately before the same-process HTTP request.
Client-to-handler time includes loopback/client scheduling and middleware before
the measured route; it is not a production browser/network metric. Handler-to-write,
durable admission, queue wait, preparation, ACK and output remain separate.
Submission skew and batch-to-completion offsets expose unequal dispatch order.
The report exports session ordinals and allowlisted metrics, not session IDs,
credentials, prompts, paths, raw span attributes or logs.

## Observed latency and concurrency

Each latency entry is a median **across sessions within one scenario**, not across
repetitions. N per command kind is the session count. No request percentiles or
confidence intervals are estimated from this small sample.

| Sessions | Commands | Peak outstanding / active | Cold client→write ms | Warm client→write ms | Queued client→write ms |
| -------: | -------: | ------------------------: | -------------------: | -------------------: | ---------------------: |
|        1 |        3 |                     2 / 1 |              393.371 |              222.355 |                225.208 |
|        2 |        6 |                     4 / 2 |              561.228 |              339.904 |                450.639 |
|        4 |       12 |                     8 / 4 |            1,011.215 |              577.960 |                976.603 |
|        8 |       24 |                    16 / 8 |            1,935.817 |            1,263.117 |              1,968.673 |

| Sessions | Warm client→handler ms | Warm handler→write ms | Cold admission→durable queue ms | Warm preparation ms | Queued queue wait ms |
| -------: | ---------------------: | --------------------: | ------------------------------: | ------------------: | -------------------: |
|        1 |                  1.094 |               221.261 |                         202.227 |              86.764 |               34.683 |
|        2 |                118.068 |               221.837 |                         326.168 |              85.242 |              109.215 |
|        4 |                352.300 |               228.246 |                         587.632 |              89.588 |              293.773 |
|        8 |                998.695 |               276.743 |                         607.412 |             107.074 |              593.519 |

These independently computed medians are not additive. The eight-session warm
client-to-write range was 276.911–2,313.033 ms despite equal work and sub-millisecond
batch submission skew. Cold completion spread was 1,759.562 ms; queued completion
spread was 227.279 ms. All commands completed, but three commands/session cannot
establish starvation freedom or sustained scheduler fairness. The held-warm
completion spread is dominated by the deliberate release barrier.

The queue barrier itself took 81.115 / 158.631 / 367.004 / 734.166 ms from queued
batch submission to release. Queue wait therefore contains harness policy and
contention, and cannot be interpreted as an autonomous production queue cost.

## Resources and repeated checks

| Sessions | Measured window ms | Process user+system CPU ms | Sampled max RSS MiB | Loop samples | Loop maximum ms |
| -------: | -----------------: | -------------------------: | ------------------: | -----------: | --------------: |
|        1 |          1,150.561 |                  1,098.923 |             485.109 |           13 |         272.892 |
|        2 |          1,906.926 |                  2,023.460 |             503.359 |           16 |         370.409 |
|        4 |          3,766.677 |                  4,046.256 |             584.484 |           22 |         699.400 |
|        8 |          8,185.723 |                  8,619.434 |             611.203 |           32 |       1,322.254 |

Process CPU was 95.5–107.4% of one core across the windows; it includes the
fixture, controller, native SQLite, logging, runtime threads and measurement.
It does not isolate JavaScript self time. RSS/heap/free memory are sampled extrema,
not kernel high-water marks. Loop histograms sample at 20 ms; their percentiles
are timer-delay statistics, not request latency percentiles. Sampling can miss
peaks when blocked. No measurement-overhead subtraction is claimed.

Selected check spans started/ended were 88 / 176 / 352 / 704 at the four scales,
with zero unfinished or unattributed observations. Each session recorded:

| Kind   | Workspace checks | Credential checks | Workspace revalidation | Repository credential checks | Keychain reads |
| ------ | ---------------: | ----------------: | ---------------------: | ---------------------------: | -------------: |
| Cold   |               16 |                16 |                      1 |                            3 |              0 |
| Warm   |               12 |                12 |                      0 |                            0 |              0 |
| Queued |               14 |                14 |                      0 |                            0 |              0 |

These are existing phase invocations, not exclusive I/O counts. Cumulative phase
wall times can overlap and must not be summed into CPU or end-to-end latency.
The one-session workload differs from the earlier four-command baseline, so
116 versus 88 checks is not an optimization result.

## What to implement next, and why

**Proposed only; no production optimization is delivered here.**

1. **Attribute synchronous controller work before choosing an optimization.**
   In the same bounded 1/2/4/8 harness, add diagnostic self-time/call-count probes
   around admission and `CodexConversation.beginNext` preparation sub-stages:
   binding, native policy, system/turn/agent context, durable queue and dispatch
   authority. Keep loopback ingress and process CPU measurements. Warm ingress
   grew much more than handler service time, and fixed ACK timers also ran late;
   together with loop delay this supports shared-thread contention as a working
   hypothesis, not a proven function-level cause. Cold admission-to-queue and
   queued preparation are the next stage gaps to resolve. Reject probes that
   change outcomes or suppress original errors; report observer overhead with a
   matched probe-off run. Do not introduce caching before its invalidation owner
   and revocation tests are explicit.
2. **Choose one measured hotspot and validate an isolated implementation.**
   Preserve durable uncertain-before-effect admission, cancellation, current
   account/workspace validation and session FIFO. Use a deliberately slow/failing
   selected owner to prove unrelated status/Stop remains responsive. Compare
   client-to-handler and client-to-write distributions, CPU and checks on the
   same source/host workload. Existing async Git work `a111e7e6658c460d`, send
   latency `facabd5d29f01bc9` and session-list SQLite PR #1421 remain their owners'
   scope; do not duplicate them. This non-Git fixture cannot rank Git costs.
3. **Qualify repeatability, isolation and routes before expanding scale.**
   After the uncertain capture is reconciled, retain at least three fresh-process
   sweeps in alternating scale order, ideally rotating session submission order.
   Add separate-process clients to distinguish in-process driver coupling; compare
   exporter-on/off and longer bounded workloads. Then qualify actual API/Claude/
   OpenShell owners with their own offline adapters and frozen identities. Require
   per-route denominators and failure outcomes rather than substituting route
   labels. Higher concurrency or live capacity testing is a separate scope.

## Reproduction and validation limits

From the isolated checkout with pinned dependencies and Node 24:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vitest/vitest.mjs run \
  server/__tests__/multi-session-measurement.test.ts \
  server/__tests__/phase-a-measurement.test.ts \
  server/__tests__/prompt-trace-timing.test.ts \
  server/__tests__/prompt-trace-timing.e2e.test.ts \
  server/__tests__/local-codex-observation.test.ts \
  --maxWorkers=1 --hookTimeout=30000

node --import tsx scripts/validate-prompt-timing.ts --runs 1 --sessions 1,2,4,8 \
  --output .test-tmp/multi-session-forward.json
node --import tsx scripts/validate-prompt-timing.ts --runs 1 --sessions 8,4,2,1 \
  --output .test-tmp/multi-session-reverse.json
```

The runner also supports `--runs 3 --sessions 1,2,4,8` (alternating order), when
the enclosing executor permits the whole duration. Maximum eight sessions,
four distinct scale points and ten repetitions; one process at a time. Each
child is bounded at 60 seconds. A failed child, incomplete observations or
changed source aborts the run without publishing a new final report. Keep unique
output names so an old report cannot be mistaken for a failed attempt's result.
These commands are reproduction instructions, not permission to replay an
unresolved operation.

Validation delivered: 64 tests passed across five focused files; after adding the
out-of-window failure/recovery probe, the two-session E2E passed again. Tests
reject incomplete/unequal workloads, orphan/missing check observations, wrong
routes, invalid client boundaries and unbounded session counts. Both the original
one-session fixture and new shared-owner fixture passed. Targeted strict
TypeScript, ESLint, formatting, source-pin verification and diff checks passed.
Broad CI and review are deferred to the operator's later landing work.

The attempted clean-source three-repetition capture at `703607f2` was killed by
the TaskExecution 120-second limit. Receipt
`591d279d-1e51-40e7-aee0-de1d9bc3281b` remains **uncertain**; no final JSON report
exists. Worker and coordinator process-list inspection were unavailable (EPERM /
sysmon unavailable), so no process-absence claim or kill was made. At coordinator
direction, no dependent repeat capture was launched. Preserve that receipt and
reconcile it before new measurements. The retained single sweep above is the
only multi-scale timing evidence delivered; clean-source repetition is pending.

No paid inference, production load, deployment or merge occurred. Review and
combined-result CI remain future landing gates; this dependent draft does not
establish completion of the broader efficiency feature.
