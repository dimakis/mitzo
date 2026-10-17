---
name: land-pr
description: Land PRs through CI, reviews and authorized merge; --prepare-only stops before merge.
mutating: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash
---

# Land PR

Resolve `$ARGUMENTS` as a PR URL, repository plus number, or the current branch's PR. Read repository instructions and refresh the live head, base, CI, review threads and merge state. Attach the selected PR when the host supports attachments.

## Scope and ownership

- A request to land or merge this PR authorizes the final merge after its gates pass. Do not ask again merely because the change is large or touches CI. A request to inspect, review or prepare does not authorize merge.
- `--prepare-only` fixes and verifies, but never marks a draft ready, enables auto-merge or merges. Existing `autopilot` calls retain this mode unless the user explicitly changes it.
- Work only the selected PRs. No-argument invocation resolves the current branch; `--all` is a read-only inventory unless the user has selected a batch for action. Do not create goal trees, scheduled jobs or additional shepherd sessions implicitly.
- Keep one owner per PR. Check available session/task/queue state before taking over; if another owner is active, coordinate instead of pushing or requesting a duplicate review. State ownership and the next blocker in this session. This convention is not a distributed lock.
- Independent coding, branch refreshes, offline tests, CI, reviews and PR preparation may proceed concurrently within each task's resource limits, authority and dependencies. Coordinate only actual merges, one at a time per repository, and verify the previous merge before the next. Do not pause whole sessions, require a global test lane or impose a central preparation slot.

## Work the blockers together

1. Refresh the remote PR branch before editing; preserve other worktrees and uncommitted work. Resolve clear conflicts, then investigate active findings and actual failing CI logs. Batch known fixes into one push where practical.
2. Integrate the base when required by a dependency, an actual conflict, a known upstream fix, or when this PR reaches its final landing turn and strict protection requires it. Do not rebase every waiting PR whenever main moves. Prefer a merge of the base that preserves remote history; never force-push as a routine shepherd action.
3. Investigate every active finding against the code. Fix valid in-scope blockers and verify them. Reject invalid or already resolved findings only with concrete evidence. Distinguish blocking findings from explicitly non-blocking follow-ups; record follow-ups without manufacturing another blocking review round. Do not silently downgrade a blocker.
4. Ask only when a genuine unresolved product/security/data decision prevents a correct fix. Routine implementation fixes already within the user's task do not need another approval. Reply to and resolve review threads only where authorized by the task or invoked workflow; never pretend a reviewer approved a fix.
5. Run focused offline checks that prove the fix, respecting repository resource limits, then push and wait for required CI. Never remove coverage, weaken checks or mark failures green to get through the gate. CI optimizations may change how checks run while retaining their coverage.

Repository deployment and live-test restrictions continue to apply. Landing is not deployment authorization. Real model-backed tests require the user's configured test model and account rules; ordinary code review is a separate workflow.

## Review convergence

- Read the trusted reviewer's actual report, commit identity, unresolved threads and review/check state. `COMMENTED` can carry a valid Centaur LGTM; a green job named `centaur` is not the final LGTM gate.
- Preserve the existing baseline of **two distinct approved review rounds**. Record their review IDs and SHAs; do not count duplicate deliveries as separate rounds. An approval on an ancestor can count toward the history only when subsequent changes have been reviewed and its findings remain resolved. The final approval must cover the exact current head and whole PR, including integrated base changes. A new blocker resets the clean-approval sequence. Repository rules may require more.
- Reuse already completed qualifying rounds. Do not request another review after the required evidence exists. Missing reviews mean inspect the queue and wait or request the missing review, not abandon the task.
- Before requesting, check for an active/queued job for this PR and SHA. A CI wait is not a missing review. If request outcome is uncertain, inspect job/review state before retrying.
- Prefer an automatic follow-up after a fix. Use the deployed review service's documented follow-up mode when an explicit request is needed for a changed head; do not silently turn every follow-up into a full review.
- Request a full final review only when it is actually missing, the automatic cycle limit prevents it, the change warrants a fresh full pass, or the second required independent round is still absent on an unchanged head. Include a concrete reason. Use the configured service and credentials without exposing secrets or modifying its model configuration.
- After every push, previous final-head evidence becomes stale. Recheck CI and obtain final review of the new head. Never substitute a locally written approval for the trusted service's report.

## Final gate and merge

For Centaur-governed repositories, require the trusted publisher's non-dismissed **final LGTM**, recommendation **`merge`**, and **zero new and unresolved blocking findings** for the exact live head. `fix`, `human_decision`, missing or stale evidence blocks merge. Verify the repository's required `Centaur final LGTM` status and its configured App identity, not only text in a comment. Use a repository-provided gate helper where available, after checking it implements the current contract.

If a valid current-head review exists but its required status remains pending, inspect the configured status writer. Use its documented PR-scoped reconciliation trigger when available; do not request another model review or write a replacement approval status yourself. A scheduled reconciliation is not a guaranteed deadline.

Immediately before merge, refresh the head and base, required checks, review threads, trusted final review and mergeability. All required checks must pass; skipped or missing checks qualify only under the repository's explicit conditional-check contract. If strict protection says the branch is behind, integrate once in the landing slot and repeat validation. Report unknown or contradictory gate state and diagnose it; never bypass it.

In prepare-only mode, report the verified state and remaining final-integration work, then stop. In authorized landing mode, mark a draft ready once its scoped work is complete, then merge using the repository's method and an exact-head guard, for example:

```bash
gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit VERIFIED_SHA
```

Never use `--admin`. Do not delete a branch still used by a worktree or another session. If the head changes or merge is rejected, refresh evidence before retrying. Confirm `MERGED` and the merge commit from GitHub before reporting success.

Keep updates focused on changes and the next blocker. Wait without tight polling; do useful independent work while CI/review runs. If progress needs human input or a broken external service, report the concrete blocker and evidence without claiming readiness. Record first-pass CI duration, review rounds and avoidable restarts when evaluating this workflow.
