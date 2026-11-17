# Claude SDK (Local Mac) live acceptance sweep after #1378 — 17 November 2026

Follow-up to the 16 November sweep (Telos artifact
`d5a0644de72a93fb092c3c483c5ff029`, slice `16143f0ea2b21a34`) and PR #1378
(`f986db0`), which targeted its failures. This sweep ran from an ordinary Claude SDK chat
(Personal Claude, Sonnet 5.5, Auto mode) whose workspace was a linked
repository task worktree, at accepted main `f986db0`.

Scope: live tool calls only. No deployment, merge or acceptance is claimed. The
running route's exact build was not read; the changed behaviour below (a set
`CLAUDE_CODE_TMPDIR`, working search) is only possible from #1378 code.

## Result: headline criteria pass; five gaps remain

| Area                                          | Live result                                                                                                                             | Status                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Write / Edit in own workspace                 | Create and edit succeeded in the linked-worktree workspace                                                                              | PASS (was FAIL)        |
| Native Bash                                   | Write, list and delete succeed; `TMPDIR` and `CLAUDE_CODE_TMPDIR` both point at the private scratch directory                           | PASS (was FAIL)        |
| Writes outside workspace                      | Rejected by the PreToolUse hook (other checkout, `/tmp`). The OS-level fence beneath the hook was not independently exercised           | PASS at hook level     |
| Native git in linked worktree                 | `git add` denied on the shared git directory, by design; commits go through TaskExecution                                               | PASS (documented path) |
| Native git in standalone clone                | Branch creation succeeds in a clone under `.repository-tasks`                                                                           | PASS                   |
| `dangerouslyDisableSandbox`                   | Explicit refusal naming the outer host boundary                                                                                         | PASS                   |
| Web search                                    | Returned a sourced answer (was "could not complete")                                                                                    | PASS (was FAIL)        |
| Web fetch (public HTTPS)                      | Returned page content                                                                                                                   | PASS                   |
| `ReadToolOutput`                              | Literal-query paging of a 12.8 KB retained output                                                                                       | PASS                   |
| Calendar `fields` + `singleEvents`            | Instances returned with `recurringEventId`                                                                                              | PASS                   |
| `HomeAssistantDashboard` list                 | Seven dashboards listed (was WebSocket failure)                                                                                         | PASS (was FAIL)        |
| `AgentCommunication` list                     | 50+ chats listed with delivery capability (was empty); all reported `unavailable`, so send/steer remained untestable                    | PARTIAL                |
| `TelosManageItem` read, `TelosGetItem`        | Read works; `TelosGetItem` refuses naming `TelosManageItem`                                                                             | PASS (by design)       |
| `ReadKnowledge` list                          | Library listing works                                                                                                                   | PASS                   |
| `ReadKnowledge` published                     | `published_host_store_unavailable`: operator enrolment of the Local Mac store required                                                  | OPEN (operator)        |
| `SymposiumReadProfiles`, `AgentReadTasks`     | Profiles listed; task list empty                                                                                                        | PASS                   |
| `SymposiumConsult` catalog / revoke           | Catalog works; revoke works                                                                                                             | PASS                   |
| `SymposiumConsult` authorize                  | Succeeds on an account with the repository connection; fails with opaque `specialist_tool_failed` on this chat's own account            | GAP (message)          |
| `SchedulePrompt` / `SessionTimers`            | Create and cancel                                                                                                                       | PASS                   |
| `CaptureMemoryCandidate`                      | Sources listed; capture stored (`provisional`)                                                                                          | PASS                   |
| `AgentProposeTask`, `StartSession`            | Proposals created, awaiting review                                                                                                      | PASS                   |
| `TaskExecution` authorize / run / github_read | All succeed; `gh` inside `run` is unauthenticated while native `gh` is authenticated. Grant carries one writable root for two-repo asks | PASS / note            |
| `DiscoverLocalRepository`                     | `internal_failure`, `reason: unknown`, diagnostic `cb9c222e-cd85-4f39-85c6-fda64332888f`                                                | FAIL                   |
| `InspectLocalRepository`                      | `internal_failure`, `reason: unknown`, diagnostic `19c82c9d-d503-4074-ab56-67aa3ba208a9`                                                | FAIL                   |

## Gaps and next actions

1. **Repository discovery and inspection still fail opaquely.** #1378 retains
   the cause chain in server logs only (`tool-failure-reporting.ts`
   `causeChain`); the model-visible diagnostic still reads `reason: unknown`.
   `captureLocalRepositoryReader` has several `throw unavailable()` sites with
   no cause (non-darwin, missing `/` read root, deadline, denied scratch), so
   the failing stage cannot be told from the result. The two diagnostic IDs
   above identify the log lines; this sweep could not query the host logs.
   Next: add a stable, code-owned `reason` per throw site to the model-visible
   diagnostic, then re-run.
2. **Published knowledge needs host enrolment.** Operator action, unchanged.
3. **Managed GitHub publish is not assigned to this account.** The Symposium
   catalog lists the `dimakis/mitzo` connection for three other accounts. The
   authorize failure in the table is consistent with this but is not proven:
   the message should name the missing connection.
4. **`TaskExecution` `commit` misroutes files in a nested clone.** Given an
   absolute path to a file inside a clone under `.repository-tasks/`, it
   committed that file to the parent workspace repository's branch instead of
   the clone (the 16 November sweep saw a refusal here, not a misroute). The
   commit was local and unpublished, and was reset by the operator chat. Next:
   resolve the target repository from the file's own repository root, or
   refuse nested clones explicitly; add a regression with a nested clone.
5. **Steering and peer send remain unproven.** Every listed peer chat was
   `unavailable` and self-send is refused by design, so mid-turn steering from
   a user or peer needs a second live participant.

## Not exercised

- A live `SymposiumConsult` consult (model call; repository policy requires an
  approved Luna model and a stated charged account).
- `SaveKnowledgeDraft` and `SymposiumProposeProfile` (leave Library drafts or
  review cards; both passed in the 16 November write sweep).
- Home Assistant `save` and Google Drive/Docs/Sheets reads.
- The OS-level outside-workspace write fence beneath the hook, and any
  deployed-build identity check.
- Browser/device behaviour (Enter-to-steer setting from #1378).

## Environment

The host provides npm 11.6.0; the repository requires `>=11.18` under
engine-strict, so a plain `npm install` still fails here. Node 24.10.0.
