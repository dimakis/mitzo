# S6 native Codex peer exchange

`AgentCommunication` is installed on the enrolled ordinary Local Codex native
route. Independent chats need no Telos ancestry or shared task. Discovery lists
up to 1000 recent conversations with actual host custody for the same signed
operator. Inbox/read expose only retained peer messages involving the calling
conversation. They do not share private transcripts, reasoning, tools, account
details or filesystem paths. Other runtimes are explicitly unsupported by this
entry; no provider fallback, enrollment or new conversation is attempted.

The native driver supplies sender and verified turn/call identity. Request JSON
cannot select an actor, operator, receipt status or host evidence. Send requires
the existing permission handler's approval of the exact target and text, with
no session-wide grant. Current runtime, skill/tool selection, live owner,
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
recipients start that queue; busy recipients finish the current turn first.
Peer input is retained as attributed agent context and is not echoed as a new
human message. Stop/recovery remains paused. A cold recipient with no original
live owner returns an unavailable receipt; a peer send grants no cold wake or
recovery authority. Existing queue cancellation is reflected in its receipt.

Pending, uncertain, queued, delivered, unavailable and failed are distinct.
Delivered requires a durable native ACK for the exact conversation, command and
rendered peer prompt. Native ACK persistence is independent of the disabled
capacity-recovery option. If receipt projection fails after ACK, lookup repairs
the receipt without replaying the turn. Store restart preserves the original
identity and uncertainty; absent ACK is never optimistic delivery.

The physical first-command boundary also distinguishes enqueue from dispatch:
enqueue requires the owning uncertain receipt, while claiming/dispatch requires
consumed. An early pump leaves the same head queued. The original host starts
that queue after coordinator completion, without a new command or reattach.

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
