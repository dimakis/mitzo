# Mitzo agent instructions

Read `CLAUDE.md` for repository commands, architecture, test discipline, and workflow. Preserve other sessions' branches, task files, provider history, and sandbox ownership.

## Required merge gate

Green CI is insufficient to merge. Require Centaur's final LGTM and `merge` recommendation for the exact current PR head, with zero new or unresolved blocking findings. Missing, stale, dismissed, `fix`, and `human_decision` reviews block merge. Pushing a fix does not verify it. If the automatic review limit is reached, request an explicit final Centaur review. Recheck after every push, and use `--match-head-commit` when merging. Never bypass the gate with an admin merge. MGMT provides `python -m mgmt_lib.pr_merge_gate OWNER/REPO NUMBER [--merge]` for this check.

Production activation requires reviewed, accepted sources. A publication is distinct from consumer adoption: verify the selected knowledge and actual runtime before delivering it between turns. Keep published knowledge separate from writable task roots. Repair only the selected invalid content-addressed knowledge cache under its owning sandbox's lifecycle fence; preserve task data and unrelated views.

Tests that make real model calls must explicitly use a supported Luna model. State the exact model and charged account before live tests; obtain approval if Luna is unavailable or another model is required.

The `Centaur merge gate` workflow requires a dedicated GitHub App credential isolated in the default-branch-only `centaur-status-writer` environment. Branch protection must bind `Centaur final LGTM` to this App's numeric ID alongside CI. See `docs/operations/mgmt-knowledge-publication.md` for mandatory provisioning. Pushes and review comments wake the writer; five-minute reconciliation covers review changes. Missing or stale reports stay pending, blocking or dismissed reports fail. Verify App identity, environment restrictions, a real status and branch protection before claiming enforcement.

For a separate Centaur publishing account, configure the GitHub repository variable `CENTAUR_REVIEWER_LOGIN`; keep it consistent with Mitzo’s `trusted_reviewer`/host `CENTAUR_REVIEWER_LOGIN`. The MGMT CLI and shepherd also honor that host variable (the CLI permits an explicit `--centaur-author`). Otherwise the repository owner is the trusted publishing account.

## Published knowledge in Mitzo

Host configuration selects the knowledge store and pinned format adapter. ContexGin acquires the configured accepted Git ref and publishes verified immutable portable snapshots; Mitzo converts and verifies the selected revision against its runtime contract. Centaur reviews changes and is not the publishing service. Repository documents cannot select a store, change credentials or replace the adapter.

Enrolled ordinary OpenShell Codex chats refresh knowledge before sandbox creation and before each safe turn. An active turn keeps its selected version. Use the published knowledge root supplied in application context for shared instructions and retrieval; it supersedes older accepted knowledge copied into the writable task checkout. Keep edits and observations in the task workspace and submit them through the store's normal acceptance process. A local commit must reach the configured accepted remote ref before other chats can select it.

Publication preserves task branches, dirty worktrees, checkpoints and provider history. Do not pull, reset or rebase task roots to refresh shared knowledge. Selection is not delivery: an adoption receipt is recorded only after the provider acknowledges the exact turn and context, including source, bundle, sandbox and runtime identities. Missing configuration retains legacy behavior; incompatible runtime/publication or failed reconciliation blocks enrolled admission. Host, Responses, Claude and Symposium enrollment require separate implementation. See `docs/operations/mgmt-knowledge-publication.md` for configuration and rollout.

## Canonical Symposium staging

Use the existing staging URL http://mitzo-staging.localhost:3190 and private root ~/.local/share/mitzo-staging. Do not create a staging backend/custodian for each conversation. Read docs/operations/symposium-singleton-staging.md before preparing activation; the current ordinary stage is not yet Symposium-ready. Provider configuration, source acceptance and retained original-owner shutdown remain required. Production is excluded.
