# Queue, reply attribution and turn corrections

Ordinary sends retain the existing native FIFO and full guarded command admission.
Each accepted request has display-only queued/running/terminal state, while an
assistant message's `replyToMessageId` comes from the existing durable
`ordinary_reply_source` record. Only Mitzo command and message identities are
projected to clients; provider identities remain private. Legacy source-less
responses remain unattributed. Live and immutable-prefix history use the same
ownership. `Preparing response…` is cleared by the submitted request's own output
or completion rather than the previous turn's late output or terminal event.

The native ordinary Codex route exposes POST
`/api/sessions/:id/codex-queue/steer` with the strict body
`{ requestId, targetCommandId, text }`. It requires the original signed operator,
ordinary contributor control and the current retained Codex owner. Model, settings,
attachments, workspace and authorization overrides are refused. The active target
is captured before asynchronous binding validation and rechecked immediately before
the provider call. Steering does not interrupt, start, retry, or reorder commands.
Responses/Claude/Gemini and Symposium do not inherit a legacy replacement path.

The private native store retains an atomic per-conversation correction claim and
outcome. Reusing an ID with another target or text is refused. A claimed or uncertain
request is never dispatched again, including after reconnect. Accepted/rejected
receipts can be read with the same request when the runtime has ended. An explicit
provider refusal is rejected; an absent/mismatched acknowledgment or lost transport
response remains uncertain. The UI retains the input on refusal and uses its saved
identity for explicit recovery, with no automatic retry on reload. Corrections keep
the running turn's original account, model, permissions and workspace; changed
future picker settings affect queued commands only.

Codex's documented [turn/steer contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
appends user input to an active turn, requires `expectedTurnId`, returns `turnId`,
and accepts no turn-level overrides. The pinned adapter sends exactly those fields.
A runtime which refuses steering retains the draft; it never falls back to Stop
or a new turn. Local verification uses synthetic providers, not model calls.

Tests cover stale targets, changed authority, lost acknowledgments, idempotency,
FIFO preservation, HTTP input/ownership, storage refusal/reload, A/B reply ordering,
preparing status and mobile/desktop rendering. No staging or production activation
is part of this change.
