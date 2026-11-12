# Traceable agent messages

Implementation proposal dated 2026-11-06, based on Dimitri's request for visible,
autonomous session coordination. The existing [native exchange contract](../design/telos-workspaces/s6-codex-peer-communication.md)
owns authorization and delivery. This document does not establish release or
production activation.

The 2026-11-11 source proposal extends that contract through verified ordinary
runtime adapters. It is based on deployed revision
`58221eafa964761962ea0c949c682f11486e1575`. Local Codex keeps its existing native
steering path. Owned Local Claude SDK queries use priority-now input and an exact
replay acknowledgement without changing the active command's input/result
correlation. Inventory exposes unsupported capabilities rather than silently
omitting an owned runtime. Other runtime and Symposium control paths require
their actual owners; an agent/chat label does not establish adapter support.

Each send appears in both chat transcripts immediately after authorization,
including sends that subsequently fail. The complete text, sender and recipient
conversation links, time, copy action, message/reply IDs and current delivery
state are retained. Updates replace the original row; reconnect and historical
replay show the same message. Older invisible retained messages are backfilled
without resending them. No peer message is presented as a human request.

The operator can approve one message or grant messaging for the originating
session. Existing grants cover that operator's live Local Mac Codex chats and
correlated replies from those peers. Cross-runtime exchanges require a separate
`adapters-v1` audience grant; the original grant never expands automatically.
Losing the original live
owner or clearing its grant removes reply coverage. Runtime, operator, recipient,
skill/tool and cancellation checks remain in effect for every send. Messages
convey no publication, filesystem, work-control or merge authority.
Correlated replies pass through the shared permission constraints, including Ask
mode. The exact grant owner and membership are rechecked across asynchronous
admission and at queued provider dispatch; a revoked grant cannot be reused.

A supported busy recipient receives an active-turn correction through its verified
native or SDK adapter. An idle recipient uses guarded ordinary admission. A paused or cold conversation
is never resumed implicitly. Acknowledgement loss stays uncertain and exact
retries only inspect the original request. Delivery means the provider accepted
the message; a requested pause still requires the recipient's own acknowledgement.
Queued cancellation updates both transcripts immediately. Live receipts use the
normal retained-event delivery path for V2 watches and reconnecting viewers.
Cancellation also projects from the successful cold-store boundary. Resume never
reconstructs a peer permission fence from retained queue data: input that lost its
live authorization is blocked before provider dispatch and needs a fresh send.

Local logs inspected on 2026-11-06 showed two peer commands stopping at
`native_policy` with `providerSubmitted=false`. The previous receipt path
reported uncertainty despite retained positive evidence of no submission. The
regression now requires a failed receipt and visible transcript row for that
case. Actual policy checks remain authoritative; this feature cannot bypass a
genuine policy failure. Operational identifiers and private message text are
intentionally excluded from this portable feature record.

The supported ordinary-chat matrix is:

| Sender                 | Recipient              | Busy delivery                       |
| ---------------------- | ---------------------- | ----------------------------------- |
| Owned Local Codex      | Owned Local Codex      | Existing native `turn/steer`        |
| Owned Local Codex      | Owned Local Claude SDK | Existing SDK query, `priority: now` |
| Owned Local Claude SDK | Owned Local Codex      | Same guarded native `turn/steer`    |
| Owned Local Claude SDK | Owned Local Claude SDK | Same guarded SDK query              |

Claude exposes `mcp__mitzo-connections__AgentCommunication` in its existing
in-process MCP server. Explicit `claude-sdk` profiles may select this catalog
tool; other tools require their own qualified routes. Restricted skills use the
exposed SDK name consistently through the tool and approval boundaries. This
does not qualify private Symposium contributors. An ordinary chat implementing
Symposium is eligible only through the same verified ordinary runtime owner.

Offline validation exercises all four shared routing combinations, the real MCP
sender protocol with explicit profile and restricted skill, actual native
admission/permission/steering owners, and the full Claude application query and
command-owner path with synthetic providers. The application regression covers
Vertex and personal-Claude configurations, a busy correction ACK leaving the
original command running, and successor query recreation after its result.
Idle admission rechecks the sender through asynchronous preparation and stdin;
its ACK must match the assigned input UUID and actual submitted text. Wrong,
foreign and replayed ACKs cannot claim delivery or contaminate result correlation.
SQLite reopen cannot reconstruct a lost live sender permission. A native turn
becoming stale never falls back to a queued command.

These composed offline checks do not establish live provider timing or that a
model applied an instruction. `queued` means ordinary admission; `delivered`
means provider acknowledgement. Applied behavior requires separate evidence.
Live model calls, deployment, private contributor runtime support and production
adoption remain separate qualifications. Browser rendering and broad combined
build/type checks remain required CI gates.
