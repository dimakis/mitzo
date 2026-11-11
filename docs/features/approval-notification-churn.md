# Approval consent and notification churn

Implementation evidence as of 11 November 2026, responding to Dimitri's request
to stop repeated approval notifications and repeated GitHub CI log consent across
Codex, Claude and Vertex. This document describes the proposed source change;
it is not evidence of production deployment or automatic-review qualification.

## Reuse consent for repository reads

An explicit **Allow for session** on a recognized GitHub CLI read covers subsequent
CI run, job and log reads for the same repository. For example, approving
`gh run view 42 -R owner/repo --log` covers
`gh api repos/owner/repo/actions/jobs/123/logs` in the same scope.

The shared parser admits only literal `gh run view`, `gh run list` and GET-only
`gh api repos/OWNER/REPO/...` commands with allowlisted arguments. Use an explicit
`--repo OWNER/REPO` (or `-R`) with run commands. Shell composition, writes, artifact
downloads, alternate hosts, headers and unknown arguments keep normal approval.
The consent card describes this repository scope before it is retained.

The native adapter also recognizes the observed `/bin/zsh -lc` envelope with
one complete single- or double-quoted literal command. It decodes only that
literal for classification, retains the shell identity in the consent key, and
executes/displays the unchanged original command. Expansion, additional shell
arguments, other shell modes and unsupported composition keep ordinary approval.
Bare and wrapped commands do not share a grant.

Codex binds consent to the current native owner, thread, directory identity and
requested access. Claude and Vertex use the shared permission handler and SDK
hook, binding consent to the account, workspace, mode and input access fields.
Changed accounts, directories or permissions do not inherit the grant. Revocation
and final execution checks remain in force. No generic Bash or shell-prefix grant
is created. Existing GitHubRead integration consent remains repository scoped and
separate from native shell networking.

## One approval alert per unread blocked chat

The notification center owns approval delivery. It prefers native push when
configured with devices, then Pushover or ntfy as a fallback. The shared runtime
handler no longer sends an independent second alert while that owner is active.
Standalone harness consumers retain their original notification route.

Approval preferences, quiet hours and preview privacy apply to every central
route. Legacy fallback alerts open Mitzo for review; they do not offer blind
approval of redacted or truncated details. HTTP failure is recorded as failure,
with bounded retries, rather than successful delivery. Partial native delivery
retries exclude devices that already accepted the alert and do not switch channels.

After a successful alert, another unread approval in that chat does not send a
second banner, including an expired request recreated by the agent. The store
persists this state across restarts. Reading/archiving the earlier notice or an
explicit decision ends its suppression; a notice older than 24 hours also stops
suppressing new work. Questions and other chats remain independent. Every pending
decision stays in the feed and badge count; coalescing grants no authority and
does not resolve requests. Expiry now tells the agent to wait for the user instead
of automatically recreating the unchanged request.

## Remaining automatic-review gap

The inspected native execution policy explicitly selects `reviewer: 'user'` and
`reviewerAvailability: 'unqualified'`. `Auto` mode alone is not proof of a working
"approve for me" reviewer. Claude/Vertex mode-based tool allowance likewise does
not establish equivalent model-backed review of escalations.

Completing that behavior requires a supported reviewer model, selected account
and billing route; verified review events and execution delivery; denial,
cancellation and revocation checks; and runtime-specific live qualification.
An unavailable reviewer must remain visible and must not grant access. This
change does not manufacture qualification or enable an unverified reviewer.

## Remaining workflow scope gaps

Authenticated `GitHubRead` and `TaskExecution github_read` now accept `log` on
`/repos/OWNER/REPO/actions/jobs/JOB_ID/logs`. For example, `log: { query: "FAIL" }`
returns matching lines using a literal filter; `offset` and `limit` page the
filtered text. Offsets count UTF-16 characters, and `nextOffset: null` marks the
end. Each fetch is limited to 8 MiB and each output page is bounded. Oversized
sources fail explicitly. Run-level ZIP downloads are not interpreted as text.
The same repository/task consent covers different job IDs and filters. Public
reads do not silently switch to credentials. This route avoids a shell redirect
or pipeline for ordinary failure inspection; it does not save a local log file.

Task status and authorization responses include an `executionRoute` containing
the selected tool name and current eligible grant IDs. Shared Codex/SDK/Vertex
guidance prefers that bounded executor for routine commands instead of asking
again through a separate native tool. Native guidance no longer overrides this
with a blanket preference for native Git. These are routing hints, not durable
authority: every task invocation still rechecks its operator, runtime, workspace,
mode, expiry, cancellation and revocation. Ask mode receives no execution route.

The native approval RPC can return only a decision; it cannot replace the command
or its execution result. Task commands have different credential/scratch boundaries
and in-flight cancellation from native commands. Converting an existing task grant
to native network consent would widen its scope. Transparent native delegation
therefore remains a platform requirement, not a behavior established by this PR.

This repository read grammar does not cover `gh pr view/checks`, log reads with
redirection or pipelines, Git fetch/push, or arbitrary Bash. TaskExecution can
cover selected routine commands and networking, but native tools retain their
own permission owner; a TaskExecution grant does not automatically become native
shell authority. A complete fix needs consistent task authority at each execution
adapter and bounded CI-log collection to local files, with current owner/account/root,
cancellation and revocation checks. Telos updates and publication also retain
their separate reviewed mutation contracts. Notification coalescing does not
remove these authorization requests or establish that the whole workflow is fixed.

## Validation and limits

Offline tests exercise the real Codex approval adapter, shared handler and SDK
hook, repository read classifier, notification lifecycle/store, delivery fallback,
HTTP and transport failures, privacy, expiry and restart behavior. Shared package
type checks, focused lint and the reviewed-source manifest are also checked.

These tests do not establish physical-device delivery, live GitHub execution,
model-backed reviewer behavior or production adoption. The user's reported
five-minute interruption pattern has not been correlated with private incident
logs; expiry/recreation and duplicate delivery are reproduced implementation
paths, not a claimed complete incident diagnosis. Review, CI, merge and explicit
production activation remain separate steps.
