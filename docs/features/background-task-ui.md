# Background task presentation recovery

Draft implementation, 21 November 2026. Ordinary contributor recovery of slice
`91669d3dc6549c74`; canonical ownership and earlier operations are unchanged.

## Preserved provenance

The original public task and investigation are in chat
`d3f3cac7-95df-8a17-8419-fb9e6e880a11` (initial task sequence 7192891).
That lane produced a proposal, with no implementation, tests, commits or PR
evidenced. [The original proposal](../design/background-task-ui/original-proposal.md)
is copied byte-for-byte, SHA-256
`f37f2d52f4c871d72d7af14fb1dcdb90c3721a76f433d2113e94fe5d858f56cd`.
Its original file and checkout remain untouched. Its historical preparation
instructions are evidence, superseded by the operator's explicit fresh-chat
continuation direction; no old preparation or pending launch was replayed.

This continuation starts at main
`9fa5d6fa6da8bfd0e54b8cb544b4f4329342bd76`, in its own ordinary task directory.
The initial implementation commit is `ac55f2844`; subsequent commits complete
the consumer, UI and qualification. No original implementation was discarded.

The current process contributor `e5f45379-0665-88fe-ab46-395e4d7229ff`
confirmed the narrow interface in public reply
`2557fbe2-367a-46ac-bf6a-b916612c21d3`: PR [1430](https://github.com/dimakis/mitzo/pull/1430)
at `d3af75ac97003e712ad3454318485c8fcbc48549` adds qualification tests and
`docs/design/claude-process-reuse.md`, with no exported process generation,
independent task Stop route or durable Stop receipt. No concurrent producer
implementation was reported. Its native qualification is reused as evidence,
not repeated or represented as production authorization.

## Implemented behavior

Verified SDK Agent task receipts now retain task/run identity and a bounded
description through the existing durable `subagent_*` pipeline. Child output may
precede the task announcement: the announcement adds metadata without replacing
that output or reopening terminal state. Native child message IDs can change
between turns; they are not interpreted as process authority. Consumers compare
task/run provenance inside the existing parent-message/block scope and use durable
sequence numbers for replay ordering, never opaque run-ID ordering.

The existing `SubagentCard` under `ToolPill` shows a Background task description,
Running, Completed, Failed, Cancelled or Status unavailable, retained output and
safe diagnostics. Output is inert text, limited to the latest 16,000 displayed
characters with a truncation notice and keyboard-scrollable area. Summary and
earlier output remain available together. Duplicate events cannot append output
twice; stale snapshots and cold hydration cannot reopen a terminal execution.

`stopReason: process_restart` is an additive **consumer contract** accepted only
with a cancelled terminal event. The current producer does not emit it. Retirement
still emits unavailable; it never fabricates a confirmed restart stop.

`BackgroundTaskStopController` is the separate, injectable task-only consumer.
It requires the exact conversation, process generation, native task/run, parent
tool and child projection binding. The view rejects missing/different generation,
conversation or run evidence. One frozen request ID survives row remounts;
duplicate clicks coalesce. Refusal, lost/malformed response and the 15-second
response deadline stay visible. Check Stop request reads that original receipt
without resubmitting. Receipt revisions are monotonic. Requested is not terminal
cancellation, admission is not provider acknowledgement, and this controller does
not alter task lifecycle state.

There is deliberately **no production adapter, endpoint or parent-Stop fallback**.
Current producer receipts omit generation, so the real UI shows a disabled Stop
control and explains its limitation. An eventual adapter must independently
authorize and revalidate at dispatch, persist requests/receipts, and recover after
reload. Merely importing the controller or possessing display IDs is not authority.

## Integration dependencies and remaining acceptance

- PR1430's pre-effect command-owner witness and independent design review remain
  unresolved. This change does not enable persistent ordinary process reuse.
- The actual producer currently reports verified Agent children, not a general
  background-Bash output feed. Bash integration, generation-bound durable
  lifecycle/Stop receipts, authenticated task-only Stop, reload recovery and
  authoritative restart termination evidence remain producer work.
- PR [1423](https://github.com/dimakis/mitzo/pull/1423), head
  `9571e05bf3801440d779a233e7db982e69cb27ca`, retains wakeup authority specification
  and tests. Age/push policy remains unresolved. Wakeups are not activated, and
  their admission/provider acknowledgement must stay separate from task outcome.
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` and existing parent Stop are unchanged.
  No dependency needs to merge before reviewing this main-based consumer draft;
  operational enablement depends on the qualified producers above.
- Telos receipt/stale-review repair remains with chat
  `1434c28a-f845-8a48-b475-e3140a7b12c8` and is outside this change.
- No merge, deployment, live provider call or iOS device validation occurred.
  Exact-current-head CI and Centaur final LGTM/merge recommendation remain later
  landing gates. This draft does not complete all original slice criteria.

## Validation and UI design

Test-first failures were observed for missing task metadata, foreign-run terminal
receipts, repeated output, stale running snapshots, cold hydration with additional
history, lost native summaries and the restart label. The real mocked-SDK/query-loop
adapter persists into `EventStore`, then exercises both the actual client parser/
reducer and cold transcript reconstruction. This is offline integrated consumer
evidence, not a live process-survival claim. Stop adapter fixtures are explicitly
consumer-only; they do not claim an independently authorized backend exists.

Final offline run: **292 passed, 1 existing skipped**, across 18 files with one
worker and a 1 GiB Node heap. This includes 183 focused tests and 109 design tests.
The selected suites are `conversation-transcript`, `sdk-task-run-consumer`,
`subagent-events`, `background-task-presentation`, client `subagent-reducer`,
`messages-slice`, `durable-transcript`, `background-task-replay`, frontend
`BackgroundTaskDetails`, `SubagentCard`, `background-task-stop`, and the existing
`frontend/src/styles/__tests__` directory.

`tsc -b packages/protocol packages/harness packages/client` passes. Focused strict
TypeScript checking of `SubagentCard.tsx` and its imported graph passes, as does
focused ESLint and `git diff --check`. No test assertions or approved design
references were weakened.

The UI reuses the existing task/tool transcript disclosure, `MotionPresence`,
`UiIcon`, `home-secondary` controls and semantic type/spacing/font/color tokens.
No second task feed, settings redesign, composer remount or palette is introduced.
The 40dvh output cap is structural viewport geometry. Controls use the shared
44px minimum and visible keyboard focus.

Six offline Playwright scenarios are registered in `background-tasks.spec.ts`:
phone WebKit, phone Chromium and desktop Chromium in light/dark, Teal/Georgia,
larger text, retained draft, inert/long output, all lifecycle labels, keyboard
disclosure, missing authority, lost response and original-request recovery after
remount. `--list` and fixture bundling succeed. **They did not execute:** the task
executor's initial isolated cache lacked browsers; selecting the already-installed
matching revisions then hit macOS process-registration denial during startup.
No further launch or sandbox bypass was attempted. Screenshots and visual
inspection are therefore unavailable; these remain CI/approved-host checks.

`npm run test:ui` first exposed a missing type export, which was fixed. A final
build/list attempt passed package compilation but frontend `tsc -b` exceeded the
repository-mandated 1 GiB heap. Full application build/browser acceptance remains
pending CI. Local logs are retained in the continuation workspace under
`implementation-evidence/background-ui/`; they are not substituted for passing
browser evidence or a physical iOS check.

PR1438 CI run `44945325215` at `4fb8db67178915738b72e9f38c2437156ae017d1`
passed server source type checking, frontend type checking and shared frontend
asset builds. Compile/source preflight failed because eight registered source
fingerprints had not been regenerated; dependent browser/test jobs were skipped.
The preparation fix retains every existing registration, regenerates those eight
fingerprints, registers the extracted task observation and Stop consumer modules,
and advances the runtime revision to `v1.0.1271-background-task-ui`.
`npm run check:source-artifacts` and all four source/compile-preflight regression
tests pass locally. Fresh CI and exact-head Centaur review remain required;
the earlier green job named `centaur` had no published final review report.
