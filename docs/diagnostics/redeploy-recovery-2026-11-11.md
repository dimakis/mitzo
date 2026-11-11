# Redeploy, startup and outgoing-message recovery audit

## Incident evidence and limits

The report followed a Mac server redeploy to `0ef2461e6cc6`. The phone showed
“Something went wrong”, a disabled Retry, idle historical activity, and an
unsent draft. New sessions also failed. Production logs were inspected read-only:
the deployed process accepted SSE reconnects around the reported time. The
“suspend: session not found” warnings were background lifecycle hints for an
ended, persisted conversation, not evidence of a failed command admission.

The two chat pages map the outbox's `blocked` state to that generic message and
explicitly disable Retry. The outbox enters this state when saved intent cannot
be read or validated. The original phone-side exception is unavailable; neither
the screenshot nor server logs proves a specific IndexedDB failure or corruption.
Do not claim the original incident resolved without checking the updated phone.

Capacitor ships its own frontend assets (`frontend/capacitor.config.ts`, with no
remote `server.url`). Redeploying the Mac server does not update that bundle.

## State and transition review

| State/boundary                                         | Behavior and recovery                                                                                   | Evidence/action                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Database opening                                       | Must settle before app initialization; a failed attempt must permit another open                        | Fixed missing 15-second open deadline, synchronous-failure cache invalidation and ownership of late successful opens     |
| Database read stalls after opening                     | Read-only hydration must settle and release its cached attempt; late results cannot overwrite a retry   | Added shared 15-second read deadline for index and legacy payload reads, best-effort abort and late completion fence     |
| Database connection closed/version changed             | A closed handle cannot remain the shared connection                                                     | Fixed cache retirement; close a superseded version before reopening                                                      |
| Saved queue unreadable (`blocked`)                     | Keep original bytes; local Retry rehydrates and validates before any command can be sent                | Fixed disabled mobile/desktop Retry, missing async hydration hook and offline store gate                                 |
| Invalid persisted command                              | No replacement command, clearing or automatic resend                                                    | Preserved fail-closed behavior; fixed sign-out persisting an empty in-memory queue over unreadable storage               |
| No selected pending command (`idle`)                   | New explicit send may proceed after normal settings/auth/connection checks                              | Recovery clears its own storage error; store test proves recovery then one explicit new send                             |
| Storage recovery in progress                           | Coalesce clicks, bound the attempt, ignore late completion after sign-out/stop                          | Added ownership fence, timeout/failure tests; recovery does not dispatch                                                 |
| Disconnected/reconnecting                              | Reconnect restores transport and observes receipts; it is not permission to replay uncertain work       | Existing SSE/auth/replay regressions pass; local storage retry needs no connection                                       |
| Enqueued/submitting (`pending`)                        | Durable frozen request before I/O; one active submission; bounded storage and receipt waits             | Existing real outbox tests cover persistence failure, stalled flush, body timeout and late completion                    |
| Reserved/uncertain/retained                            | Keep exact identity and draft; read exact receipt on reconnect; explicit retry retains original command | Existing outbox tests cover Local/OpenShell, first/continuation, wrong-session receipts and finite retained observations |
| Consumed receipt                                       | Clear only the submitted draft revision after durable receipt/handoff; never erase newer edits          | Existing outbox/store/real composer tests cover lost acknowledgment, storage/handoff failure and later edits             |
| Authentication changes                                 | Retire request ownership, retain uncertain intent, block stale completion                               | Existing auth tests plus new delayed-storage-recovery and unreadable-byte preservation tests                             |
| Server restarted/no in-memory session                  | Historical activity is not current execution; reconnect must not start a provider turn by itself        | Read-only server evidence and existing startup replay tests; no production/model test performed                          |
| View/session changes                                   | Pending commands remain owned by their draft/session; a global unreadable queue must remain visible     | Existing independent-draft tests plus global blocked-state projection fix                                                |
| Device storage remains inaccessible or data is invalid | Remain blocked with preserved bytes and honest storage feedback                                         | Intentional limit: this patch does not erase storage or guess replacement authority                                      |

## Validation and cost

- Red: six failures reproduced the disabled UI retry, blocked outbox retry and
  closed database handle. Separate store and stalled-open tests also failed before
  implementation.
- Focused outbox/store/storage/page pass: 273 tests, 16.21 s total; 12.72 s test
  execution. Follow-up transport/auth/startup/design pass: 321 passed, one existing
  CI-base-only design check skipped, 12.32 s total; 8.05 s test execution. These
  selections overlap and must not be added as unique coverage.
- Local review identified a separate stalled transaction after a successful open.
  Two parameterized consumer regressions failed before the fix; the final shared
  read helper and existing storage fixtures passed 55 tests in 1.72 s total,
  0.951 s test execution. Read-only recovery leaves write/CAS behavior unchanged.
- Workspace package typecheck, frontend typecheck/build, touched-source lint and
  reviewed-source fingerprint check passed.
- Reused the existing short-viewport reviewed-launch browser journey for the
  storage status/retry presentation. Mobile WebKit and desktop Chromium plus their
  startup checks passed in 11.7 s (journeys 3.9 s / 3.4 s). No additional full-app
  journey was added. The browser state injection is visual coverage; functional
  retry is covered through the real outbox, persistence adapter and store.
- Inspected mobile dark and desktop light screenshots; both themes were captured
  with the existing Teal/Georgia setting, retained shared dialog/status row and
  44px Retry target. No layout, palette or motion redesign.
- Used one worker, a command-local 2 GiB Node heap, warning memory pressure with
  stable swap. No live model calls, staging operations or production mutation.
- Local elapsed times exclude CI queue time. Baseline runtime delta and CI cost
  are not yet measured; fixtures were extended instead of adding expensive
  provider, native, database-process or browser journeys.

## Remaining verification

CI and required review must validate the published candidate. Prepare the iOS
bundle/archive from that candidate and verify the installed phone build separately.
Persistent corruption needs the actual device diagnostic and a preservation-first
recovery decision; clearing app data is not an acceptable default workaround.
