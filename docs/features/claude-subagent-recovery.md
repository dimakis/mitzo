# Claude subagent outcomes and recovery

Verified against the pinned Claude Agent SDK 0.2.141 declarations and offline
application paths on 12 November 2026. The implementation started from accepted
main `f7a474ea9b113a4fdb40c169d3e879bf118d2d4c`. This document records source and
offline evidence; it makes no claim about a deployed runtime or a live SDK defect.

SDK `task_notification` distinguishes completed, failed and stopped. An assistant
envelope ends one model message, so it cannot establish task success. Foreground
Agent tool results and explicit task notifications determine child outcomes.
Query shutdown without an outcome leaves status unavailable. Duplicate and late
terminal events retain the first confirmed outcome and prior public output.

The existing inline `SubagentCard` shows Complete, Failed, Cancelled or Status
unavailable, using its existing disclosure, semantic status dots and shared motion.
No Codex inspection dialog or child control is added. Stop failures preserve the
parent interrupt, retain per-child uncertainty and expose a safe reference and
next action. Raw SDK summaries, output paths and rejection details are excluded
from public diagnostics; structured logs retain the cause and correlation.

Child feedback remains bound to its original message and tool across later parent
turns, including reused block IDs. An SDK event without a verified parent is
reported once and cannot become parent text, transcript access or control authority.
The pinned SDK supports background tasks and terminal notifications; this change
does not assert that a live resume/background correlation defect was reproduced.
Cross-query parent recovery is unavailable rather than inferred from unverified
events. Ordinary reconnect/replay uses the retained events of the original session.

Sources and validation:

- SDK `SDKTaskStartedMessage`, `SDKTaskNotificationMessage`, `Query.stopTask` and
  `Query.backgroundTasks` declarations in the committed lockfile's SDK version.
- `server/query-loop.ts`, `server/chat.ts`, `server/claude-child-diagnostics.ts`,
  `packages/client/src/slices/messages.ts` and `server/conversation-transcript.ts`.
- `tests/integration/claude-subagent-failures.test.tsx` exercises the real query
  adapter, wire parser, reducer, SQLite replay and inline UI, including failure
  before output, duplicates, late notifications, stop uncertainty, missing parents
  and background completion after a newer turn reuses the same block ID.
- `server/__tests__/send-to-chat.test.ts` covers asynchronous/synchronous stop
  failures and a replaced runtime; the child diagnostic test covers exact owner
  identity, replacement and cleanup. Existing SDK hook/permission tests remain.
- `tests/offline/claude-subagent-outcomes.spec.ts` adds intercepted browser cases
  for phone/desktop, light/dark, Mint/System and Teal/Georgia, keyboard disclosure,
  retained output, unavailable references and the unsent draft.

Local adapter/replay and design tests pass. Local browser startup was blocked by
macOS process-registration permissions after selecting the installed browser cache;
dependent UI cases did not run. Hosted browser checks and visual captures remain
required evidence. Broad builds and the complete suite belong to CI under the
repository's local resource limit. No deployment, staging or provider turn ran.
