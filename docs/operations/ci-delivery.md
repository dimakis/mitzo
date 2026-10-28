# CI delivery and interruption recovery

Required coverage and acceptance gates stay intact. Optimize execution, retain
evidence from successful jobs, and batch corrections before another candidate.

## Measured baseline, 27 October 2026

Final-head CI elapsed time, including interrupted attempts and targeted retries:

| PR    | Run                                                                      | Elapsed    | Attempts |
| ----- | ------------------------------------------------------------------------ | ---------- | -------- |
| #1145 | [40508849354](https://github.com/dimakis/mitzo/actions/runs/40508849354) | 78 minutes | 4        |
| #1146 | [40522429663](https://github.com/dimakis/mitzo/actions/runs/40522429663) | 92 minutes | 3        |
| #1147 | [40552344034](https://github.com/dimakis/mitzo/actions/runs/40552344034) | 73 minutes | 3        |
| #1148 | [40590065197](https://github.com/dimakis/mitzo/actions/runs/40590065197) | 47 minutes | 2        |

#1148 took 4h48 from opening to merge, spanning eight candidate runs and twelve
attempts. An earlier green candidate received a valid blocking Centaur finding,
so this elapsed time includes source corrections as well as CI recovery.

On its final candidate, one 32-test consumer file took 24.3 minutes and its unit
shard took 26.9 minutes. The other unit shards took 5.2–7.8 minutes. The canonical
macOS job took 24.1 minutes, including 6.3 minutes of native repository workflows
and 13.5 minutes for twelve serial joined acceptance groups.

Several browser jobs received runner shutdown signals after approximately four
minutes, without failed assertions. Some stayed in progress for 30–55 minutes.
Both failed and successful jobs used the older Ubuntu 26 image; the image alone
does not establish the cause. Pinning browser lanes to Ubuntu 24.04 provides a
stable supported baseline, not a claim that an image defect has been proved.

The first improvement candidate reproduced a shutdown on Ubuntu 24.04: job
[122530263539](https://github.com/dimakis/mitzo/actions/runs/40601414751/job/122530263539)
exhausted a 16 GiB VM across passing WebKit cases. MemAvailable fell to 48,884 KiB
and SwapFree to 212 KiB immediately before runner termination; almost 15 GiB
became free when its test processes stopped. This proves severe memory pressure,
though the responsible process still needs the added RSS diagnostics.

## Execution and completeness

- The native consumer family retains the same 32 collected cases and 178
  `expect` expressions in nine files. Each public-entry case gets its own isolated
  Vitest module graph and retained authentication-store lifetime. A sequencer
  distributes eight expensive files across the existing four unit jobs; other
  files retain a path-hash partition. Complete discovery and exact once-only file
  coverage remain mandatory in `ci-unit-gate.mjs`.
- The five new composed prepared-repository delivery/publication cases have a
  separate one-worker macOS owner. The delivery file's four cases run in one fresh Vitest process, followed by
  a second fresh process for the publication file's one case. These exercise
  LocalMac behavior with synthetic provider/model transport; no live model or
  account credentials are used. Only these two files transfer from the four
  Linux shards. Full discovery still lists them, the unit gate requires both
  declared paths and rejects Linux execution of either, and every other discovered
  file remains covered exactly once by Linux. Local unsharded tests retain both.
  The owner validates exact file and full case identities, counts, statuses and
  successful process exits, rejecting skips, duplicates, stale or partial reports.
  It retains JSON reports, exits, resource traces and a summary, including failures.
  Cancellation stops admission of the next file. Its finite 40-minute job budget
  allows setup and hosted timing variance over the measured 8–27 minute journeys.
  It is a lane resource bound, not a sum-of-case-budgets guarantee; the five
  individual 15-minute envelopes remain unchanged, and the job cutoff fails closed.
  No production, operation, assertion or authentication deadline is expanded.
  Runtime and unknown changes conservatively select this owner, as do incomplete
  diffs and main. Bundled skills, AGENTS.md, CLAUDE.md and authority rules also
  select it. Only ordinary prose and iOS-only changes may skip it; the final
  `ci` gate rejects absent selections or outcomes contradicting selection.
- The twelve joined groups (fourteen actual App file cases) run in three separate
  macOS jobs. The original unsharded command still runs the complete selection.
  `joined-validation` checks each shard summary and actual reporter, rejecting
  missing, duplicated, failed or skipped cases. Artifacts are scoped to the
  workflow run and replaced per shard, retaining successful evidence on retries.
- Each of the two native repository account workflows runs in its own fresh
  Vitest command, with one worker. The finite whole-case envelope is 480 seconds
  in CI and remains 240 seconds locally. Identical native worker input/output
  hashes on retained #1153 attempts showed preparation taking 81.45–136.28 seconds;
  a complete API journey passed at 238.12 seconds while subscription hit the old
  240-second whole-case cutoff during a subsequent observation. All earlier
  helpers succeeded; the final helper was killed after 0.887 seconds of its
  30-second allowance. This is an outer resource allowance for loaded hosted
  runners, not a newly asserted per-stage arithmetic contract. Every existing
  30-second helper, reader deadline, 120-second handoff wait, revocation, custody
  and account assertion remains unchanged. The chosen outer budget is retained
  in each account's evidence and checked by its runner. Timeouts still fail; no
  automatic timeout retry is introduced.
  Actual per-account reporters, exits, resource observations and native evidence
  remain separate; neither case may reuse stale proof. Both exact cases and every
  existing native-evidence check must pass. Cancellation stops later admission;
  ordinary failures still permit the other required case to run. This isolates
  test JavaScript lifetimes; native workers retain their own existing cleanup.
- Signed native authorization, both native account workflows, the canonical
  macOS artifact journey, both supplemental shards, all layout projects, core
  checks and the final Centaur gate remain required.
- WebKit retains four layout shards; both Chromium projects use three shards.
  Each layout job keeps one worker; all browser jobs have a 20-minute deadline.
  The CI layout command discovers the original shard and runs at most five primary
  cases per fresh Playwright process, with startup dependencies repeated. Collected
  and completed IDs must exactly match each batch. Imported tests retain both their
  declaration location and owning spec, so wrapper hooks still apply. Intentional skips and expected
  failures retain their original meaning; unexpected outcomes fail the job. Each
  batch retains its configured HTML report and output artifacts in a separate
  directory. Individual assertions and test deadlines are unchanged.

## Diagnose an interrupted browser job

`ci-browser-run.mjs` streams command output plus memory, load, kernel and Linux
cgroup/pressure observations and top process RSS (without command arguments) every thirty seconds. It preserves the actual test
exit status and forwards termination to its own process group. Diagnostics are
retained alongside Playwright evidence even after cancellation, when the runner
is still able to upload. Console observations remain useful if the host exits
before artifact upload.

The additional reporter emits `CI_BROWSER_TEST_FAILURE` immediately for an
unexpected result (including an unexpected pass) or global error, before final reporting. Recovery
also rejects legacy list-reporter failure rows if shutdown hides the summary.
Ambiguous negative rows are left for diagnosis rather than automatically retried.
`CI_BROWSER_MEMORY_PRESSURE` marks snapshots with less than 256 MiB available and
128 MiB free swap; the recovery controller refuses to retry this known resource
exhaustion as an unexplained host interruption.

Inspect the failed job's runner image header, `CI_BROWSER_RESOURCES` and
`CI_BROWSER_EXIT` lines, and its attempt-specific failure artifact. Compare
`memory.events`, memory pressure and the last output timestamp. A shutdown signal
does not by itself prove an OOM or a test failure. Job timeout bounds and the
shorter shards contain the ordinary tail; a lost hosted VM may still require
GitHub-side cleanup after the process stops.

## One bounded infrastructure retry

`CI infrastructure recovery` activates only once its workflow and controller have
been accepted on the default branch. A PR cannot validate that event activation
before merge; policy behavior is checked offline with controlled API responses.

The controller considers only the first completed, failed `CI` attempt for a
single open same-repository PR whose head still matches. Every unsuccessful
non-gate job must be an interrupted browser job with a cancelled step and a
retained runner shutdown log. Missing evidence, actual test failures, other failed
owners, timeouts, forks, closed/stale heads, cancelled runs and later attempts
require diagnosis instead of automatic recovery. It rechecks the run and PR just
before requesting GitHub's failed-jobs rerun with debug logging.

Only failed jobs and their dependent gates rerun; prior attempts remain visible.
The controller never writes a success status, executes logs, downloads PR
artifacts or checks out PR code. Its Actions-write token is used only by accepted
default-branch code, with checkout credential persistence disabled. See GitHub's
[workflow-run security boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
and [failed-jobs rerun API](https://docs.github.com/en/rest/actions/workflow-runs#re-run-failed-jobs-from-a-workflow-run).

## Batch a candidate

Collect all known compiler, format, test and review findings before pushing.
Complete focused offline checks and independent local review on a stable
candidate, then push one validated correction batch. For a genuine infrastructure
failure, retry the affected failed jobs on the unchanged SHA; do not push an empty
commit or rerun successful suites to wake CI. Diagnose assertion failures before
retrying and keep every required gate.

Run `npm run check:source-artifacts` before pushing. It checks the actual
registered sources with Node 24 without requiring compiled output, so it remains
suitable for focused validation under local memory pressure. Extracted files must
retain source registration and the reviewed revision must advance. CI still runs
the existing compiled-artifact check; this preflight does not replace it.

Core lint, format, quotation and resume-contract checks run after other core
failures so one candidate exposes all independent blockers. Cancellation still
stops them; no check result is ignored.

Record initial queue delay, useful runtime, interruption/cleanup time, retries,
source-fix rounds and final review delay separately. Compare fresh clean runs
with the measured baseline before claiming a speedup. Preserve strict base
protection and exact-head review; integrate an advancing base at the actual
landing turn rather than refreshing every waiting branch.

This workflow requires no staging, deployment or live model calls.

## Browser journey readiness

Observe each navigation or chooser action before it starts. Fresh draft runtime inventory must be consumed before configuring ordinary settings; role review depends on those settings, so its ten-second response phase follows configuration. Retain existing UI assertions and interaction deadlines. Require exact item/role or conversation identity, successful status and completed schema-valid bodies; task-page waits match a valid task tree by exact task ID. Deliberately delayed collection reads remain outside chooser readiness when canonical record/work reads are the tested dependency.

The complete native non-git journey keeps its 120-second local envelope and uses a finite 180-second CI envelope. Retained hosted-runner evidence completed it in 106–112 seconds and cut off a valid final replay at 120 seconds. This is a composed fixture allowance; production, individual request, helper, approval and handoff deadlines remain unchanged. Timeouts still require diagnosis rather than automatic retry.
