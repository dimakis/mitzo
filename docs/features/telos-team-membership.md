# Explicit Telos team membership

The operational team is explicitly recorded in the canonical Telos database.
Historical origins, formal lead/worker assignments and allocation receipts do not
establish this roster. Existing work starts with an empty roster until the user
explicitly links its participants. This delivery provides the persistence,
authenticated command and client contract; user-facing team controls and agent
review tooling remain pending.

`TelosWorkStore.readTeam(itemId, operator)` returns a canonical SHA-256 revision
and retained current/former memberships. Each records the selected conversation,
display name, role, responsibility, reporting target, original linking actor/time,
ending actor/time, replacement identity and last transition UUID. Display names
are recorded labels, not an alternative session metadata owner. Discovery may
resolve a current name through its existing authorized owner.

Warm HTTP team reads use the canonical read-only opener and can return committed
team state while another writer has uncommitted work. Only a missing additive
team layout initializes through the canonical schema owner; unavailable or
incompatible readers do not retry as writers.

Roles are orchestrator, feature lead, slice owner, investigator, implementer,
reviewer, merge agent and contributor. Each owner role has one current holder per
item. Contributors can have independent roles. Replacement requires a different
conversation in the same role and atomically retains the former member and its
successor. Unlink ends a membership without deleting attribution or the chat.
Relinking creates a new membership identity. Reporting targets must be current
members of the same team when selected. A target that later leaves stays visible
as a former target; replacement never silently redirects existing reporting.

## Commands and authority

- `GET /api/telos/work/items/:itemId/team` reads the retained roster.
- `POST /api/telos/work/team/commands` accepts strict `link`, `unlink` and
  `replace` commands with itemId, requestId and expected team revision.
- `TelosWorkApiClient.readTeam` and `teamCommand` validate response identities,
  use ordinary authenticated requests and never retry implicitly.

Mutations require current interactive operator authorization, same-origin JSON,
active item lifecycle and a final host authorization check under the canonical
writer transaction. A new link/replacement requires an available compatible
Mitzo conversation. The existing source-visibility policy permits explicit
Symposium participation as well as ordinary sessions. Neither membership nor a
team owner label grants item/transcript reads, role setup, execution, repository,
credential, account or merge authority. Conversation actors cannot mutate this
roster or inherit operator authority.

Command receipts retain requestId, commandId, actorId and the exact resulting
roster. An exact replay returns the original receipt after subsequent changes or
target unavailability; altered input under the same identity is a conflict.
Concurrent stale revisions fail without partial membership/receipt changes.
Unexpected storage and response errors stay visible. Structured diagnostics keep
the stage, sanitized cause and hashed request identity; a diagnostic-sink failure
uses the existing bounded fallback rather than replacing the original failure.

## Delivery boundaries

The existing ordinary session setup/adoption/delegation owners retain new-chat
creation, independent account/runtime/workspace/settings, drafts, queue state,
materials, immutable role context, allocation recovery and command admission.
Roster commands allocate no chat and mutate none of those stores.

This is the canonical foundation for slice `4cd96f8d0f5a5f3f`. Full slice acceptance
still requires reviewed new/existing-chat selection, agent command review,
approved item/tree/chat controls, reconnect/mobile UI qualification and combined
workflow evidence after the accepted parity and Symposium repairs. Do not infer
that a team owner label replaces a formal runtime role. Do not duplicate #1345's
compact overview/peer-reply repair or #1359's current-work projection.
