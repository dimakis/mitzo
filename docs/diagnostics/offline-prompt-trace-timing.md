# Offline prompt and follow-on timing

Run the real HTTP/backend validation from the repository root with Node 24:

```sh
node --import tsx scripts/validate-prompt-timing.ts --runs 3 --output /private/tmp/prompt-timing.json
```

Each run uses a fresh private home, synthetic account and SQLite/workspace stores,
a disposable **127.0.0.1** port, the actual owned admission/bootstrap/controller,
and the actual `CodexAppServerClient`. Its JSON-RPC peer is an in-process stdio
fixture. No native executable, provider API, model, browser, observability service
or existing Mitzo server is launched. On macOS this loopback test requires an
execution context that permits listening. It never uses ports 3100/3101/3190.
The runner uses one worker, a 1 GiB heap, CI=true and TZ=UTC; each run is bounded
at 60 seconds. `--runs` accepts 1–10. The E2E test also runs in ordinary Vitest CI.

The measured entry is the owned command HTTP handler, **after JSON parsing,
authentication and same-origin middleware**. Browser click/render, client network
transit and earlier middleware are excluded. The ordinary workspace and session
are already prepared, and modules are loaded, before measurement. “Cold” means
first command of a new native driver/bootstrap/thread, not cold application startup.
Two explicit warm follow-ons and one genuinely queued follow-on use the same
conversation, retained workspace, bootstrap, transport and thread. Exact command
IDs from serialized frames must match the original HTTP commands in FIFO order.

The sanitized JSON retains trace/span IDs and relative phase times, but no prompt,
credential, account identity, filesystem path, raw attribute/event payload, prompt
hash or provider content. Sample numbers are aliases for private command IDs.
Raw spans stay in memory; disposable roots are removed. No OTLP export is needed.

## Boundaries and correctness

- `serverToDurableAdmission`: handler entry to return from the **actual SQLite**
  `claimOrdinaryLocalCommandDispatch` uncertainty transaction. A transparent fixture
  probe delegates to the original owner and verifies the resulting durable state.
- `admissionToDurableQueue`: that transaction to the controller's successful
  durable enqueue. Cold bootstrap work occurs here. Existing `codex.admission.*`
  phases are retained separately where emitted; they may overlap.
- `queueWait`: successful durable enqueue to actual claim. The queued fixture holds
  a real predecessor active, then releases it after a real timer; no fake clock.
- `preparation`: claim-side preparation to immediately before `turn/start` request
  invocation. The existing `codex.turn.dispatch` span overlaps this interval and
  measures invocation, **not wire completion**.
- `serverToWriteQueued` and `serverToWriteCompleted`: the actual client serializes
  the frame and its existing observer reports `stdin.write` queued and completed.
  This fixture uses Node Writable/PassThrough completion, **not an OS pipe flush,
  remote provider receipt or paid native turn**. Diagnostic observer overhead is
  included. The main summary is handler entry → controlled write completion.
- `writeCompletedToAck`, `writeCompletedToFirstOutput`, `ackToFirstOutput`: separate
  controlled-peer intervals derived from absolute boundary timestamps. ACK is
  deliberately delayed 40 ms, or 80 ms for one warm command; output is sent later.
  The reducer permits legitimate output before ACK (a negative ACK→output interval).
  It never sums overlapping dispatch/ACK/first-output span durations.

The locked OTel SDK starts each span with independently quantized `Date.now()` and
ends with a per-span performance offset. Consecutive spans can therefore appear
slightly reversed in their original timestamps. The in-memory SpanProcessor records
**real `process.hrtime()` at genuine OTel onStart/onEnd hooks**, plus the actual
write-queued observer boundary, for cross-span arithmetic and order checks. JSON
`startMs`/`endMs` and timing metrics use that collector monotonic clock; prefixed
`otelStartMs`/`otelEndMs`/`otelWriteQueuedMs` retain the original OTel offsets for
inspection. No production clock behavior or span duration is rewritten.

Missing/duplicate spans or write boundaries, wrong trace/command/turn ancestry,
invalid ordering, missing accepted assistant output, duplicate wire commands,
changed bootstrap/thread/workspace and non-consumed receipts fail validation.
Telemetry start/end failures remain observational in production. Cancellation,
close, preparation refusal and duplicate/failed enqueue cleanup have regressions.

An optional `MITZO_PROMPT_DISPATCH_BUDGET_MS` gates handler→write-completed time
**minus queue wait**, without ACK/output delay. No default latency SLO is imposed;
a measured laptop baseline is not a stable CI budget. Compare like-for-like runtime,
fixture, sample count and source revision before choosing a budget.

## Measured preflight, 23 October 2026

Official Node 24.21.0, macOS arm64, CI=true/TZ=UTC, clean local dependencies,
three isolated runs of this timing delta over accepted `3533e7945e`:

| Command                 |   N | Median ms |  Min ms |  Max ms |
| ----------------------- | --: | --------: | ------: | ------: |
| First / cold driver     |   3 |   377.537 | 355.535 | 380.143 |
| Explicit warm follow-on |   6 |   179.504 | 161.860 | 214.073 |
| Queued follow-on        |   3 |   210.612 | 207.308 | 218.281 |

Queued wait alone was 41.222–43.055 ms. Normal controlled ACK delays measured
44–47 ms; deliberately delayed warm ACKs measured 84–85 ms. Those delays are
excluded from application dispatch. These are observational fixture results,
not production/provider latency or kernel/sandbox qualification: synthetic Mach-O
artifact classification and Mac host identity are explicit fixture controls.
The exact executable classifier has separate tests.

The runner prints N/median/min/max and writes all sanitized trace samples with
source HEAD, dirty-state flag and runtime. Nearest-rank p95 appears only at N≥20;
it is omitted above. The original three-run preflight had an uncommitted timing
delta; use the final committed runner artifact's `sourceHead`/`sourceDirty` for a
reproducible comparison. Historical live-send reports use different boundaries
and providers, so these numbers cannot establish an improvement over them.
