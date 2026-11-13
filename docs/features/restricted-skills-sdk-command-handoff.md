# Restricted skills: SDK command ceiling handoff

13 November 2026. Slice `93d58df4-9ded-46ce-8a70-a4bd4f0c9cff` under parity
feature `8e186fdf-9058-4ad6-af18-8fd6797bf935`. This is a local integration
candidate. Restricted prompt admission and catalogue support remain unavailable.
The existing [restriction contract](restricted-skills.md) remains authoritative.

Published candidate: draft PR [#1343](https://github.com/dimakis/mitzo/pull/1343),
head `b9e2adaba6288b4de69f02259b33c72181757cd0`, base `main`. The follow-up
commits below are retained only on `feat/restricted-skills-enforcement` in
`/Users/dsaridak/.local/share/mitzo/ordinary-tasks/ordinary-66957392-76e6-4906-816b-d8772ab88245`.
They have not been pushed. Integration ownership must select their destination
in the feature PR before publication or hosted CI.

## Existing-owner contract

The existing `ordinary/send` ledger and `ordinary_skill_context` event retain
an optional exact-name `allowedTools` array. Omission means no added ceiling;
an empty array denies every tool. Admission clones and validates the record
before invoking admission callbacks, compares the entire retained context on
retries, and commits through the existing transaction. Recovery validates the
retained record instead of resolving current skill files again.

The existing FIFO `OrdinaryLocalVertexCommandOwner` captures that context for
the original execution generation. It binds one `OrdinarySdkCommandToolAuthority`
to the corresponding native SDK query before releasing stdin. Restricted commands
refuse a query without this binding interface. Every `checkTool(name)` checks
the original runtime, active command, execution generation, execution phase and
unchanged durable context. It then uses the shared harness `checkSkillTool`
semantics. There is no additional command queue or permission registry.

`SdkCallbackState` retains this authority once per native query. PreToolUse and
canUseTool check it before and after awaited existing hooks/permission owners.
Completed queries and callbacks cannot borrow a FIFO successor's authority.
Authorized peer steering retains the current query's ceiling. These checks add
a restriction; they grant no mode, profile, workspace, native-shell or task
authority. Existing approval and revocation owners remain authoritative.

## Remaining integration dependencies

1. Managed SDK named-tool handlers must call the original callback state's
   `checkTool(actualWireName)` before dispatch, including special TaskExecution
   handlers. `mcpServers(state)` now receives the full callback state for this
   purpose. Retain existing effect, account, profile, cancellation and current
   runtime checks; discovery/dispatch wrapper names must not authorize arbitrary
   targets. This slice did not edit `credential-sdk-tools.ts`, catalog policy or
   shared `chat.ts` while their integration owner is changing those files.
2. Trusted ordinary SDK admission must resolve and atomically freeze the effective
   `allowedTools` in the existing context record before restricted execution can
   be enabled. Include explicit plain/unrestricted transitions, initial startup,
   FIFO continuation and cold recovery. Retries must reuse the complete retained
   context; the replay repair here preserves a previously retained ceiling.
3. Qualify the joined admission-to-managed-dispatch route before enabling its
   catalogue entry. Add real managed-handler allowed/denied/revoked cases and
   joined startup/recovery checks. Existing unsupported admission stays in place
   until then. Native Codex requires its own enforceable owner contract and
   remains unsupported for restricted prompt execution.

## Commits and offline evidence

| Commit      | Increment                                                                |
| ----------- | ------------------------------------------------------------------------ |
| `98c0b9217` | Immutable context in the existing ledger; strict validation and recovery |
| `0e8e80d20` | Original FIFO command and execution authority                            |
| `07f45c255` | SDK hook/permission enforcement and query binding                        |
| `15a926c21` | Preserve the whole frozen context during composer retries                |
| `8b97c9217` | Authorized peer input retains the active command ceiling                 |

95 focused tests pass across seven suites: ordinary composer skills (13), command
owner (20), command skill boundary (4), SDK query (25), SDK turn query (11), shared
skill policy (14), and owned runtime (8). The existing owned-runtime tests cover
first admission, continuations and cold dispatch; public restricted admission
remains refused. New boundary cases use the actual EventStore, FIFO owner, SDK
query factory and permission hooks with a fake provider. They prove allowed and
denied callbacks, queued-ceiling separation, retirement, pending-hook revocation,
stdin identity refusal, peer inheritance, replay and retained deny-all recovery.
The exposed managed-name seam is tested; actual named-handler integration remains
the dependency above.

Protocol/harness TypeScript builds, touched-file lint/format checks and the source
artifact preflight pass. Connections source revision is
`v1.0.1128-sdk-command-skill-ceiling`. The server-wide build, hosted combined-result
CI, trusted review and provider/live acceptance remain separate validation. No
model call, deployment or merge was performed.
