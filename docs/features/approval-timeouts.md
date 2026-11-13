---
kind: implementation
as_of: 2026-11-13
sources:
  - "Dimitri's approval-recovery direction, 2026-11-13; original private conversation provenance is retained in MGMT"
  - 'Approval-owner source at cfa324ca72d72acee34dab816631b0c6e26df673: a preparation retained after expiry returns pending/selected on retry'
knowledge_status: unverified
review_trigger: 'Source review, CI, production activation and user acceptance'
---

# Recoverable approval timeouts

Missing an approval deadline must leave the conversation usable. The shared
permission owner returns `approval_expired`, phase `approval`, effect status
`not_started`, and recovery `renew_approval`. The same outcome accompanies the
permission timeout event and evaluated permission audit. Late responses receive
this outcome even when the timer callback has not run yet. Timeout grants no
permission and does not revoke the session or create a session grant.

Agent guidance explains that a timeout means no response arrived in time. Wait
for the user instead of repeating prompts. When the user asks to continue,
request fresh approval and recheck current scope. User rejection, cancellation,
permission loss, execution timeout and uncertain effects remain distinct.
Native mid-command approvals preserve unknown earlier effects; a timeout never
implies rollback. Cleanup uncertainty still requires reconciliation.

Shared result/content helpers preserve this distinction through host tools,
configured tools, connection and web reads, Google reads, Knowledge drafts,
TaskExecution, Telos operations, peer messages, scheduling, repository acquisition
and publishing. Native command, file and access approvals retain their supported
RPC responses while reporting the shared failure to their event owner.
Native question timeouts likewise retain the required empty-answer RPC shape
while separately recording the timeout for the existing failure/notice owner;
the host never fabricates a user answer.

Repository preparation retains expiry on its existing selection. A later request
requalifies the source and current owner, journals the previous attempt, and
atomically replaces only an unapproved selection or an expired unconsumed
approval. A reservation, live or consumed approval, materialization, uncertain
effect or retirement prevents replacement.
Older selections without expiry metadata can be renewed only after the original
bounded lifetime and proof that no approval or materialization exists. Historical
attempts remain journaled, and renewal uses the same capacity slot.

Provider capability expiry is journaled before dispatch and after scratch cleanup.
A later explicit invocation can requalify and approve that same operation identity;
its audit history remains. Rejection and write-ambiguous operations cannot enter
this renewal path. A missed main-publication approval leaves its original request
unadmitted; retry rechecks every existing review, CI and authority gate.

## UI and validation

The existing tool disclosure and group summary show **Approval timed out** for
proved pre-execution expiry. They reuse the existing neutral interrupted state
and shared tokens. There are no new containers, settings or automatic retry controls.
Actual errors and uncertain cleanup retain their existing failure display.

Regression coverage includes the real permission queue, late responses, fresh
requests, signed-native repository authorization, legacy preparation renewal,
capability journals, main-publication approval, native events and tool rendering.
Local checks use synthetic providers; no live model or provider mutation is needed.
The extended `tool-interrupted-display` offline fixture covers phone and desktop,
dark Mint/System and light Teal/Georgia, larger text and keyboard disclosure.

Local browser rendering remains unverified: the requested host route retained the
macOS sandbox marker and Playwright refused before browser launch. Fixture discovery
passed with `--list`; rendered verification remains for CI. The full server type
check exceeds the required local 1 GiB Node heap and also needs CI. Source review,
merge, production activation and user acceptance remain separate from local changes.
