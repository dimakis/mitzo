---
description: Surface failure modes, missing tests, and unsafe assumptions
allowed-tools:
  - Read
  - Glob
  - Grep
---

Scan the area described by $ARGUMENTS for risks and potential failure modes.

Focus on:

1. **Missing error handling** — unhandled promise rejections, uncaught exceptions, missing null checks
2. **Edge cases** — empty inputs, boundary values, concurrent access, race conditions
3. **Missing tests** — critical paths without test coverage, untested error branches
4. **Unsafe assumptions** — hardcoded values, implicit ordering, undocumented contracts
5. **Security concerns** — injection vectors, path traversal, unvalidated input, exposed secrets

For each risk:

- Describe the failure scenario
- Rate severity: **critical**, **high**, **medium**, or **low**
- Suggest a mitigation

Present all findings ranked by severity. Do not modify any files — this is an analysis-only scan. Wait for approval before proposing fixes.
