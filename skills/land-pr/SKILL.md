---
description: Shepherd a PR from open to merged — CI fixes, review cycles, final merge
mutating: true
allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
---

Land PR $ARGUMENTS through the full merge lifecycle.

If `$ARGUMENTS` is a PR number, use it directly. Otherwise detect the current branch's open PR with `gh pr view --json number,url,statusCheckRollup,reviews,headRefName`.

## Lifecycle

Repeat this cycle until the PR is merged:

### 1. Ensure CI is green

```bash
gh pr checks <number> --watch
```

If any check fails:

1. `gh run view <run-id> --log-failed` to get the failure.
2. Fix the issue locally.
3. Commit and push. Wait for CI to go green before proceeding.

### 2. Await review

Check for pending reviews:

```bash
gh api repos/{owner}/{repo}/pulls/<number>/reviews
gh api repos/{owner}/{repo}/pulls/<number>/comments
```

If no reviews yet, stop and tell the user — nothing to act on until a reviewer responds.

### 3. Address review findings

For every review comment:

1. **Read** the referenced code and understand the full context.
2. **Fix** — the default action. Only push back if investigation proves the finding is factually wrong.
3. **Commit and push** the fixes as a cohesive commit.

### 4. Return to step 1

After addressing a review round, CI must pass again before the next review. Two approved review rounds with green CI means the PR is ready.

### 5. Merge

When CI is green and reviews are approved:

```bash
gh pr merge <number> --squash --delete-branch
```

Report the merge result to the user.

## Principles

- Never merge with failing CI. Fix it first.
- Never dismiss review findings without evidence. Default is to fix.
- Each review round is: green CI → address comments → green CI → next round.
- Keep the user informed at each phase transition.
