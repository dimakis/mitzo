# Mitzo agent instructions

Read `CLAUDE.md` for repository commands, architecture, test discipline, and workflow. Preserve other sessions' branches, task files, provider history, and sandbox ownership.

## Required merge gate

Green CI is insufficient to merge. Require Centaur's final LGTM and `merge` recommendation for the exact current PR head, with zero new or unresolved blocking findings. Missing, stale, dismissed, `fix`, and `human_decision` reviews block merge. Pushing a fix does not verify it. If the automatic review limit is reached, request an explicit final Centaur review. Recheck after every push, and use `--match-head-commit` when merging. Never bypass the gate with an admin merge. MGMT provides `python -m mgmt_lib.pr_merge_gate OWNER/REPO NUMBER [--merge]` for this check.

Production activation requires reviewed, accepted sources. A publication is distinct from consumer adoption: verify the selected knowledge and actual runtime before delivering it between turns. Keep published knowledge separate from writable task roots. Repair only the selected invalid content-addressed knowledge cache under its owning sandbox's lifecycle fence; preserve task data and unrelated views.

Tests that make real model calls must explicitly use a supported Luna model. State the exact model and charged account before live tests; obtain approval if Luna is unavailable or another model is required.

The `Centaur merge gate` workflow requires a dedicated GitHub App credential isolated in the default-branch-only `centaur-status-writer` environment. Branch protection must bind `Centaur final LGTM` to this App's numeric ID alongside CI. See `docs/operations/mgmt-knowledge-publication.md` for mandatory provisioning. Pushes and review comments wake the writer; five-minute reconciliation covers review changes. Missing or stale reports stay pending, blocking or dismissed reports fail. Verify App identity, environment restrictions, a real status and branch protection before claiming enforcement.

For a separate Centaur publishing account, configure the GitHub repository variable `CENTAUR_REVIEWER_LOGIN`; keep it consistent with Mitzo’s `trusted_reviewer`/host `CENTAUR_REVIEWER_LOGIN`. The MGMT CLI and shepherd also honor that host variable (the CLI permits an explicit `--centaur-author`). Otherwise the repository owner is the trusted publishing account.
