---
description: Review current diff or branch like a mobile-friendly code review
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

Review the current changes for $ARGUMENTS (or the full working tree diff if no scope is specified).

Start by running `git diff` (or `git diff main...HEAD` for branch reviews) to see what changed.

For each changed file, evaluate:

1. **Bugs** — logic errors, off-by-one, null dereference, type mismatches
2. **Regressions** — does this break existing behavior or contracts?
3. **Missing tests** — are the changes tested? What cases are missing?
4. **Unsafe assumptions** — hardcoded values, race conditions, unvalidated input
5. **Style and clarity** — naming, structure, unnecessary complexity

Format your review as a compact list grouped by file, suitable for reading on a small screen. Use short, direct language.

Present your review before making changes. Do not modify any files until the user explicitly asks for fixes.
