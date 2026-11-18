# Chat status and Claude tool failure investigation

Investigated 17 November 2026 against accepted source and the running release
`9f1a3e707f1a6fe22a374cf7db725a372e068eaa`. This is implementation evidence,
not production activation or device acceptance. No live model calls were made.

## Confirmed observations and limits

The reported runtime error corresponds to `ordinary_sdk_result_unavailable` at
`provider_terminal`. `OrdinaryLocalVertexCommandOwner.resultObserved` refused the
completion with `Original SDK result identity unavailable`. The saved user message
survived. Message persistence alone does not establish steering acceptance or
execution of the requested work.

Earlier `AgentCommunication` and `TaskExecution` failures were both recorded as
`internal_failure`, with only a generic `Error` cause. Those original diagnostics
cannot distinguish a missing command, a retired query or another generic exception.
The adapter defect below is reproduced; it is not proof of the exact exception in
those older calls.

## Paths followed

Both tools enter `createCredentialSdkServer` in
`server/credential-sdk-tools.ts`. The handler first checks the original query's
command/skill ceiling, then revalidates runtime authority before operation and
delivery. The query's `SdkCallbackState.checkTool` and the FIFO owner's
`#toolAuthority` can throw when their original query or command is no longer current.

| Tool                 | Operation path after the common adapter checks                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentCommunication` | `executeAgentCommunicationTool` → `sessionAgentCommunicationTools.execute` → signed sender, operator transport, runtime, selection and policy checks → requested inventory, receipt or delivery operation        |
| `TaskExecution`      | `sessionCredentialTools.execute` → `sessionPromptTools.execute` → `sessionTaskExecutionTools.execute` → runtime, operator, selection and policy checks → grant/store checks → `executeTaskOperation` for effects |

The common command check was outside the runtime-authority wrapper. Its exception
therefore reached the generic tool-failure handler as an ordinary application error.
The model received `internal_failure` and could keep calling tools on that stale
query. Neither tool's own operation handler needed to run for this to happen.

The fix wraps a throwing command check as the existing terminal runtime-authority
failure. Expected skill denials retain their separate behavior. Static annotations
identify `sdk.command_tool` or `sdk.runtime_authority`; the shared diagnostic logger
now retains these safe check names without serializing raw messages or stacks.
Original causes, cancellation, revocation and uncertain-effect rules are preserved.
Regression tests cover both registered SDK tool handlers, prove no inner dispatch
after refusal, and verify that a fresh independently validated query remains usable.

The terminal completion error follows a separate path:
`query-loop.ts` input/result correlation → `chat.ts` `onResult` →
`OrdinaryLocalVertexCommandOwner.resultObserved` → retained runtime failure.
This change does not guess a missing input identity or bypass that fence.

## Related steering work

[PR #1389](https://github.com/dimakis/mitzo/pull/1389), inspected at head
`b1fa98b9799306719ea8d363903542aa1da79dc4` on 17 November, already investigates
the same affected chat. Its report attributes a turn-ending trigger to Claude's
handling of `priority: now` corrections and records native transcript evidence.
Local source independently confirms that user steering sends `priority: now`
and that the owned query retires its callbacks after a terminal result. The
original native transcript was not read in this investigation.

That PR owns correction priority, late-steer handling and terminal unconfirmed
receipt recovery. Those changes are not duplicated here. Its reported trigger
and the reproduced adapter error-handling defect are related but distinct evidence.

## Status refresh

`ComposerStatusRail` previously used activity labels only while activity was
`working`. If the overview reported completion before the message stream cleared
its `running` flag, the label reverted to `Working`, with an active animation and
elapsed timer. Switching to a chat already known to be idle had the same fallback.

The shared status row now uses the selected chat's reported state, clears live
animation/timing for terminal, idle and waiting states, and updates its details
consistently. A newly observed start ignores the preceding turn's unchanged cached
observation until fresh activity arrives. Repeating that old observation in an
unrelated global broadcast cannot renew it. Delivery warnings and errors retain
their existing priority and controls. No palette, layout, approval reference or
motion pattern changed.

## Verification

- Test-first failures reproduced both SDK command-fence errors and the stale
  status on completion, selection and a new turn starting against an old cache.
- 141 backend tests passed across the SDK adapter/reporting, task execution,
  ordinary Claude task execution, runtime authority and cross-runtime messaging
  suites; four pre-existing cases were skipped.
- 122 frontend/status/design tests passed; one pre-existing case was skipped.
- The 19 Connections template/registry tests passed with the revised runtime
  fingerprint contract.
- Focused ESLint and formatting checks passed. Reviewed source fingerprints were
  updated only for changed sources; the source-artifact check passed. The approved
  design references and protected regression files remain unchanged.
- Shared package TypeScript builds passed. Full server and frontend typechecks
  exhausted the repository-required 1 GiB Node heap; they are not claimed green.
- The additional offline browser specification lists six phone/desktop,
  light/dark cases. The host-execution attempt stopped at the repository's macOS
  sandbox guard before any browser launched. No rendered or device verification
  is claimed; run `npm run test:ui -- tests/offline/chat-status-freshness.spec.ts`
  in a supported runner or CI.

These are local source changes. Review, CI, source acceptance, runtime activation
and user acceptance remain separate evidence.
