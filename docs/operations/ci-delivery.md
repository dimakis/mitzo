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

## macOS composed consumer profile, 28 October 2026

On [run 40751528302](https://github.com/dimakis/mitzo/actions/runs/40751528302/job/123039324810),
the composed consumer job spent 14.4 minutes in two serial Vitest processes.
The four delivery cases took 158.459, 66.957, 73.864 and 113.980 seconds;
the publication case took 442.930 seconds. Including import/transform, the
processes took 417.92 and 448.49 seconds respectively. The publication case's
three native host tool executions took 22.637, 21.024 and 204.802 seconds.
Repeated native workspace checks dominated the trace: 204 observations totalled
835.235 seconds, but these overlap other phases and are not additive wall time.
The 7 GiB hosted runner reported normal macOS pressure and no swap throughout;
low free memory alone does not prove resource exhaustion.

Delivery and publication now occupy two independent macOS jobs, retaining the
same one-worker fresh-process isolation and all case deadlines/assertions. The
completion-route follow-on expands the inventory to five delivery and two
publication cases, requiring both subscription and API account journeys.
The unsharded command still runs both groups. Each group retains its own summary,
start/end timestamps, process duration, actual reporter, exit and resource trace.
The aggregate gate validates both actual reports and successful exits, including
exact file/case identities; a passing matrix status alone is insufficient.
Run-scoped group artifacts replace only the retried group's evidence. Explicitly
unselected work may skip the owner only with a successful selection result.

The measured publication duration bounds the useful parallel test time at about
7.5 minutes before setup, queueing and aggregation. This is an estimate, not a
measured end-to-end improvement: the extra macOS job may wait for hosted capacity.
Compare subsequent clean runs including queue delays before claiming a speedup.

## Executable qualification and hosted fixture budgets, 28 October 2026

The bounded executable stream now reads up to 1 MiB per call instead of 64 KiB.
It still independently hashes every byte at every qualification and capture,
retains pre/post identity checks, and refuses incomplete headers and mutations.
A 64 MiB local fixture (two warmups, seven samples, warning memory pressure)
measured median fresh inspection 24.66 → 23.31 ms and capture 87.06 → 76.46 ms.
These modest local measurements do not establish a whole-CI speedup. No executable
attestation or mutable authority is cached across qualifications.

A focused offline run with the same hash-qualified native Codex fixture passed
its non-Git browser journey in 26.573 seconds. A second run with a CPU profile
passed in 27.109 seconds. Of the worker profile's 27.948 seconds, SHA-256 self
time accounted for 9.948 seconds (35.6%), garbage collection for 0.311 seconds
(1.1%) and Vite/Vitest self time for 0.911 seconds (3.3%). All executable inspection
stacks accounted for 11.535 seconds inclusive (41.3%); these overlap the hash and
I/O costs and must not be added to them. The largest stack was preparation
qualification through `credentialDigest`, a fresh host runtime and executable
measurement. This profile covers the test worker, not browser or native child CPU.

The current qualification contract independently measures native code for each
qualification and new adoption. These observations do not authorize caching
attestation across qualifications or removing a fence. The 1 GiB local worker
profile does not support increasing its heap to address this workload.

On [run 40772836271](https://github.com/dimakis/mitzo/actions/runs/40772836271/job/123115590491),
the non-Git journey passed in 100.317 seconds. The repository journey reached
saved native output, completed another bootstrap and started its worker, then
exhausted its 120-second outer test allowance at 120.726 seconds. The same full
repository case passed locally in 38.576 seconds. Its finite whole-fixture
allowance is now 240 seconds in CI and remains 120 seconds locally. Every
operation, helper, bootstrap, UI wait and assertion retains its existing bound.
This changes the hosted resource allowance, not a product latency requirement.

The two cold-resume lifetime cases similarly retain their original five-second
local allowance and use fifteen seconds for the complete fixture in CI. An
unchanged hosted case expired at 5.241 seconds after successful bootstraps;
local cold-resume cases passed in 1.489 and 1.172 seconds. The complete seven-case
local suite passed with custody, execution, revocation, logout and expiry
assertions intact. All native operation and authorization deadlines remain.

## Execution and completeness

The six canonical, joined and supplemental macOS jobs use one conservative
`ordinary` selection over the complete PR diff, including both sides of renames.
Ordinary prose-only documentation and iOS-only changes skip these unrelated
server/browser journeys; the latter still selects native Swift/build coverage.
Runtime spikes, proof records, admission instructions, shared/runtime/CI code,
unknown paths, incomplete diffs and main run the complete relevant selection.
Core, compiler/source validation and the complete Linux unit selection remain.
The joined and final gates require a successful selector and accept skips only
when explicitly unselected; missing, cancelled, failed or contradictory evidence
still fails. No acceptance case, assertion or deadline is removed.

- The complete discovered native consumer family retains its required cases and
  assertions. Each public-entry case gets its own isolated
  Vitest module graph and retained authentication-store lifetime. A sequencer
  distributes eight expensive files across the existing four unit jobs; other
  files retain a path-hash partition. Complete discovery and exact once-only file
  coverage remain mandatory in `ci-unit-gate.mjs`.
- The seven composed prepared-repository delivery/publication cases have a
  separate one-worker macOS owner with delivery/publication matrix groups. The
  delivery file's five cases run in one fresh Vitest process, and a separate job
  runs a fresh process for the publication file's two cases. These exercise
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
  It is a lane resource bound, not a sum-of-case-budgets guarantee; the seven
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
- When selected, signed native authorization, both native account workflows,
  the canonical macOS artifact journey, both supplemental shards and all layout
  projects remain required in full. Core, source/compiler checks, full unit
  discovery and the final Centaur approval gate remain mandatory.
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
is still able to upload. macOS also records available CPU count, the owned command's
PID/process group and the top sixteen processes by CPU then RSS, including cumulative
CPU time and state. Process fields are numeric only apart from validated CPU time and state; process names, titles, arguments and environment are never collected.
The process query has a two-second/128 KiB bound; missing diagnostics do not replace
the command outcome. Attribution is cleared before each launch to prevent stale PID
evidence. Console observations remain useful if the host exits
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

PR concurrency is scoped to both the PR and its combined candidate SHA. A new
candidate can start while an older runner shuts down; identical-candidate runs
still supersede each other. Main keeps its original SHA-scoped identity and is
never cancelled by this cleanup.

The trusted recovery workflow also handles requested CI runs after acceptance on
the default branch. It fetches canonical current PR/run identities and requests
force-cancellation only for older, active runs with a different head on that same
open, same-repository PR. It rechecks the PR and old run immediately before each
request. Current/newer heads, other PRs, forks, default-branch runs and incomplete
identity evidence are excluded. A cancellation request is not proof that GitHub
has finished retiring the runner; independent candidate concurrency prevents that
shutdown tail from blocking new validation. This controller cannot execute PR
code, write success statuses or merge. Before default-branch activation, retire
the selected superseded runs manually after verifying their exact identities.

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

The required `Compile and source preflight` job builds and verifies server sources,
checks all server TypeScript including test mocks, checks frontend TypeScript and
independently verifies source pins. It attempts every independent check after a
failure; cancellation stops the remaining checks. A failed preflight prevents
admission of the expensive unit, browser and macOS jobs, while the aggregate CI
gate remains red. Conservative affected-job selection still applies after a
successful preflight.

Preflight produces server/workspace JavaScript once for the combined candidate,
retaining every compiler and source-pin check. An independent frontend producer
builds production web assets in parallel, so macOS admission and early review do
not wait for Vite. Core, all four unit shards and all ten layout shards require
both producers to succeed and restore their two immutable artifact IDs. Each
archive has a fixed explicit server or frontend scope; it cannot replace outputs
owned by the other scope. Consumers verify the exact commit/tree, workflow run,
Node version, platform/architecture, installed lockfile and every output digest
before replacing that archive's outputs. Missing, mismatched, partial, corrupted,
linked, wrong-scope or oversized output fails closed; no cross-run cache is used.
Unit execution also requires successful restoration. Failed-only retries retain
each successful producer's output ID; a full rerun publishes new immutable IDs.
macOS owners continue to build their own platform prerequisites, and dependencies
are never transferred. Production frontend input/output evidence remains retained
by its producer. The final CI gate explicitly requires both producers to succeed.
Local build commands keep compiling as before; only the verified CI layout path
uses the prebuilt assets. Measure upload/download, producer completion and queue time before claiming an
end-to-end speedup.

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

## Review events and durable landing

Review submissions, edits and dismissals run the credential-free
`Centaur review event` signal. Its completion wakes the default-branch Centaur
status writer, which reads canonical PRs and reports rather than trusting the
signal's head, result or artifacts. Scheduled reconciliation is only a fallback;
GitHub does not guarantee its requested interval. Both workflows must be accepted
on the default branch before the bridge operates.

The optional `PR landing request` / `PR landing reconciliation` workflows retain
an explicitly authorized merge independently of the chat agent. Implementation,
inspection and prepare-only tasks do not authorize a landing request. After the
user authorizes merging a reviewed candidate, integrate the current accepted
base, push the candidate, then register the full head and base SHAs before waiting:

```bash
gh workflow run pr-landing-request.yml --repo OWNER/REPO --ref main \
  -f mode=authorize -f pr_number=NUMBER -f expected_head=FULL_HEAD_SHA \
  -f expected_base=FULL_BASE_SHA -f confirmation=MERGE
```

Use the repository's actual default branch instead of `main` where different.
The dispatch actor must retain repository write permission. The workflow creates
a seven-day receipt in GitHub's immutable artifact metadata. Reconciliation
never downloads artifact contents or checks out PR code. The most recent request
for a PR supersedes earlier requests immediately, including unfinished or failed
requests. Revoke a pending request with:

```bash
gh workflow run pr-landing-request.yml --repo OWNER/REPO --ref main \
  -f mode=revoke -f pr_number=NUMBER
```

CI completion, a new landing request and Centaur status reconciliation wake the
controller. Manual dispatch and a scheduled fallback can also reconcile pending
requests. It rechecks the head, base, actor permission, receipt, trusted final
report, App status, required checks, review threads and strict branch protection
before the merge API call. A head or base change stops the request; integrate,
review the relevant delta, and explicitly renew authorization. The controller
never refreshes a branch or invents approval. GitHub applies branch protection
and the expected-head guard to the actual merge. An uncertain API outcome is
reported without an immediate blind retry; later reconciliation reads canonical
PR state. There is no delivery-time guarantee.

Provision a **separate** landing App before enabling this optional controller.
The ordinary Actions token cannot read the complete branch-protection settings;
GitHub requires [Administration read permission](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection)
for that API. Do not expand or reuse Centaur's status-writing credential.

- Install the new App only on the selected repository with Actions, Administration,
  Checks, Commit statuses, Issues and Pull requests **read**, and Contents **write**.
  Do not grant bypass permissions or add it to a branch-protection bypass list.
- Create environment `pr-landing-writer` and restrict its deployment branches to
  the actual default branch. Store `PR_LANDING_APP_PRIVATE_KEY` only there.
- Keep the existing dedicated `CENTAUR_STATUS_APP_ID` and configure
  `CENTAUR_STATUS_APP_LOGIN` to that status App's exact `slug[bot]` identity.
  Keep `CENTAUR_REVIEWER_LOGIN` consistent with the trusted reviewer configuration.
- Retain strict required CI and the Centaur App-bound status. Confirm environment
  restrictions and the App's actual permissions before issuing a real request.

Set repository variable `PR_LANDING_APP_ID` to the numeric landing App ID **last**,
after the App, environment branch policy, private key and other required variables
are ready. Until that ID is set, the reconcile job is intentionally disabled;
scheduled runs do not create an empty environment or fail while minting a token.

Missing provisioning fails closed. This change does not install an App, grant
merge authorization, or dispatch a request. The other CI improvements operate
without this optional setup. Workflow/API behavior is validated with offline
fixtures; first hosted activation must be checked against the configured App and
environment before claiming the interruption handoff works end to end.

## Browser journey readiness

Observe each navigation or chooser action before it starts. Fresh draft runtime inventory must be consumed before configuring ordinary settings; role review depends on those settings, so its ten-second response phase follows configuration. Retain existing UI assertions and interaction deadlines. Require exact item/role or conversation identity, successful status and completed schema-valid bodies; task-page waits match a valid task tree by exact task ID. Deliberately delayed collection reads remain outside chooser readiness when canonical record/work reads are the tested dependency.

The worker-replacement journey now observes its fresh item-work GET from the
intended chooser route before asserting chat counts. Two unchanged hosted runs
expired at the default five-second DOM wait; the retained failure screenshot
showed the correct linked worker after expiry. Navigation first loads the canonical
record, then mounts the work read. Readiness requires the exact origin/item,
completed 200 response, valid work schema and expected linked conversation;
departing-route and pre-action reads cannot qualify. A ten-second data-readiness
phase starts before the click, followed by the unchanged five-second DOM checks.
This extends the permitted navigation-to-assertion sequence within the unchanged
180-second case bound; it does not change product operation deadlines, assignment
or history assertions, or wait for unrelated collection hydration.

The complete native non-git journey keeps its 120-second local envelope and uses a finite 180-second CI envelope. Retained hosted-runner evidence completed it in 106–112 seconds and cut off a valid final replay at 120 seconds. This is a composed fixture allowance; production, individual request, helper, approval and handoff deadlines remain unchanged. Timeouts still require diagnosis rather than automatic retry.
