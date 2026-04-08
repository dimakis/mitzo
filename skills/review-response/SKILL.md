---
description: Triage PR review comments, investigate each finding, and fix properly
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

Triage all review comments on $ARGUMENTS.

If `$ARGUMENTS` is a PR number, fetch comments with `gh api repos/{owner}/{repo}/pulls/{number}/reviews` and `gh api repos/{owner}/{repo}/pulls/{number}/comments`. If no number is given, detect the current branch's open PR with `gh pr view --json number,url`.

For **every** finding:

1. **Investigate** — read the referenced code, search for related patterns, understand the full context. Do not dismiss findings without evidence.
2. **Classify** severity:
   - **Critical** — bugs, data loss, security issues, correctness failures
   - **Valid** — real improvements to maintainability, robustness, or clarity
   - **Cosmetic** — style-only changes with no functional impact
3. **Decide** — the default is to **fix**. Only reject a finding if investigation proves it is factually wrong (not just unlikely). "It can't happen today" is not a reason to skip — if the code allows it structurally, fix it. Boy Scout rule: leave the code better than you found it.

Present all findings in a compact table before making changes:

| #   | File | Finding | Severity | Action | Reason |
| --- | ---- | ------- | -------- | ------ | ------ |

After presenting, wait for approval. Then fix everything marked for action.

**Principles:**

- Every valid finding gets fixed. No deferring to "future PRs" or "out of scope."
- If a finding reveals a deeper issue than what the reviewer described, fix the deeper issue.
- If multiple findings point to the same root cause, fix the root cause once rather than patching each symptom.
- If a reviewer suggests an approach and a better one exists, use the better one — but acknowledge the reviewer's insight.
