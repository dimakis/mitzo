# Multi-agent controls proposal

Open `v003.html` in Mitzo's sandboxed HTML preview. This is an interactive design
proposal with four simulated agents, not a product implementation or live session.

Revision 3 was approved by Dimitri on 16 November before the implementation update
to PR #1374. The following describes the retained proposal. Status and recipients share the
existing information line above the composer; there is no status below it. Agents
read when addressed, with an explicit default-reply setting rather than a future
reading checkbox. The rainbow context wheel opens a per-agent usage sheet; the
wheel number is agent count and all usage figures are clearly marked sample data.
Every user and agent message retains date/time and icon actions for Copy, Read
aloud, Reply and Forward. Reply quotes preserve source author/time/text and link
back to the source. Forward reviews that source and selected recipients, retaining
the unsent composer text; asking for a reply is a separate unchecked option.
Clipboard, playback and delivery are simulated. Existing Agents menu destinations,
Add agent, composer icons, inline @ and per-agent control recovery remain available.
Revisions 1 and 2 are retained unchanged. This revision changes no product source,
approval ledger, PR or live runtime.

Revision 3 verification: JSDOM exercised the above-composer information row,
per-agent context popup, addressed-reading copy, retained Agents menu and Add
flow, all message actions, user/agent forwarding, reply quotes, retained drafts,
inline @, Stop/Steer and uncertain-receipt recovery, appearance switching and
typing without transcript scroll changes. The shared design suite passed
109 tests with one skipped. Browser geometry remains unverified because the
previously observed macOS process-registration denial was not retried.

Revision 2 preserves the existing top Agents menu, including per-agent activity,
sharing policies, preview, Details, Chat settings and Add agent. The composer uses
the existing icons, one Send/Stop slot and a collapsed @ recipient disclosure with
selected-agent colors. On phone, recipients or extra tools use one optional second
line; opening one collapses the other. It has no duplicated activity roster.
The add-agent and joining review interactions are local simulations. Revision 1
is retained unchanged for comparison.

Choose any subset with inline recipient buttons, or choose All. Stop applies to
that selection; Steer applies the composer text to selected running agents. Send
queues a follow-up. All controls retain explicit names and per-agent feedback.
Activity details show each agent's task and elapsed time. Try the approval,
uncertain-correction and lost-Stop-receipt scenarios, plus phone/desktop and
appearance switches. State is in memory; Reset restores the example.

Uses a verbatim embedded copy of shared `frontend/src/styles/tokens.css`, stable
seat colors, transcript bubbles, inline recipient rows and a single composer
status rail. Historical action outcomes stay in the transcript. The current
context wheel in revisions 1 and 2 retains its original-agent owner; revision 3
proposes the requested separate inspector. Appearance controls are preview controls, not another
product settings flow. No network, host APIs, storage, model calls or real agents.

The file was read back and exercised with JSDOM: four working agents, subset/all
Stop, multi-agent Steer, uncertain correction recovery, inline @, activity details
and appearance switching. A final follow-up covers lost-Stop receipt recovery and
the distinction between stopped and working states. This checks interaction logic,
not browser geometry. Browser rendering remains unverified: the existing host
process-registration denial was not retried. No approval ledger or product source
was changed for this mockup.
