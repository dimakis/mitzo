---
name: auto-pr-shepherd
description: Compatibility entry point for land-pr. Prepare a selected PR by default; land it only when the user requests merge. Use land-pr for new workflows.
mutating: true
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
---

Read the available `land-pr` skill (normally `../land-pr/SKILL.md`) and pass through the PR selection. Use `--prepare-only` unless the user has authorized landing this PR. If unavailable, report the missing canonical skill.

Do not run a second shepherd engine, create goal trees or sessions, schedule recurring work, or infer merge permission from PR size or bot authorship. No arguments means the current branch's PR. `--all` inventories PRs read-only; it does not adopt or merge every open PR. The canonical skill owns CI, review convergence and final gating.
