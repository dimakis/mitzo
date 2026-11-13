# Specialist consultation from ordinary conversations

Implementation baseline: Mitzo `8ea17fe9bc9c`, 13 November 2026. This document
describes source behavior and synthetic-provider coverage, not production activation.

`SymposiumConsult` lets an ordinary lead select saved specialists during a
conversation. No specialist choice is required when opening that lead chat.
The lead decides when help is useful; there is no per-message classifier model.
One lead owns the result and reconciles specialist contributions before continuing.

The tool is registered for ordinary Local Mac Codex, API and Claude lead routes.
Explicit agent tool selections and skill ceilings still apply. The host adapter
requires the current ordinary runtime, original signed operator and provider call
identity. Shared specialist participants cannot recruit recursively.

## Workflow

1. `catalog` reads published profile revisions, configured account/model/runtime
   routes, authorized repository sources and this lead's retained policies.
2. The lead selects routes for useful roles and calls `authorize` with a stable
   `requestId`. The operator reviews the exact profiles, accounts, models,
   repository, duration, call limit and selected-context byte limit once. Profile
   definitions remain portable; account/model choices stay in the session policy.
3. `consult` takes `policyId`, a stable `requestId`, role, bounded assignment and
   selected public message/artifact references. The Library, repository, context,
   joining and ordinary delivery owners perform their existing checks. Joining
   itself invokes no model. Each request authorizes one targeted ordinary turn.
4. `read` observes the original request, deliveries, terminal outcome and attributed
   contributions. Partial text is not completion. The lead reads, reconciles and
   continues its own work.
5. For independent review, supply `reviewOf` referencing a completed consultation.
   The reviewer uses a different saved profile and participant. An authorized
   different model family is preferred using explicit approved `modelFamily`
   labels. Without those labels family diversity is reported as unknown;
   protocol differences do not prove it. A same-family selection includes a
   reason. No eligible independent route produces a visible refusal.

Policies allow at most eight consultations and expire within two hours, capped
by the original login lifetime. Every reserved intent consumes its call slot,
including failed setup. There are no automatic recruitment or review loops.
The existing role-routing resolver validates the selected account/model and its
audit is retained with the request. This policy caps calls and selected context
bytes; it does not certify a dollar or aggregate-token ceiling.

## Context, receipts and controls

Only the lead's explicitly selected completed public messages and exact artifact
versions enter the shared context compiler. A call made during the lead's own
turn freezes the completed prefix and rejects unfinished-message references.
Independent review receives the attributed original contribution, without
automatically copying the planner's private transcript or its selected sources.
Other future readers in the shared conversation require attention in Agents
before a consultation can proceed; the tool does not silently change their policy.

Policies and request receipts live in the existing events database. Shared
joining, ordinary commands and visible replies retain their original owners.
Request, workspace, review, join, send and Stop identities survive interruption.
Changed requests conflict under an existing request ID. Retrying a successful
request returns its original receipt and never recruits another participant.

`recover` explicitly resumes original setup after response loss, using the same
workspace, review and join identities. A retained send is observed through its
existing command owner; recovery never replays possibly accepted native work.
Membership, account, profile, source, policy and runtime authority are renewed.
An unresolved native outcome remains uncertain and requires attention.

`stop` persists cancellation and aborts pending preparation before provider
admission, or requests the ordinary owner's targeted interrupt for an admitted
turn. Repeating Stop cannot send another interrupt. Requested Stop is distinct
from terminal provider evidence. `revoke` prevents future policy use and cancels
pending preparation; already admitted turns have their separate Stop control.
Revocation preserves known activity and results.

Unexpected failures retain their original internal cause and expose fixed
diagnostics with stage, request and session identifiers. Unsupported independence,
sharing, context and runtime choices have actionable refusal messages.

## Qualified scope and remaining limits

- Targets use configured local repository-backed ordinary Codex or Claude SDK
  routes. The selected repository connection must authorize each chosen account.
  Repository-free participants and automatic enrollment of local source paths
  are not supplied by this operation.
- Local Claude SDK participants include personal Claude, Vertex and qualified
  Anthropic Messages API accounts. Provider credentials stay with existing owners.
- Local Codex workspace and ContexGin recipes use the ordinary compiler at the
  owned task directory. Packs and SDK recipes remain explicitly unsupported.
- OpenShell shared reply delivery and Gemini participants remain unqualified and
  are reported as unavailable. An accepted join is not a readiness claim.
- No profile is created or published by consultation. Portable specialist drafting
  remains an independent Agent Library operation.

Integration watch, checked 13 November: open [PR #1333](https://github.com/dimakis/mitzo/pull/1333)
at `16f2935c29df` separately corrects the completed-prefix reader and joining UI.
Before landing this branch, reconcile the completed-boundary helper with that
change's accepted version and retain both suites' source/privacy assertions.

Coverage uses the actual application composition with synthetic native/SDK
providers: planning, same-family and cross-family review, attribution, selected
context boundaries, request replay, active Stop, cancellation during preparation,
restart, lost join response recovery, tool selection, Ask mode and revocation.
No real model spend, deployment, source merge or user acceptance is implied.
