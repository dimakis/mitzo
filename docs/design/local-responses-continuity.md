# Local OpenAI API Responses continuity

This dependent source increment adopts the existing NativeResponses runner and private history store into ordinary runtime admission. It does not qualify a live account, deploy a backend, enroll Vertex/recipes, or change the OpenShell default.

## Local development environment and command approvals

The server supplies the actual host OS, architecture, working directory and
writable checkout/worktree roots to the model. Local Mac describes tool execution;
the selected OpenAI API account still supplies inference and billing. The model
must use those host paths instead of assuming OpenShell container paths.

`MITZO_ORDINARY_LOCAL_RESPONSES_NETWORK_ENABLED=1` explicitly enables networked
Bash commands for the enrolled ordinary Local API owner. It is off by default and
does not apply to legacy API or Gemini sessions. Tool descriptions and runtime
instructions reflect the selected policy. The ordinary route and its accepted
source-bound target declaration remain separately required.

This uses the existing permission handler and approval card. Agent permits file
edits and requests approval for commands. The card states that the command has
network access; **Allow for this session** retains that command capability for
the conversation. Old networkless Bash grants cannot supply the new grant. Auto
permits commands under its existing preset; Ask, skill restrictions, ownership
checks, cancellation and permission downgrades remain enforced.

Network authorization covers general proxy-mediated egress for the approved
command and its children, including local binding and loopback for development
servers. This includes reaching local services; it does not promise a hostname-only
or public-only boundary. The pinned OS sandbox retains its proxy destination denials, Unix
socket restrictions, private path protections, isolated HOME/TMPDIR, scrubbed
environment and checkout write scope. There is no unsandboxed fallback. Connection
and model credentials are not supplied to Bash; authenticated services still use
their existing connection approvals. URL read grants do not authorize shell
networking. GitCommit and RequestGithubPublish remain the supported Git operations.

The network setting is captured when the driver opens. Changing configuration
requires the normal accepted-source activation and restart procedure; it does not
grant access to an existing conversation by mutating its binding. Requalify target
declarations against the actual activated release, preserve retained histories and
verify Work OpenAI remains selectable. Source acceptance does not activate either
switch, deploy production, or establish live model/runtime qualification.

The existing picker and generic `/api/chat/runtime` capability/send/continue entry derive Local Responses or OpenShell Codex from the exact enrolled OpenAI API account and selected environment. A single opaque account reference retains provider, routing revision and billing credential owner across environments. Different environments start separate conversations and accepted repository checkouts. Model catalogs and thinking support stay attached to each route snapshot; combined account display metadata never authorizes another route.

Local Responses requires `MITZO_ORDINARY_LOCAL_RESPONSES_ENABLED=1` and an explicit private `MITZO_ORDINARY_LOCAL_RESPONSES_TARGET_FILE`. The version 1 target declares targetId, label, actual hostId and the reviewed source contract revision returned by `ordinaryLocalResponsesContractRevision()`. Absence, incompatible host/source, disabled enrollment, or missing enrollment credential custody refuses the route. The account must be ready in the existing enrolled AccountProfiles projection and owned by the exact existing OpenAIEnrollmentAuthority. No generic secret lookup, other account, subscription-to-API substitution, or ambient OpenShell choice supplies a fallback.

The existing EventStore send command `ordinary_admission` column retains exact intent, target/account/workspace, profile, permission, model and thinking. Strict Codex aliases remain strict; generic runtime command schemas also accept Local Responses. Receipt uncertainty precedes checkout creation, private native custody, provider-attempt admission and preparation. Dispatch and tool execution require the matching consumed ordinary receipt and existing provider execution/attempt ledger. Failed uncertain dispatch is retained and is never replayed automatically. The existing native conversation row holds a bounded durable FIFO of command identities; payload/model/thinking remain the original ordinary receipts. Active turns accept consumed queued children. Only the consumed head may claim the native active slot and provider-attempt admission after the previous execution is terminal. Settings changed after enqueue never rewrite older queued commands.

NativeResponsesStore gains additive internal custody on its existing conversation row: original signed login, exact runtime binding and repository workspace. No credentials are serialized. The original account binding model remains the private store key; command model/thinking independently qualifies current inference. Cold reopening restores consumed queued children that have never had provider-attempt admission, preserving their original FIFO/model/thinking. Stop pauses the queue; explicit continuation under the original signed operator resumes it. Existing queue metadata and cancellation show bounded previews without hydrating historical images; cancellation refuses active or uncertain attempts. Cold resume requires the same still-valid signed login, persistent revocation authority, exact custody, a claimed retained checkout and no native running state. Old history without custody cannot enroll by resume. Local history and encrypted reasoning checkpoints retain continuity with provider `store:false`; interrupted unresolved tool calls become uncertainty results, never automatic tool replay.

Permissions retain the shared application handlers and exact command mode/revision. Native executors recheck runtime authority after approval; project hooks are not trusted on this route. Stop aborts the native turn, clears prepared command authority, and retains interrupted history and existing execution uncertainty. The ordinary driver lives on ManagedSession and follows its existing attachment/control lifetime; reconnect does not transfer the operator.

Queue cancellation during an asynchronous authority check advances scheduling to the next accepted head. Exact retries acknowledge their original receipt even at the 32-command queue limit; new work remains refused at capacity. The existing queue-continue control can reopen and drain a stopped full FIFO without a new prompt or receipt. Cold reopening holds the existing repository startup reservation through driver registration, so concurrent queue Continue and runtime Continue cannot create competing owners. Cold controls require the original signed operator, its authenticated connection, retained native custody, current account/target/workspace authority and positively consumed, never-attempted queued snapshots. An unavailable model or unresolved prior execution remains refused; no saved command is discarded to make room. Metadata exposes this qualified cold control without claiming a live connection.

Entry and cold queue reopening deadlines relay into the existing Responses preparation controller through checkout, MCP initialization and final admission fences. The relay detaches after admission so entry cleanup does not cancel later conversation turns. Live follow-ups use a separate per-admission request signal, checked around awaited authority/workspace validation and receipt/queue effects; an expired new command cannot become consumed, while existing active and accepted work keeps its own lifetime authority. Cancelled preparation retains its uncertain receipt and cannot enter provider execution.

Host MCP initialization checks the selected startup command's authority before each connection and after awaited connection/tool discovery. After startup, the same connector checks the active command at tool effects. Host shell execution refreshes asynchronous source-grant authority after sandbox preparation, followed by the final synchronous spawn fence. Trusted Git publication refreshes that same authority before new object and ref effects. Fully written objects publish through a no-clobber link under original physical custody; failure cleans only the exact owned temporary inode. After a confirmed ref update, its exact prepared index is finalized as consistency cleanup without a new source-grant check. Original no-follow HEAD inode/path and symbolic branch authority remain mandatory; a checkout branch switch retains uncertainty instead of installing another branch’s index. Failed or cancelled ref responses are classified under original physical metadata: the old ref permits owned lock cleanup, the new ref requires index finalization, and other/unconfirmed outcomes retain the owned prepared index.lock for explicit recovery. No automatic rollback or foreign/stale lock deletion occurs. Cold queue reopening reconciles a disconnected event stream after driver registration, retaining the owner and work while marking the transport detached. Account or target loss during initialization closes existing peers and prevents later host processes from starting.

Offline fixtures exercise actual claimed Git checkouts, original binding/custody/history, consumed dispatch through the real Responses adapter with mocked HTTP, changed future model/thinking, enqueue during active work, cancellation under the original operator, terminal scheduling, Stop-paused queued restoration and cold reopening. Mocked transport and credential authority are test-only. Hosted source review/CI, accepted artifact regeneration, UI integration checks and independently reviewed canonical staging/provider configuration remain required gates. No real model, credential, GitHub publication, staging or production call is evidence from these tests.

An interrupted native checkpoint is not evidence that an unfinished provider attempt or external action completed. If the existing provider execution ledger remains nonterminal after restart, cold resume refuses before a new ordinary receipt and explains that the prior outcome is unconfirmed. Original command, attempts, history and checkout remain intact. The existing Responses adapter has no durable explicit recovery acknowledgement boundary equivalent to Codex queue recovery; this source does not silently create one. Safe original-owner acknowledgement/reconciliation of old attempts as ambiguous remains a separate gate. Completed and durably terminalized Stop turns can reopen normally.

Route eligibility lists the existing immutable Library profile references and rejection reasons. Responses accepts provider-compatible plain user profiles and the canonical code-owned builtin under its distinct namespace. It refuses every reusable context recipe with `native_context_unavailable`; Codex context qualification does not authorize Responses delivery. The picker retains the choice/draft and states the unsupported boundary.
