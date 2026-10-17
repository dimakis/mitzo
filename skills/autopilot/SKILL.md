---
name: autopilot
description: Compatibility entry point for land-pr --prepare-only. Fix a selected PR's CI and review blockers without marking ready, enabling auto-merge or merging.
---

Read the available `land-pr` skill (normally `../land-pr/SKILL.md`) and follow it with `--prepare-only`, passing through the selected PR and other constraints. This alias owns no separate lifecycle, scheduler or review policy. If the canonical skill cannot be found, report that missing dependency rather than restoring an older workflow.

Existing autopilot invocations do not authorize marking a draft ready, enabling auto-merge or merging. An explicit later user instruction to land this PR can switch to canonical landing mode.
