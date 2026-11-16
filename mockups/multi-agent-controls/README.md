# Multi-agent controls proposal

Open `v002.html` in Mitzo's sandboxed HTML preview. This is an interactive design
proposal with four simulated agents, not a product implementation or live session.

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
context wheel is represented with its original-agent owner; its separate redesign
is outside this proposal. Appearance controls are preview controls, not another
product settings flow. No network, host APIs, storage, model calls or real agents.

The file was read back and exercised with JSDOM: four working agents, subset/all
Stop, multi-agent Steer, uncertain correction recovery, inline @, activity details
and appearance switching. A final follow-up covers lost-Stop receipt recovery and
the distinction between stopped and working states. This checks interaction logic,
not browser geometry. Browser rendering remains unverified: the existing host
process-registration denial was not retried. No approval ledger or product source
was changed for this mockup.
