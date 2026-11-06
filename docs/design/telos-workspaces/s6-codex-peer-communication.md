# S6 native Codex peer exchange

`AgentCommunication` is installed on the enrolled ordinary Local Codex native
route. Independent chats need no Telos ancestry or shared task. Discovery lists
up to 1000 recent conversations with actual host custody for the same signed
operator. Inbox/read expose only retained peer messages involving the calling
conversation. They do not share private transcripts, reasoning, tools, account
details or filesystem paths. Other runtimes are explicitly unsupported by this
entry; no provider fallback, enrollment or new conversation is attempted.
An authorized sender's retained receipt stays readable when its recipient is
hidden or loses new-send eligibility. That read preserves the last confirmed
facts and uncertainty; it grants no new delivery or recipient recovery.

The native driver supplies sender and verified turn/call identity. Request JSON
cannot select an actor, operator, receipt status or host evidence. Send requires
the existing permission handler's approval once or a scoped session messaging
grant. That grant covers the source chat's same-operator live peers and their
correlated replies while the original granting owner remains live and retains
the grant. It is cleared with that session and cannot cross signed operators.
Current runtime, skill/tool selection, live owner,
signed operator and actual recipient custody are rechecked across awaits.
Messaging grants no coordinator, worker, credential, publication or merge
authority. Target command admission still checks its own current scope.

The direct exchange ledger belongs to EventStore's existing SQLite database and
backup lifetime. It retains original sender, recipient, text, request ID,
private native-call provenance and optional reply correlation. Group policy
and operator-authored collaboration messages are separate contracts; a peer
message does not enroll a reader in a group or share its transcript.

`send` retains a stable request before effects and claims uncertainty before
admission. Repeating an uncertain request cannot enqueue again; changed content
under the same identity is refused. `lookup` recovers an original request after
a lost response without dispatch. Only original participants may correlate a
reply. Replies are explicit sends, so ordinary replies do not create an
automatic ping-pong loop.

The original live owner's `admitAgentMessage(messageId, assertSenderCurrent,
signal)` derives current V2 settings from its latest consumed admission and
loads the exact retained message. It uses the ordinary account, workspace,
context and permission coordinator, then the original native FIFO. Healthy idle
recipients start that queue. Busy recipients first receive the same attributed
peer prompt through native `turn/steer`, targeting the exact accepted live turn.
Only an inactive/stale target falls back to the queue; rejection or uncertainty
never causes another delivery attempt. Stop/recovery remains paused.

Every retained send and receipt transition is also an `agent_message` transcript
event in both conversations, committed atomically with the exchange ledger.
Live delivery and bounded/full replay use that same event stream. The shared
message card shows complete text, conversation links, time, receipt state and
message/reply identifiers. It never labels a peer as the human operator. An
upgrade backfills old retained exchanges without attempting their delivery;
old exchanges without a creation timestamp show their transcript recording time.
A cold recipient with no original
live owner returns an unavailable receipt; a peer send grants no cold wake or
recovery authority. Existing queue cancellation is reflected in its receipt.

Pending, uncertain, queued, delivered, unavailable and failed are distinct.
Delivered requires a durable native turn/start or steering ACK for the exact
conversation, request and rendered peer prompt. It does not mean the recipient
has applied a pause, merged a PR, or otherwise acted. A positive native
pre-dispatch witness records failure before provider submission; missing ACKs
remain uncertain. Native ACK persistence is independent of the disabled
capacity-recovery option. If receipt projection fails after ACK, lookup repairs
the receipt without replaying the turn. Store restart preserves the original
identity and uncertainty; absent ACK is never optimistic delivery.

The physical first-command boundary also distinguishes enqueue from dispatch:
enqueue requires the owning uncertain receipt, while claiming/dispatch requires
consumed. An early pump leaves the same head queued. The original host starts
that queue after coordinator completion, without a new command or reattach.
The production-host regression calls `startOwnedLocalCodexCommand` and observes
initial native turn/start and subsequent exact-target peer steering. The test never pumps the queue;
an exact repeated start acknowledges the original command without another turn.

Offline evidence uses actual signed login/revocation, physical host/login
custody, repository owner, command admission, permission handler and native
tool/FIFO/ACK paths. Only external process/RPC effects are synthetic. It covers
independent peers, busy/idle delivery, explicit replies, exact retries/lookup,
replacement across an await, logout, forged identity, Stop/cancel, cold refusal
and ACK/projection recovery. Existing ordinary native regressions remain intact.

This bounded implementation does not establish accepted S5b non-Git qualification,
OpenShell support, operator/group collaboration delivery, coordinator setup UI,
shared-main publication enforcement, live qualification or feature acceptance.
Those require their actual owning application paths and independent acceptance.
