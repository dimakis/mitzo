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

## One alert per distinct approval

The notification center owns approval delivery. It prefers native push when
configured with devices, then Pushover or ntfy as a fallback. The shared runtime
handler no longer sends an independent second alert while that owner is active.
Standalone harness consumers retain their original notification route.

Approval preferences, quiet hours and preview privacy apply to every central
route. Legacy fallback alerts open Mitzo for review; they do not offer blind
approval of redacted or truncated details. HTTP failure is recorded as failure,
with bounded retries, rather than successful delivery. Partial native delivery
retries exclude devices that already accepted the alert and do not switch channels.

Every distinct approval is eligible for its own alert, including concurrent
decisions in one chat and a new request after expiry. An earlier unread alert
cannot suppress another decision. The previous chat-wide, 24-hour suppression
included expired alerts and could leave later approvals unannounced for hours.

Deduplication uses the durable notification/request ID and accepted-device
receipts. Repeated ingestion, delivery sweeps and restarts do not replay an
accepted request; a partial delivery retries only its remaining devices.
Historical expired notices remain in the feed without blocking new alerts,
including in existing databases. Delivery never grants or resolves permission.
Expiry still tells the agent to wait for the user instead of automatically
recreating the unchanged request.

This policy lives in the shared notification store and center. Claude and Vertex
SDK sessions, Responses sessions and controller tools use the common permission
handler; Local Mac and OpenShell Codex native approvals reach it through the
native approval adapter. The central policy also covers seat access notices and
both native and legacy delivery routes; it requires no runtime-specific switch.

Queue, resolution and delivery diagnostics carry notification, permission and
session correlation where available, stable stage/result codes, delivery channel
and accepted-device counts. They exclude request bodies and device tokens.
Transport exceptions retain their cause internally, record a bounded retry and
allow the rest of the delivery batch to proceed.

Offline regressions verified on 12 November 2026 reproduce the expired unread
alert through the common handler and both native engine contexts. They also
cover persisted databases, concurrent decisions, same-request deduplication,
partial delivery and transport failure recovery. These tests use synthetic
transports and do not establish delivery on a real iPhone or Watch.

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
their separate reviewed mutation contracts. Notification deduplication does not
remove these authorization requests or establish that the whole workflow is fixed.

## Security finding: task grants are not native execution grants

Source inspection and focused security review on 11 November 2026 rejected a
transparent conversion of task consent into native consent. The evidence is in
[task operation dispatch](../../server/task-execution-operation.ts),
[the sandbox runner](../../server/sandboxed-command.ts),
[native policy composition](../../server/owned-local-codex-native-policy.ts),
[native development consent](../../server/native-development-grant.ts) and
[the native approval adapter](../../server/codex-native-approvals.ts).

Task execution uses isolated HOME/scratch, protects Git metadata and excludes
host credentials. Its network scope distinguishes none, loopback and internet;
grant expiry and revocation abort the running operation. Native Codex has a
different filesystem policy, can read the host GitHub CLI credential store and
uses a Boolean network overlay. `captureNativeDevelopmentGrant` returns a
synchronous consent fence, not equivalent cancellation of an already running
native item. Therefore a grant ID or `executionRoute` cannot authorize that wider
native environment.

The current command-approval RPC supplies an approval decision, with no supported
replacement-command or replacement-result channel. Executing TaskExecution from
that callback and then accepting would risk executing the command twice;
executing and then declining would conceal an effect behind a refusal. Neither
is an acceptable delegation bridge. Routing guidance must remain partial
delivery until the execution adapter itself supports the required contract.

The concrete next platform action is to establish either provider-supported
pre-execution delegation with result delivery, or enforced native policy narrowed
to the consumed task scope together with exact-running-item cancellation. Keep
this requirement in the existing approval work; it is separate from the ordinary
session steering implementation and does not create another merge owner.

Completion requires all of the following evidence:

1. The intended Codex, Claude and Vertex worker discovers and consumes only its
   current operator/account/workspace grant. Command variations and different CI
   job IDs reuse it with no extra approval inside scope; an unselected worker,
   changed custody/root/account, Ask mode or broader operation cannot inherit it.
2. Exactly one executor starts each operation. Original request IDs survive
   interruption, reconnect and result delivery. Unknown outcomes stay inspectable
   and are reconciled before any retry; acceptance is never reported as execution.
3. Expiry, parent revocation, cancellation and ownership loss stop the exact
   running operation and prevent later delivery/effects under stale authority.
   Test the actual provider adapter and consumer, including process termination,
   not only a consent callback or generated guidance.
4. Bounded CI-log inspection and collection into selected workspace files retain
   the same repository scope, output limits and safe path handling. Filter/page
   changes do not create approval churn. Credential-free requests never silently
   become authenticated, and arbitrary shell pipelines do not inherit GitHub
   consent. Live qualification uses an explicitly selected authorized target;
   merge and production activation remain separate.

## Adapter and consumer evidence

[The composed log-consumer tests](../../server/__tests__/task-execution-log-consumer.test.ts)
exercise the real task tool, grant store, permission handler, native executor and
trusted log transport together. Only the external GitHub process is substituted.
Five cases verify selected-worker discovery, ordinary and SDK-prefixed routes,
different job IDs/literal filters, one initial approval, completed-request replay
without refetch, unselected-worker refusal, and in-flight expiry/revocation with
an explicit unknown outcome and retained uncertain receipt. Provider labels cover
Codex, Claude and Vertex account bindings; these are offline fixtures, not live
provider qualification or proof of real process termination.

[Task-tool tests](../../server/__tests__/task-execution-tools.test.ts) additionally
cover inherited development consent, routine command variations, detached retained
workers and separately revoked parent authority. Their executor is substituted;
[native executor tests](../../server/__tests__/native-tool-executor.test.ts) cover
the next boundary, including exact task input and the final spawn recheck. These
layers do not establish transparent delegation from a provider's native tool.

A real host TaskExecution grant was reused on 11 November 2026 to read CI job
`130723279548`, save the returned log inside its selected checkout, and run
different local filter commands without another approval. The saved response was
16,847 bytes including the added final newline (SHA-256
`57e94abd59c9c73760730ddcef629a616d9e83d4d713d7c6bc64d4c543a7afbc`);
literal `[command]` filtering saved 37 matching lines, and absent filters saved
empty files. The read and writes used distinct retained request IDs under the
same existing grant. Raw logs remain untracked local test results.

This verifies an agent-mediated read → save → filter sequence in the current
session. It does not establish a direct authenticated download-to-file operation,
large-log transfer without model-mediated content, or another live worker's
authority. The running release lacks this PR's `log` field, so the live read used
the existing bounded raw response; new paging is verified offline. Qualification
of the accepted implementation across actual worker runtimes remains outstanding.

## Validation and limits

Offline tests exercise the real Codex approval adapter, shared handler and SDK
hook, repository read classifier, notification lifecycle/store, delivery fallback,
HTTP and transport failures, privacy, expiry and restart behavior. Shared package
type checks, focused lint and the reviewed-source manifest are also checked.

Offline tests do not establish physical-device delivery, model-backed reviewer
behavior or production adoption. The scoped live read above does not qualify the
new paging implementation. The user's reported
five-minute interruption pattern has not been correlated with private incident
logs; expiry/recreation and duplicate delivery are reproduced implementation
paths, not a claimed complete incident diagnosis. Review, CI, merge and explicit
production activation remain separate steps.
