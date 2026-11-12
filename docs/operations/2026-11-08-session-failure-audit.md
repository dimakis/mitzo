# 8 November 2026 session failure audit

## Scope and evidence

This audit started from PR #1264 and the conversation showing the generic
"Saved work could not reconnect" error after a native subagent spawn. The running
release was `8c5512eaabe1`; it did not contain #1264. This branch includes that
work and its task-consent review fix, integrated with main `878317bd3`.

Read-only inspection covered the retained conversation database, session events,
native history, release logs and local traces. At the audit snapshot, 18 visible
sessions had activity on 8 November: 16 retained recovery, one had already
recovered from an earlier policy failure, and one had no incident failure. The
older database contains additional historical recovery flags; these are not
evidence that all historical sessions failed in this incident.

No service was restarted, no provider turn was submitted, and no production
record, credential, worktree or queue was modified. The pinned 0.160.0 executable
was used only to generate protocol schemas with empty temporary homes, without
login or model calls. The new generated-schema evidence is recorded separately.

## Session accounting

IDs below are unique prefixes of the original application session IDs. Policy
failures are confirmed by the original `execution_policy` or `native_policy`
log entry. The exact differing policy field was not logged by the old release;
the equivalent-denied-root drift mechanism is reproduced by #1264's offline
regressions, not retrospectively asserted from a generic connection error.

| Session    | Original stopping event                                  | Fix or disposition                                                                                                                                                |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `490201e1` | Native approval execution-policy check                   | Policy equivalence and specific policy diagnostics; task/read outcome fixes                                                                                       |
| `9f419f88` | Native approval execution-policy check                   | Same; genuine repository-operation uncertainty remains protected                                                                                                  |
| `60ccd1a0` | Native approval execution-policy check                   | Same; preserve settled task failures                                                                                                                              |
| `694de895` | Native approval execution-policy check                   | Policy equivalence and specific policy diagnostics                                                                                                                |
| `b37e4d35` | Native approval execution-policy check                   | Same; task/read outcome fixes and long-turn inspection                                                                                                            |
| `21513d68` | Native approval execution-policy check on 7 November     | Same; original historical receipts are retained                                                                                                                   |
| `43af5a14` | Native approval execution-policy check on 7 November     | Same; long history includes child activity and compaction                                                                                                         |
| `6fb91815` | Native approval execution-policy check on 7 November     | Same; long history includes child activity and compaction                                                                                                         |
| `2aa7e1a0` | Native approval execution-policy check                   | Same; task/read outcome fixes                                                                                                                                     |
| `3ce50028` | Native approval execution-policy check                   | Same; includes the task-wide inherited-consent revocation regression                                                                                              |
| `6bf3ac57` | Native-policy refusal before provider submission         | Policy equivalence; undispatched-input recovery remains distinct from accepted-turn recovery                                                                      |
| `7cbb66e4` | Native-policy refusal before provider submission         | Same                                                                                                                                                              |
| `80e48226` | Child tool request after unrecognized `subAgentActivity` | Admit only identity-verified native children; preserve parent transport and child routing                                                                         |
| `b823b597` | Older disconnect following native child activity         | Same missing activity contract is present; the old transport log did not retain its inner exception                                                               |
| `235a6f60` | Native command approval expired after about 120 seconds  | Expected refusal: do not extend the approval or run the command. Prevent prior settled tool failures from creating false uncertainty; retain the interrupted turn |
| `f806c366` | Explicit WebSocket Stop on 7 November                    | Respect Stop. Retain work; bounded recovery understands compaction, but cannot infer child/tool settlement                                                        |
| `a9a423e4` | Earlier native-policy refusal; later commands completed  | Same policy fix; already recovered at audit time, so not counted among the 16 blocked/interrupted sessions                                                        |

## Additional defects fixed

- TaskExecution discarded the original executor's settlement evidence when
  projecting a result and replaying a completed request. Normal failed tests
  could therefore appear to have unknown effects. Preserve the evidence through
  both paths; do not reexecute a completed request.
- Task-wide inherited consent must include every original parent grant. Revoking
  the owner must cancel a worker's active operation and refuse future operations.
- The installed runtime emits `subAgentActivity`, while child admission only
  recognized the older collaboration event. Activity is now a discovery hint;
  native parentage, session, workspace, model and current ownership still qualify
  the child before routing any tool request. Generated-schema qualification now
  includes this event contract.
- A completed HTTP refusal or normal GitHub CLI read failure can carry positive
  settlement evidence. Cancellation, timeout, unclassified errors and writes do
  not gain that evidence. The native adapter preserves it.
- AgentCommunication refusals before any reservation or reconciliation are known
  not to have delivered a message. Once either begins, uncertainty is retained.
- Recovery swallowed every exception at the HTTP route. It now retains reviewed
  diagnostics and returns the same reference to the authorized operator. Raw
  upstream text is not returned. History read failures, inspection limits and
  unsupported effects have distinct reasons.
- `contextCompaction` is an observational history entry, not an unknown mutation.
  Retained incident turns reach 836 items. Inspection now permits up to 1,024
  one-item RPC frames and 16 MiB total; current authority is checked before every
  additional read. Identity, cursor, completeness and final-terminal checks remain.
- A stopped chat with a warning/error now says "Needs attention before
  continuing" instead of claiming readiness. Shared status/dialog layout and
  approved-design references are preserved.

## Recovery and rollout limits

This source change does **not** establish that every existing paused turn is safe
to resume. Some old receipts explicitly say unknown, some have no original
completion-phase receipt, and some contain untracked child effects. A later
terminal parent turn or the text of a failed command is not sufficient evidence
to clear those fences. Historical work must be reconciled through its original
owning workflow and exact retained receipts; this PR performs no database repair
or replay. Unsupported child effects now receive a specific recovery diagnostic.

The raised history bound allows longer qualified turns, but does not bypass
receipt qualification. Worst-case item RPC count rises from 128 to 1,024 while
individual frames remain bounded and aggregate bytes gain an explicit 16 MiB cap.
Live latency for an 836-item recovery has not been measured: no live recovery or
model target was authorized. Staging remains stood down. Production activation
and subsequent recovery are separate explicit operator actions after review/CI.

## Validation approach

Regressions first failed at the relevant layer, then passed. Existing task-tool,
native conversation, child admission, read adapter, messaging and HTTP fixtures
were extended. The 836-item case and byte-limit case use synthetic in-memory
RPC responses; they add no provider, browser, database or subprocess journey.
The public/authenticated read tests use the existing mocked transport/process
seams. Existing messaging integration coverage retains real custody and SQLite
with synthetic native RPC, including uncertain delivery and cancellation.

Focused local runs use one worker and a 1 GiB Node heap because macOS pressure
remained warning (48 GiB physical RAM, about 6.4 GiB file-backed, about 0.1 GiB
free; swap allocation decreased slightly during the audit). The full build,
combined-result type checks and browser suite remain CI gates. The existing
offline composer fixture gains readiness assertions; its mobile/desktop,
light/dark captures remain the rendered validation path. No protected design
tests or reference hashes were changed. Exact final-head check results belong
in the PR validation record, not inferred from earlier runs.
