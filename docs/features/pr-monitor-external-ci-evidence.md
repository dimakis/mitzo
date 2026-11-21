# Passive PR Watch: bounded external CI evidence

21 November 2026. Ordinary contributor `c2158d1d-9e74-8d55-b23a-5cd9cf2e7d43`,
coordinated by `d933a61d-7363-85ab-a329-93e6dc5a2050`. This increment starts at
[#1432](https://github.com/dimakis/mitzo/pull/1432), exact head
`7f4c572da48a918ebff189d33406a97b7b486fa0`, including unchanged #1427
`f9c4286135f0621ffd53474f70d7d300bef4f7e7`. Existing Telos records, assignments
and all source owners' published branches remain unchanged. This ordinary
contributor does not claim canonical ownership.

## Coverage and material limits

The authenticated reader now collects Checks and commit Status records for the
observer's exact selected SHA, through the existing opening/closing PR identity
fence and atomic publication. It remains passive: no delivery, Auto-fix, Merge,
model-generation port, scheduler or live activation is added.

**The existing 16-HTTP-call / 20-second budget is unchanged. An empty refresh now
costs 12 HTTP calls. Four single-job workflows fit at 16; five exhaust 16 during
closing-head verification and remain incomplete with no actionable outbox.**
Larger fanout may stop earlier at the existing pre-review reserve fence. This is
a material coverage limit, not full external-CI qualification. The three new reads
are the suite-count guard, Checks, and Statuses. Every actual request, including
`/user`, uses the existing reservation owner. No source is silently omitted to
make an observation appear complete.

Each source page remains bounded to 100 items and 1 MiB; the combined normalized
CI page also retains its 100-item bound. Check pagination uses `total_count` and
requires the expected page length. Status pages of 100 require another bounded
page. Duplicate records, insufficient budget, oversized responses, malformed
payloads, uncertain chronology or missing provenance stay partial. More than one
page can fit for an otherwise empty refresh; 101 Checks or Status contexts take
exactly 16 calls in the offline owner/consumer tests.

Unsupported Status failure references remain **non-actionable**. GitHub's Status
`target_url` is producer-controlled; the supported UI reference policy has no
exact GitHub Status permalink. A current failure/error therefore retains the last
complete snapshot/history with an explicit `incomplete` diagnostic and clears
eligibility/outbox. With no prior successful snapshot, the snapshot stays absent.
It does not publish a fabricated failure link or retain raw producer text. Newer
pending/success records can supersede old failures for the same context.

On any incomplete refresh, retained successful evidence is historical, not proof
of current success. Successful aggregate CI is never required-check coverage,
branch-protection satisfaction, review approval or merge readiness.

## Source semantics and references

Sources inspected on 21 November 2026:

- [Checks for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference):
  `filter=all` avoids the completion-time `latest` filter hiding pending work.
  GitHub caps this endpoint at the 1,000 most recent suites. A charged suite-count
  read rejects the boundary at 1,000 rather than claiming full coverage.
- [Commit Statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference):
  records are returned newest first. Contexts are case-insensitive. The reducer
  uses creation timestamps, never numeric ID magnitude, and treats distinct
  records tied at the same timestamp as ambiguous. Repository + normalized
  context defines source identity. Creator ID and exact API record URL must exist.
- [Workflow jobs for an attempt](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt):
  `check_run_url` is the explicit Check association. It is validated against the
  same repository and exact numeric Check ID; equal names cannot establish it.
- A single authenticated source read of
  `/repos/dimakis/mitzo/commits/7f4c572da48a918ebff189d33406a97b7b486fa0/check-runs?filter=all&per_page=1&page=1`
  confirmed Check `136957780129`, GitHub app `15368`, suite `121630400641`, the
  exact head, and GitHub-generated
  `https://github.com/dimakis/mitzo/actions/runs/44940682630/job/136957780129`.
  This was payload qualification, not Watch activation or repeated CI polling.

Check identity is app ID + check name. Started timestamps order distinct runs;
missing/tied chronology cannot supersede a failure. Known Actions mappings are
removed from this name-based reduction and retain the existing workflow/run/attempt
reducer. Every mapping requires matching head, state and completion timestamp;
duplicate/conflicting mappings remain partial. An Actions-form Check permalink
must also agree with the mapped run and job IDs. No assumption equates job and
Check IDs.

Exact API record URLs bind numeric IDs to the selected repository. Only validated
same-repository GitHub-generated Check `html_url` shapes are retained: `/runs/ID`
or `/actions/runs/RUN/job/JOB`. The known `/runs/ID?check_suite_focus=true` navigation
query is stripped only after an exact match; arbitrary queries/fragments, hosts,
credentials, repository paths and mismatched IDs are rejected. No `details_url`,
`target_url`, output, description or name becomes a command, fetch target or
retained summary. The existing public `check` reference kind and URL policy are
unchanged; external source variants are internal to the read port.

Mapped failures use the same canonical Check finding as the external-only view.
Discovering a mapping on a later refresh therefore preserves the immutable event
identity and evidence digest instead of enqueueing the same failure again.

## Offline validation

340 tests across 17 files pass with one worker and a 1 GiB Node heap: the retained
287-test suite, 52 new external-CI tests, and one additional workflow-budget boundary
case. New behavior was observed failing before implementation. Tests exercise the
real authenticated reader, observer and SQLite consumer, including supersession,
separate apps/contexts, ambiguous chronology, stale/closing heads, account loss,
authority loss, malicious URLs/text, pagination/truncation, rate limits, charged
requests, immutable canonical deduplication, retained history on exhaustion and
zero model turns. Existing review-author, revocation and authority tests remain.

Protocol/harness/client builds, focused server + new-test TypeScript, changed-file
ESLint, Prettier and `git diff --check` pass. Full root/application builds remain
CI work under the repository's 1 GiB memory restriction; this candidate does not
claim those checks passed. No browser or live model test was needed or run for
this backend-only increment. No merge or deployment occurred.

Dependency preparation used only the two hash-qualified recovery scripts in this
checkout's ignored `.mitzo-devtools/recovered-setup`, with `install:true` and
`dependencyStore:false`; dependencies and generated artifacts stay in this root.
No release `node_modules` were borrowed, no credentials were read or copied, and
global configuration and source-checkout contents were unchanged. Local commits
use per-command unsigned configuration.

## Integration and landing

The lease contributor owns observer custody/acquire/release/publish/fail plumbing;
this branch changes only CI schema/reduction/findings and aggregate CI selection.
Quota/controller/runtime implementations are unchanged. Existing test transports
explicitly supply empty external sources and updated request counts. No UI protocol
fields are removed or widened, including siblings' optional fields.

Keep the candidate draft. Land dependencies first, then reconcile sibling edits
at their explicitly coordinated seams. Landing still requires exact-head CI,
trusted Centaur final LGTM **and** merge recommendation, valid App status and zero
blocking findings. Publication does not authorize merge, deployment or activation.
