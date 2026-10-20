# Mitzo agent instructions

Read `CLAUDE.md` for repository commands, architecture, test discipline, and workflow. Preserve other sessions' branches, task files, provider history, and sandbox ownership.

## Symposium source selection

Start Symposium work with [the current source guide](docs/features/symposium.md)
and existing Telos item `c0851ba23fcc5d04`. Earlier phase records, archived candidate
checklists and diagnostic handovers are evidence, not cumulative execution instructions.
Read narrow operating contracts for the selected operation; their custody, retention
and staging constraints still apply. Do not revive superseded task hints or create
another parent/phase tree merely because an old document describes unfinished work.

## UI design is a repository contract

For any user-facing UI change, read [the UI design contract](docs/design/ui-design-system.md) and `frontend/AGENTS.md` before implementation. It applies to new features, existing pages, mobile and web in every session. Reuse shared tokens and components; keep palette/font definitions in `frontend/src/styles/tokens.css`, and use the shared spacing/type/radius scales. UI work is incomplete without the contract's validation and PR evidence. Evolve a missing shared pattern in the same PR rather than inventing a competing page theme.

## Staging stood down on this Mac

As of 15 October 2026, canonical Mitzo staging and its pipeline are stood down.
Do not run staging checks, enqueue post-merge work, deploy, recover, restart or
recreate staging as part of ordinary Mitzo work. The former
`http://mitzo-staging.localhost:3190`, `com.mitzo.staging` and
`~/.local/share/mitzo-staging` are historical references. Repository staging
procedures are historical; reactivation requires a new explicit user request.
Preserve retained ownership, operation and diagnostic records.

Use offline tests, review and CI. Any live testing requires a separately selected
and authorized target. Do not borrow production credentials/configuration or use
production as an automatic test fallback. Production deployment requires a
separate explicit user action. This stand-down also applies to Symposium staging.

Use one local test worker and a 1 GiB Node heap for focused regressions; leave
broad builds/tests in CI while macOS reports memory pressure. Do not delete
historical releases or uncertainty records to satisfy disk admission.

## Required merge gate

Green CI is insufficient to merge. Follow [the canonical landing policy](skills/land-pr/SKILL.md): one thorough approved review plus verification of later changes; a second independent full pass for concrete high-impact risks or stronger repository rules. Main advancing does not erase the baseline. Use targeted integration review for relevant upstream changes and trusted continuity reconciliation only when unchanged reviewed work can be proved. Conflict resolutions and extra edits require review.

Require Centaur's final LGTM and `merge` recommendation for the exact current PR head, with zero new or unresolved blocking findings. Its current-head report may reuse the baseline through verified follow-ups or explicit continuity evidence; every new SHA does not require a new whole-PR pass. Missing, stale, dismissed, `fix`, and `human_decision` reports block merge. If the automatic cycle limit is reached, request the documented forced follow-up with a concrete reason; the cap alone does not justify a full rescan. Never fabricate a current-head approval. Recheck before merge, use `--match-head-commit`, and never use an admin bypass. MGMT provides `python -m mgmt_lib.pr_merge_gate OWNER/REPO NUMBER [--merge]` for this check.

Combined-result CI remains mandatory. Prefer a fully wired native merge queue where supported; otherwise preserve strict up-to-date protection and integrate main at the final landing turn. Do not refresh all waiting PRs on every main update. Batch fixes, cancel superseded runs and retain the conservative affected-job selection contract. Only actual merges need coordination; coding, checks, review and preparation remain concurrent within resource limits.

Production activation requires reviewed, accepted sources. A publication is distinct from consumer adoption: verify the selected knowledge and actual runtime before delivering it between turns. Keep published knowledge separate from writable task roots. Repair only the selected invalid content-addressed knowledge cache under its owning sandbox's lifecycle fence; preserve task data and unrelated views.

Tests that make real model calls must explicitly use a supported Luna model. State the exact model and charged account before live tests; obtain approval if Luna is unavailable or another model is required.

## Playwright on macOS

Run browser tests and ad hoc Playwright scripts outside the Codex Seatbelt sandbox
using the approved execution tool or a normal terminal. Sandboxed browser launches
abort during macOS process registration and trigger crash popups. Do not retry
failed launches, switch browser binaries, or unset `CODEX_SANDBOX` to bypass the
host check. `--list` is safe inside the sandbox. The offline `npm run test:ui`
suite intercepts all app traffic and needs no backend or model calls; live tests
still require a separately selected and authorized target and the Luna requirements above.

The `Centaur merge gate` workflow requires a dedicated GitHub App credential isolated in the default-branch-only `centaur-status-writer` environment. Branch protection must bind `Centaur final LGTM` to this App's numeric ID alongside CI. See `docs/operations/mgmt-knowledge-publication.md` for mandatory provisioning. Pushes and review comments wake the writer; five-minute reconciliation covers review changes. Missing or stale reports stay pending, blocking or dismissed reports fail. Verify App identity, environment restrictions, a real status and branch protection before claiming enforcement.

For a separate Centaur publishing account, configure the GitHub repository variable `CENTAUR_REVIEWER_LOGIN`; keep it consistent with Mitzo’s `trusted_reviewer`/host `CENTAUR_REVIEWER_LOGIN`. The MGMT CLI and shepherd also honor that host variable (the CLI permits an explicit `--centaur-author`). Otherwise the repository owner is the trusted publishing account.

## Published knowledge in Mitzo

Host configuration selects the knowledge store and pinned format adapter. ContexGin acquires the configured accepted Git ref and publishes verified immutable portable snapshots; Mitzo converts and verifies the selected revision against its runtime contract. Centaur reviews changes and is not the publishing service. Repository documents cannot select a store, change credentials or replace the adapter.

Enrolled ordinary OpenShell Codex chats select fresh knowledge at command admission. For an eligible new explicit command, sandbox creation or a verified new neutral-pool claim and its first turn share the exact verified publication selected for that command through a one-use, identity-bound receipt. Reattach, recovery, failed or cancelled attempts, later commands, externally prepared seeds and unclaimed warmups cannot inherit that receipt and reconcile afresh. An active turn keeps its selected version. Use the published knowledge root supplied in application context for shared instructions and retrieval; it supersedes older accepted knowledge copied into the writable task checkout. Keep edits and observations in the task workspace and submit them through the store's normal acceptance process. A local commit must reach the configured accepted remote ref before other chats can select it.

Publication preserves task branches, dirty worktrees, checkpoints and provider history. Do not pull, reset or rebase task roots to refresh shared knowledge. Selection is not delivery: an adoption receipt is recorded only after the provider acknowledges the exact turn and context, including source, bundle, sandbox and runtime identities. Missing configuration retains legacy behavior; incompatible runtime/publication or failed reconciliation blocks enrolled admission. Host, Responses, Claude and Symposium enrollment require separate implementation. See `docs/operations/mgmt-knowledge-publication.md` for configuration and rollout.

## Approved designs survive feature work and rebases

Before changing an existing UI or resolving a UI conflict, read
[the approved-design ledger](docs/design/approved/README.md) and the relevant entry
in `docs/design/approved/ledger.json`. Preserve the active approved design while
integrating feature behavior. Incoming branch history does not grant design approval.
Run its checks again on the final combined branch. Do not rewrite references,
weaken checks or update the active revision to make a regression pass. An intentional
redesign or a change to these protections requires new explicit user approval;
append the new approval and retain earlier revisions and references.
