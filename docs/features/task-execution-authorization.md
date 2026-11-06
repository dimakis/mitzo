# Task execution authorization

`TaskExecution` gives an ordinary chat and explicitly selected same-operator
workers one bounded authorization for routine commands, local commits and GitHub
reads. It uses the shared host tool registration for Claude/Vertex SDK,
Responses, Local Codex and OpenShell Codex. An OpenShell caller runs these
operations in the displayed **host task checkout**; this is not a promise that
a separate container filesystem has been synchronized.

An agent first calls `status` to reuse an applicable authorization. Otherwise it
calls `authorize` with a stable `requestId`, task title, selected worker session
IDs, repository read scope, network scope and duration. The approval card lists
the actual registered host roots, scope fingerprints and expiry. One approval
creates that task grant; it does not enable a generic tool-name allow rule.
Explicit profiles must select the tool. Skill restrictions and Ask mode remain
authoritative, including when executing a task's underlying Bash or Git tools.

The grant binds the signed operator, each member's selected account/runtime,
registered roots and physical directory identities. Adding a worker, changing
roots, changing the selected account or widening access requires a new reviewed
authorization. A grant ID in a message is only a locator. The recipient must
already be a selected member and independently prove the current operator,
runtime, mode and root identity before effects.
Directory proofs include birth time to detect inode reuse after deletion. Routine
file writes keep that identity; a task root without birth evidence cannot acquire
a retained task grant.

## Operations

| Operation     | Required fields                            | Behavior                                                                                       |
| ------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `authorize`   | `requestId`, `title`                       | Review a task scope; optional `memberSessionIds`, `repositories`, `network`, `durationMinutes` |
| `status`      | none                                       | List applicable task grants without requesting approval                                        |
| `status`      | `grantId`, `requestId`                     | Inspect one previous run: not started, completed or uncertain                                  |
| `run`         | `grantId`, `requestId`, `command`          | Execute within the member's host task roots; optional `cwd` and bounded `timeoutMs`            |
| `commit`      | `grantId`, `requestId`, `files`, `message` | Use the existing selected-file Git commit service and its index/path protections               |
| `github_read` | `grantId`, `requestId`, `endpoint`         | Use the existing trusted GitHub reader for a listed repository; optional `access`, `view`      |
| `revoke`      | `grantId`                                  | End an authorization owned by this chat and cancel its active task runs                        |

The default network scope is `none`. `loopback` permits local binding and local
connections for tests, without general Internet egress. `internet` permits the
existing approved-command network route; its existing metadata-service and
credential protections still apply. Neither route injects host credentials or
inherits the server's environment. Ordinary non-private host reads retain the
existing runner policy; the approval card states this explicitly.

Commands reuse the existing OS sandbox runner. Task authorization does not make
an npm script intrinsically safe: actual writes remain confined by the runner,
private credentials and runtime authority stay protected, and shared Git
objects remain unavailable to arbitrary Bash. Use the selected-file commit
operation rather than broadening the shell's Git metadata access. A root that
contains the controller's authorization database cannot be authorized.

## Continuation and recovery

Authorizations and command receipts live in the existing event database and its
backup lifetime. Restart does not turn a grant ID into authority: a new runtime
must prove the same current operator, account and physical workspace scope.
Grants expire no later than the signed login and have a maximum requested
duration of eight hours. Revocation and expiry abort active task command signals;
subsequent operations recheck the durable grant. Stop still cancels the original
callback through its owning runtime signal.

Reuse the same request ID after uncertain delivery. An identical completed
command returns its retained result. A changed command with that ID is rejected.
A normal failure exit from 1 through 127 retains its output for recovery.
Cancellation, timeout, output-limit termination and missing exit evidence remain
uncertain. Statuses 128 and above also remain uncertain because shell wrappers
can encode signal termination in those statuses; an explicit high exit cannot
be distinguished safely with this process transport.
A run whose outcome was not durably settled is reported as uncertain and is not
automatically re-executed. Inspect the workspace and original run status before
starting new work. A new test variant is a new run under the same task grant.

Failures return an explicit tool error and recovery guidance and produce a
structured diagnostic. They do not silently become an empty result or an allow
decision. The shared permission audit records request/operation identity, scope
hash, final applied decision, cancellation/expiry, retained-grant reuse and wait
duration for every adapter and transport. Command bodies, question answers and
credentials are excluded from that audit stream. An audit observer failure is
logged explicitly and cannot manufacture execution authority.
Native directory checks run before retaining consent. Later RPC delivery refusals
have their own audit phase so an earlier approval cannot hide a failed delivery.

## Existing execution and publication boundaries

Native command approvals additionally retain exact-command choices in canonical
subdirectories of the admitted cwd. Scope includes directory identity and is
rechecked after approval and before RPC delivery. Escaping aliases, changed
commands, changed access and changed native threads do not reuse that consent.

Agent/Auto keep their existing provider boundaries outside an approved task.
No unqualified automatic reviewer, bypass-permissions mode or broad shell-prefix
amendment is enabled. Structured service tools keep their current account and
connection authorization. `RequestGithubPublish` remains the shared publication
route and retains its existing publication-scope consent. Task grants do not
authorize merges, production deployment, force-pushes or destructive host access.

Browser startup remains subject to the selected runner's OS capabilities. An
unsupported browser/Mach registration fails explicitly; there is no fallback to
an unrestricted host process. Use the repository's qualified CI browser checks
when the local runner cannot start that browser; do not repeatedly request an
unrestricted local escape. Browser qualification and physical runtime
acceptance require their own evidence. Offline regression coverage does not
claim production adoption or real account/model execution.
