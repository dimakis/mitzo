# Bounded task execution for ordinary Claude

Ordinary Local Mac Claude advertised `TaskExecution`, but explicit profiles could
not select it and the mandatory SDK permission callback refused it. Users could
not use the shared bounded grant to cover routine development commands and
repository reads. The ordinary helper catalog, callback and routing guidance now
admit this existing executor for personal Claude, Vertex and supported API SDK
accounts. No new command runner or notification channel is introduced.

Task status requires the verified ordinary owner. Authorization reuses eligible
existing development/repository consent, or presents one bounded task decision
with the selected accounts, roots, repositories, network scope and expiry.
In-scope operations reuse that grant. The executor rechecks operator, account,
workspace, selection, skill policy, cancellation, revocation and expiry. A task
grant never becomes permission for native Bash, credentials, publication, merge
or deployment. Ask mode cannot authorize or execute task work.

Approvals retain the current shared Codex notification experience: the central
notification owner applies existing preferences, quiet hours, preview privacy,
delivery channels and per-request/device receipts. Valid task reuse creates no
new approval, so it creates no new approval alert. Distinct decisions still
receive their own eligible alert; notification delivery cannot grant consent.

`SchedulePrompt`, `SessionTimers` and `SendSessionMessage` are removed from the
restricted ordinary SDK registration because this route does not qualify their
permission callback. Legacy qualified registrations remain unchanged. This does
not enable those tools, Telos item/artifact helpers, repository preparation or
OpenShell Claude. It does not repair the separately reported `srt-mux` failure.

Offline coverage uses the real in-memory SDK MCP transport, task store,
permission handler and notification center for personal and Vertex identities.
It verifies one approval/alert for two command variants, refusal after grant
revocation, profile exclusion and retired-owner refusal. The command effect and
push transport are synthetic. The application admission/SDK continuation test
also exercises actual `canUseTool` and mandatory `PreToolUse` callbacks for a
selected TaskExecution tool. Existing task, connection and notification
regressions retain their own scope. No live provider, production device delivery
or deployed adoption is established by these tests.

The takeover candidate integrates accepted source `23816770`, including PR #1322's
shared SDK helper registration. Callback admission and capability projection consume
the same helper owner. Task-routing instructions are included only when the current
profile selects TaskExecution. Application tests cover both selected and omitted
profiles through startup and SDK continuation.

The focused local run passed 127 checks; one existing Access HTTP endpoint case was
blocked by `listen EPERM` under the task grant's `network: none` scope. This is a
test-runner authority limit, not a passing endpoint acceptance result. No grant was
widened and no hosted CI was started for this checkpoint.

Detached successful SDK turns now defer completion delivery to the same installed
notification owner. They still record the completion once, but do not independently
send ntfy and Pushover messages around the central preferences, quiet hours or
privacy policy. Standalone consumers without that owner retain legacy sends;
unexpected sender rejections produce a correlated diagnostic instead of an empty
catch. The center's existing legacy fallback remains specific to permission notices;
this change does not invent a second completion delivery system.

Real query-loop consumer regressions demonstrate the duplicate send before the fix
and cover both central and standalone ownership. All 141 query-loop/notification
checks passed with synthetic transports; no device delivery is claimed.
