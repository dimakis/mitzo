---
name: autopilot
description: Prepare a PR using land-pr --prepare-only; never mark ready, enable auto-merge or merge.
mutating: true
requires-skills:
  - land-pr
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - Agent
  - TaskOutput
  - TaskStop
  - GitCommit
  - RequestGithubPublish
  - ExecuteProviderCapability
---

Follow the canonical `land-pr` instructions with `--prepare-only`, passing through `$ARGUMENTS` and other constraints. Mitzo includes the registry-selected dependency below; other skill hosts load `land-pr` from their available skill catalog. This alias owns no separate lifecycle, scheduler or review policy. If the canonical skill cannot be found, report that missing dependency rather than restoring an older workflow.

Existing autopilot invocations do not authorize marking a draft ready, enabling auto-merge or merging. An explicit later user instruction to land this PR can switch to canonical landing mode.
