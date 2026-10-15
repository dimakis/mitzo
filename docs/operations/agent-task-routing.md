# Task-first agent startup

Ordinary managed OpenShell Codex chats receive a bounded command inventory at each
safe turn, alongside their selected knowledge and agent context. The host checks
the writable task root for executable `./mgmt` and
`./command_center/meeting_prep.py` entrypoints and checks PATH for `gws`. It does not
execute those commands, read credentials or copy tools from published knowledge.
The inventory is a point-in-time observation, not dependency or authentication
verification. Missing, malformed, oversized or timed-out observations become
unknown; caller cancellation still stops admission. The probe has a three-second
deadline and runs under the existing sandbox lifecycle fence.

Runtime guidance takes precedence over command examples in published documents.
After one classified command, dependency, credential or permission failure, the
agent names the limitation and continues with available evidence. Runtime setup
and diagnosis requests retain their normal troubleshooting scope. These are
agent instructions, not a new permission grant or tool execution policy.

Meeting-preparation guidance starts with the calendar invite, attendees and linked
documents, then relevant Jira evidence and targeted historical retrieval. Missing
live evidence produces a clearly qualified partial brief. A brief in chat does not
require a Telos outcome. Telos history retrieval is conditional on relevant prior
work for both default chats and saved recipes.

Both `RequestConnectionAccess` and `GrantIntegrationAccess` share a host-only
provider-attachment receipt. The continuation decision uses that receipt rather
than a tool name or success text. Existing transport refresh and provider
environment gates verify the new process before credential-dependent work resumes.
Already-attached providers, denied grants and unrelated successful tools do not
trigger another continuation. Approval scopes and retained-turn ownership remain
with their existing controllers.

Existing knowledge compiler budgets, source selection and saved recipe scopes are
preserved. The task workflow is a small runtime overlay; this change does not
claim to reduce the generic 12,000-token boot budget. Host/SDK routes receive the
shared conditional Telos instructions; the command inventory is specific to
managed OpenShell Codex chats.

Offline regressions cover both grant routes, continuation eligibility, inventory
parsing/cancellation, real local filesystem probes that never execute entrypoints,
missing-runtime guidance and retained-turn context delivery. No live account or
model is needed for these checks.
