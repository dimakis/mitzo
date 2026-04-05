---
description: Find complexity, duplication, and cleanup opportunities
allowed-tools:
  - Read
  - Glob
  - Grep
---

Analyze the code in the area described by $ARGUMENTS for opportunities to simplify.

Focus on:

1. **Unnecessary complexity** — over-abstraction, premature generalization, deep nesting
2. **Duplication** — repeated logic that could be consolidated
3. **Dead code** — unused exports, unreachable branches, stale imports
4. **Naming clarity** — confusing names, misleading abstractions
5. **Structural issues** — files doing too much, tangled dependencies

For each finding:

- Describe the issue concisely
- Explain why it matters
- Suggest a specific improvement

Present all findings before making changes. Do not modify any files until the user reviews and approves your suggestions.
