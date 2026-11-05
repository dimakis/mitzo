# Session timers and callbacks

Session timers send a saved prompt into an existing ordinary Mitzo conversation
every chosen number of minutes. For example: “Check PR #7 for new reviews” every
10 minutes. The prompt executes with the recipient's existing account, runtime,
workspace, agent, model and permission mode through the ordinary command owner.
Mitzo must be running for checks to execute; the browser can be closed.

## User controls

- **Chats → … → Timers** lists human and agent timers together. Inspect the
  prompt, session, interval, next check, origin and prompts sent. Pause, resume,
  edit, run now or cancel from details. Cancelled timers remain visible.
- On mobile, **composer … → Schedule prompt** opens the form with a copy of the
  draft. On desktop the same clock appears in the existing inline toolbar.
  Creating or closing a timer preserves the draft and never sends it immediately
  through the composer.
- Choose minutes or hours, the first check (after one interval or immediately),
  and either a total prompt limit or cancellation. Each check can use paid tokens.
- A busy recipient keeps one pending check. Missed intervals coalesce; there is
  no catch-up burst after downtime. The next interval starts at prompt admission.
- Pause/cancel prevents future admission. A prompt already accepted belongs to
  the normal session queue and its existing stop/cancel controls. “Prompts sent”
  counts accepted prompts, not task completion or successful PR merges.

Placement approval, 5 November 2026: “the timers should be in here” (Chats
overflow) and “the clock should be in the options” (mobile composer overflow).
“On webapp it can stay in along the bottom where we have more screen real estate.
Change no other icon or functionality.” Existing status, settings, send, attach,
commands, terminal, resources, microphone and isolation controls are preserved.

## Agent tools and callback workflow

The selectable **Session automation** tools use the same scheduler and records:

1. `SessionTimers` with `operation: "sessions"` discovers eligible conversation
   IDs and titles. It does not read transcripts.
2. `SendSessionMessage` sends an attributed prompt to another session with a
   stable UUID `requestId`, recipient `sessionId`, `text`, and optional `workId`.
   A coordinator can say “Handle PR #7; when finished message session S back,
   retaining workId PR7.” The worker uses the same tool for the callback.
3. `SchedulePrompt` creates a recurring check. Omit `sessionId` for the calling
   session. `SessionTimers` lists/reads/changes timers and observes callback
   delivery with `operation: "delivery"` and the returned `deliveryId`.

The sender's identity comes from the current runtime, never tool input. Messages
are labelled as agent messages with their session/task reference and explicitly
grant no extra authority. Agent/Auto retain normal tool selection, skill policy
and approval handling. Ask cannot create timers or send peer messages. Humans
can inspect and cancel all agent timers through the same UI. This feature does
not auto-merge PRs or change any merge gate.

## API and persistence

The authenticated `/api/session-timers` collection supports GET and POST;
`/sessions` lists eligible recipients; POST `/:id` changes a timer with a fresh
`expectedRevision` and UUID `requestId`. Changes require ordinary same-origin
JSON protection. Internal service tokens do not substitute for a signed login.
Actor, attribution and delivery authority are derived on the controller.

Timers, idempotency results and delivery intents live in the existing events
SQLite database. Stored authorization is only login ID/expiry. Dispatch uses
the existing ordinary admission, FIFO, receipts and runtime drivers. The native
command ID remains stable across reconciliation. Existing owned local Codex,
OpenShell Codex, Claude SDK and Gemini paths are reused; retained Responses
sessions retain their existing continuation restrictions. Feature availability
follows those existing routes and account enrollment, rather than enabling a
previously unavailable provider or environment.

Expired/revoked login, unavailable workspace/runtime, stopped session, missing
retained ownership or changed settings block a timer with an explanation. Sign
in, open the recipient when needed, then explicitly resume. Hidden/deleted,
imported and Symposium sessions are not scheduled recipients. Uncertain delivery
is never retried with a new command: reconcile the original ordinary admission.
If its acceptance becomes known, record it once; a blocked timer still needs
explicit resume. If acceptance cannot be established, cancel it and inspect the
session before authorizing replacement work. A lost UI save response retries the
same request; changing an uncertain submission requires returning to the list
and checking what was saved.

Limits: 200 timers that have not ended; intervals from one minute to seven days;
optional limits of 1–1,000 prompts. Scheduling is approximate (five-second
reconciliation), not real-time cron or an event subscription. Agent callbacks are
explicit instructions to the worker, not automatic claims of task completion.
Cross-account means sessions under the same signed Mitzo operator, each keeping
its own model account; this is not messaging between different Mitzo users.

## Validation record

Focused offline tests cover SQLite restart/idempotency, busy-session coalescing,
pause/cancel races, uncertain acknowledgement recovery, login revocation, runtime
selection across dispatch routes, OpenShell repository custody, callback source
identity, tool selection/approval, API actor/origin validation, UI creation,
cancellation, retry identity and preservation of existing composer controls.
The design-token checks and existing composer/status/Chats regressions run with
one worker and the repository's 1 GiB heap limit. No live model or staging calls.

`tests/offline/session-timers.spec.ts` renders actual Chats and composer components
with all traffic intercepted. It covers mobile WebKit/Chromium and desktop
Chromium, dark Mint/System and light Teal/Georgia, 320px phone width, draft/focus
restoration, modal bounds, agent timer pause/resume/cancel and creation. It emits
creation/details screenshots for inspection. Local execution through the approved
escalated tool stopped at the repository's macOS sandbox guard before browser
launch. No rendered visual evidence is claimed; CI captures/inspection remain
required. Full server and frontend type checks exceeded the mandated local 1 GiB
heap; broad compilation remains a CI requirement before readiness/merge.
