---
name: autopilot
description: Prepare a PR using land-pr --prepare-only; never mark ready, enable auto-merge or merge.
mutating: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
---

Read the available `land-pr` skill (normally `../land-pr/SKILL.md`) and follow it with `--prepare-only`, passing through `$ARGUMENTS` and other constraints. This alias owns no separate lifecycle, scheduler or review policy. If the canonical skill cannot be found, report that missing dependency rather than restoring an older workflow.

Existing autopilot invocations do not authorize marking a draft ready, enabling auto-merge or merging. An explicit later user instruction to land this PR can switch to canonical landing mode.
