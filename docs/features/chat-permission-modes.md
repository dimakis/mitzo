# Editable chat permission modes

Requested by Dimitri on 12 November 2026 in the PR #1293 working conversation:
mode selection must remain available in new and existing chats, persist, and
preserve the accepted reductions in approval prompts. Implementation evidence
belongs to this branch until review and acceptance; deployment is separate.

The existing Ask / Agent / Auto picker remains in the approved settings surface
on phone and desktop. A new draft saves its selected mode using the existing
draft/default owners. Changing one conversation does not change another chat or
the explicitly saved new-session defaults. Existing chats display acknowledged
server policy, disable duplicate changes while awaiting acknowledgement, and
keep failures visible. Reconnect and navigation hydrate the observed policy.

An ordinary command's original `mode` remains part of its frozen admission
tuple. The separately persisted `permissionMode` is an explicit user policy;
changing it never rewrites a command receipt, workspace, account, agent, source
selection or queued command. Provider tool allowance and native execution
profiles consume the effective policy. Native profile changes apply on the next
turn. Pending restrictive transitions constrain host tools immediately; a failed
increase does not expand policy. Restoring a chat restores its user policy before
tool/provider startup. OpenShell retains its Agent/Auto capability ceiling; Ask
is visibly unavailable there rather than increasing privileges automatically.

The authenticated same-origin mode endpoint rechecks the current runtime binding,
connection/login and original live or persisted custody before policy effects and
after provider acknowledgement. Uncertain admission blocks changes. Legacy
runtime-bound control paths continue to refuse mode edits. Mode changes grant no
new workspace, source, credential, publication or deployment authority. Session
allowances and reusable Access grants retain their existing owners and lifetime.

The change builds on accepted #1263 (reusable access), #1304 (CI-read consent and
notification coalescing), and #1312 (mode-aware Google reads). Their enforcement
and regression coverage remain required. Google Auto delivery still rechecks
effective mode; Ask/Agent session grants remain explicit. Approval scope,
expiration, revocation and unknown outcomes remain distinct from mode selection.

Validation covers persisted policy across database reopen, original receipt
preservation, repeated switching, authorization loss during provider update,
same-login HTTP ownership and refusal, restrictive pending transitions and the
desktop question/inspector coexistence regression. Offline rendered fixtures,
combined CI and final Centaur review remain required before merge. No staging or
production test is implied by these offline checks.

Local validation on 12 November passed focused mode, approval-reuse, HTTP/provider,
startup, database, mobile/desktop consumer and design regressions, plus shared
package TypeScript, changed-file lint and source-artifact checks. The real
HTTP/SSE consumer retains streamed output through provider rejection, failed
persistence and a successful retry, including delayed stale HTTP responses.
The new offline browser fixture checks the existing settings controls and focus;
its simulated persistence is rendering evidence only. This Mac blocked browser
process registration in the task executor; native execution also remained behind
the repository's Seatbelt guard. No local rendered screenshot is claimed. CI must
run the phone and desktop browser checks on the combined candidate.
