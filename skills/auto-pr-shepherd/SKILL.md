---
name: auto-pr-shepherd
description: Compatibility alias for land-pr; prepare by default, merge only when authorized.
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

Follow the canonical `land-pr` instructions and pass through `$ARGUMENTS` as the PR selection. Mitzo includes the registry-selected dependency below; other skill hosts load `land-pr` from their available skill catalog. Use `--prepare-only` unless the user has authorized landing this PR. If unavailable, report the missing canonical skill.

Do not run a second shepherd engine, create goal trees or sessions, schedule recurring work, or infer merge permission from PR size or bot authorship. No arguments means the current branch's PR. `--all` inventories PRs read-only; it does not adopt or merge every open PR. The canonical skill owns CI, review convergence and final gating.
