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
  - Agent
  - TaskOutput
  - TaskStop
  - GitCommit
  - RequestGithubPublish
  - ExecuteProviderCapability
---

# Land PR

Select `$ARGUMENTS` (PR URL, repo/number or current branch). Read repo rules; refresh head/base, CI, reviews and merge state. Attach the PR where supported.

## Scope and ownership

- Landing/merging authorizes merge after gates pass, regardless of size or CI changes. Inspection, review and preparation do not authorize merge.
- `--prepare-only` fixes and verifies, but never marks a draft ready, enables auto-merge or merges. Existing `autopilot` calls retain this mode unless the user explicitly changes it.
- Work only selected PRs. No argument selects the current branch; `--all` inventories read-only unless the user selects a batch. Do not implicitly create goal trees, schedules or shepherd sessions.
- Keep one owner per PR. Check session/task/queue state before taking over; coordinate with an active owner before pushing or requesting review. State ownership and the next blocker. This is not a distributed lock.
- Coding, branch refreshes, offline tests, CI, reviews and preparation may run concurrently within task limits, authority and dependencies. Serialize actual merges per repository, verifying each before the next. Do not pause whole sessions or impose global test/preparation slots.

## Work the blockers together

1. Refresh the remote PR branch before editing; preserve other worktrees and uncommitted work. Resolve clear conflicts; investigate active findings and failing CI logs.
2. Integrate the base when required by a dependency, an actual conflict, a known upstream fix, or when this PR reaches its final landing turn and strict protection requires it. Do not rebase every waiting PR whenever main moves. Prefer a merge of the base that preserves remote history; never force-push as a routine shepherd action.
3. Investigate every active finding against the code. Fix and verify valid in-scope blockers. Reject invalid/resolved findings with concrete evidence. Record explicitly non-blocking follow-ups without adding a blocking round; never silently downgrade a blocker.
4. Ask only when a genuine unresolved product/security/data decision prevents a correct fix. Routine implementation fixes already within the user's task do not need another approval. Reply to and resolve review threads only where authorized by the task or invoked workflow; never pretend a reviewer approved a fix.
5. Run focused offline checks within repository resource limits; complete local review below, then push and await required CI. Never remove coverage, weaken checks or mark failures green. CI optimizations must retain coverage.

Batch known fixes before pushing. Run `npm run check:source-artifacts`; retain and regenerate source pins for changed/extracted files. See [CI delivery](../../docs/operations/ci-delivery.md) for complete preflight, retry and timing rules.

Preserve deployment/live-test restrictions; landing does not authorize deployment. Real model-backed tests follow the user's test model/account rules; ordinary review is separate.

## Local review before push

Before the first reviewable push, run two read-only subagents concurrently within host capacity: correctness/integration/affected callers, and behavior/test adequacy/failure cases. Each must be independent of implementation in its scope. Add security review for concrete permission/security/data risks. These focused roles alone do not satisfy the full-pass rule below.

Without native delegation, ordinary Mitzo may use `RequestGithubPublish` host review under [this contract](../../docs/operations/prepared-repository-chat-flow.md). Every other gate below remains.

Give both the diff, requirements, repo rules, base and candidate SHA (or full tracked/untracked fingerprint). Keep it stable. Record reviewer/report IDs, scope, limits and evidence-backed findings: severity, location and failure scenario. Consolidate and fix blockers together; document rejected/resolved dispositions. Request focused follow-ups on batched fixes, affected callers and prior findings; reuse unchanged coverage. Repeat only for unresolved blockers or material scope changes; report persistent blockers instead of looping.

Complete missing local coverage while CI runs. Reuse qualifying reviews and follow-ups; verify actual candidate coverage before pushing. Use only exposed, permitted delegation; respect resource/live-test limits and avoid parallel broad suites. If unavailable or denied, report unfinished coverage, continue other preparation, and obtain independent review through an authorized host before pushing. Never bypass with another CLI or self-approve. Local review never replaces Centaur or changes its timing, configuration or final gate.

## Review convergence

- Require **one thorough approved review** of the PR, followed by verification of subsequent changes. Preserve its review ID and SHA as the baseline. A qualifying follow-up completes coverage of the changed head; it need not rescan unchanged work.
- Require a second independent full pass for material security/permission changes, destructive data migrations, breaking shared protocols, merge/review enforcement changes, or similarly high-impact changes. State the concrete risk; repository rules may require more. Reuse completed qualifying passes rather than restarting an approval count after every push.
- Read the trusted reviewer's actual report, commit identity, unresolved threads and review/check state. `COMMENTED` can carry a valid Centaur LGTM; a green job named `centaur` is not the final LGTM gate. A new blocker must be fixed and verified; it does not erase completed review of unchanged work.
- Review PR-owned deltas, affected callers, dependencies and prior findings; batch fixes into one push. Request a full pass only when missing or materially invalidated, including a missing required independent pass.
- Main advancing does not invalidate the baseline review. For a clean integration, inspect the upstream delta for changes to assumptions, APIs, dependencies, shared contracts and security/data behavior. Preserve the baseline and request targeted integration review where relevant. Conflict resolutions and extra merge edits are new PR-owned changes and must be reviewed.
- Use trusted service continuity reconciliation when it can prove an independent accepted-base merge without PR-owned edits. This is reuse of an earlier approval, not a new independent review. Never infer safety merely from disjoint filenames, a clean Git merge, a new SHA or green CI. If the service cannot prove reuse, obtain its focused follow-up instead of a redundant whole-PR pass.
- Before requesting review, check active/queued jobs for this PR/SHA. A CI wait is not missing review. Inspect uncertain outcomes before retrying; never duplicate qualifying review.
- Prefer automatic follow-up after fixes. At its cycle limit, use the deployed service's documented forced follow-up with a concrete reason and intact safety checks; the cap does not warrant full review. Preserve configured service, credentials and model; never expose secrets.

## Final gate and merge

For Centaur-governed repositories, require the trusted publisher's non-dismissed **final LGTM**, recommendation **`merge`**, and **zero new and unresolved blocking findings** for the exact live head. That report may combine the retained thorough review with verified follow-ups or explicit trusted continuity evidence; a fresh full pass on every SHA is not required. `fix`, `human_decision`, missing or stale evidence blocks merge. Verify the repository's required `Centaur final LGTM` status and its configured App identity, not only text in a comment. Use a repository-provided gate helper where available, after checking it implements the current contract.

For a valid current-head review with pending status, inspect the writer and use its documented PR-scoped reconciliation trigger. Never substitute another review or write approval yourself. Reconciliation has no guaranteed deadline.

Validate the combined PR plus current base before merging. Prefer a native merge queue where the repository supports it and all required checks (including the trusted review gate) support its merge-group contract. Do not enable a queue before those checks are wired and tested. On a repository without queue support, retain strict up-to-date protection: integrate the latest base at the final landing turn and run required CI on that combined result. Do not refresh every waiting branch when main advances. Preserve completed review; re-evaluate only the relevant integration delta.

Before merging, refresh head/base, required checks, threads, trusted final review and mergeability. CI must cover the exact candidate against the accepted base; changed combined trees require fresh checks. All required checks must pass; skips require the repository's explicit conditional-check contract. Refresh integration evidence if main or the PR changes. Never copy statuses between SHAs, disable strict protection or bypass unknown/contradictory gates.

In prepare-only mode, report the verified state and remaining final-integration work, then stop. In authorized landing mode, mark a draft ready once its scoped work is complete, then merge using the repository's method and an exact-head guard, for example:

```bash
gh pr merge NUMBER --repo OWNER/REPO --squash --match-head-commit VERIFIED_SHA
```

Never use `--admin`. Do not delete a branch still used by a worktree or another session. If the head changes or merge is rejected, refresh evidence before retrying. Confirm `MERGED` and the merge commit from GitHub before reporting success.

Report changes and the next blocker. Avoid tight polling. Report concrete external blockers without claiming readiness. Record queue/run time, review/continuity passes and avoidable refreshes. Cancel superseded PR runs; retain affected-job selection, full coverage and combined-result validation.
