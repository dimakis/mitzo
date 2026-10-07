# Mitzo

Claude Code on your phone. A self-hosted web UI built on the [Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), designed for mobile over [Tailscale](https://tailscale.com).

<!-- ![Home Screen](docs/screenshots/home.png) -->
<!-- ![Chat with Tools](docs/screenshots/chat-tools.png) -->

#Isolated seeded workspaces can publish committed task deltas through the shared GitHub approval broker once their original host baseline is registered. The task history stays intact; only reviewed changes are projected onto upstream. See [seeded GitHub publication](docs/operations/seeded-github-publication.md) for configuration and failure diagnostics.

## New chat account and model

Expand **Workspace** in chat to choose the account and model. **Make default for new chats** saves that pair (and thinking setting) on this browser; **Clear new-chat default** removes it. Existing conversations keep their bound account. When no default is saved, select an account or confirm the suggested account with **Use** before sending. If a saved account or model is unavailable, choose a replacement explicitly.

Telos **Open in Chat** and **Start Session** open a launch preview with Workspace expanded. Review the account and model, then select **Send launch prompt**. The chat follows the session created for that launch and keeps its Telos context and task identity. The preview stays available until delivery is confirmed through the HTTP receipt or a matching persisted WebSocket user-message echo; a failed send can be retried with the same task context.

## Features

The dormant [Symposium artifact snapshot observer](docs/features/symposium-artifact-snapshots.md) records bounded host observations; it does not yet enable automated review or publication.

[Symposium admission candidates](docs/features/symposium-owned-evidence.md) can resolve an explicitly selected Personal connection and ready session volume inside the retained host, without installing or activating admission.

[Fresh Symposium artifacts](docs/operations/symposium-artifact-initialization.md) initialize an empty owned Git workspace before admission, retaining initializer identity and cleanup receipts. An opt-in credential-free physical contract checks native writer and read-only reviewer access; full application acceptance and restart recovery remain separate gates.

[Native subscription continuity](docs/operations/symposium-attempt-continuity.md) carries all eligible completed seat text into explicitly recorded replacement threads across isolated attempt homes, within a strict 64 KiB bound.

Vertex readiness validates the pinned CLI’s blank failure-code column and empty-error `-` marker without accepting diagnostic text.

Symposium director status resolves the verified runtime once per request and reuses it for per-seat diagnostics; each later request still performs fresh verification.

[Local Symposium source import](docs/operations/symposium-local-source.md) previews and explicitly imports bounded committed history from a configured local repository before any seat admission permission is issued. It uses fresh app authorization and a credential-free networkless helper; oversized, unsupported and uncertain imports remain fenced. Native budget, review and publication still require their own authority.

- **Streaming chat** with thinking blocks, tool pills, and markdown
- **Session settings at a glance** — a single session header shows the account profile, model, and thinking level even when collapsed. Expand it for account, permission, web access, and reviewer controls; Outputs / Sources is beside the composer. The summary wraps compactly on mobile.
- **Live token usage** — the chat token bar shows context and session totals for OpenAI Responses turns after the provider reports usage at completion.
- **Request web access** — ordinary ChatGPT/Codex (host or OpenShell), OpenAI API, Gemini/Vertex and Claude SDK chats can ask the user for web search or URL access. `request_access` shows the exact HTTP(S) origin and resolved addresses, including local/private hosts and custom ports, and enables credential-free reads through the web tool for 15 minutes. `fetch` reuses that approval; `revoke_access` removes it. Redirects to another origin and changed destination addresses require separate approval. Ungranted `fetch` keeps the single public HTTPS read flow. Search uses the selected account/model without fallback. See [request web access](docs/features/request-web-access.md).
- **Approved GitHub publishing** — ordinary Codex subscription, OpenShell, API-key, Gemini/Vertex and Claude SDK chats expose `RequestGithubPublish`. It resolves the workspace’s GitHub repository and selects the matching active managed connection for the current AI account. Access approval is remembered per repository and account, then it asks approval for the exact feature branch, source commit and pull request. Host and OpenShell workspaces use separate validated source transports; GitHub write credentials stay on the controller and are removed from legacy and account-selected Claude SDK child environments and project hook expansion and execution. Connections now includes host-only and Vertex accounts for GitHub assignments. A managed connection and controller publishing authorization remain required; the legacy read-only provider alone does not grant publishing. Adding a connection preserves existing OpenShell Codex conversations: retained sandboxes keep their current read attachments, while the controller can select the new publishing connection after approval. New chats receive the current automatic connections; revoked or replaced retained attachments still block admission.
- **Symposium access requests** — admitted Codex/API/subscription and Vertex seats expose website access and publication request tools. Website requests show the seat, account, exact origin and resolved addresses for user approval; bounded reads remain scoped to the executing claim. Publication requests open the existing sealed-artifact review workflow and never grant direct GitHub writes. Vertex uses a credential-free, bounded stdio/file bridge inside the claim’s private HOME. The broker activates only after a verified model receipt and drains before attempt cleanup.
- **Three modes** — Ask (read-only), Agent (file edits allowed), Auto (shell too). Switch mid-chat.
- **Slash-command skills** — `/simplify`, `/risk-scan`, `/pr-review`, `/person`, `/review-response`, `/land-pr`, `/pr-shepherd`. Type `/` to browse.
- **Native deliberation** — `/deliberate <task>` runs an Opus/Gemini debate with durable command admission. Repeated delivery does not repeat provider calls. If an attempt ends with an uncertain outcome, review the conversation before explicitly starting another with `/deliberate --confirm-ambiguous <task>`; this may repeat provider work. `/deliberate` alone shows usage.
- **Native fusion** — `/fuse <task>` runs a parallel panel, judge, and synthesis with durable admission; `/fuse --self <task>` uses two independent slots of the same model. Exact retries do not repeat provider work. Uncertain panel outcomes stop later phases; explicitly start another attempt with `/fuse --confirm-ambiguous <task>` (retain `--self` when applicable). Usage-only commands make no provider calls. See [fusion admission](docs/design/fusion-admission.md).
- **Voice** — tap to start/stop recording with live transcription previews (STT) and explicit per-message read-aloud (TTS) via [Yapper](https://github.com/dimakis/yapper). The final audio chunk is sent before transcription ends; if streaming disconnects or times out, the complete recording is transcribed through the batch endpoint. Cancelling discards the recording and releases the microphone. Voice features degrade gracefully when Yapper is offline.
- **MCP tools** — reads `~/.cursor/mcp.json`, passes servers to every session
- **File browser** — view and edit repo files, generated session artifacts, and worktree roots; Markdown links in existing conversations open in their original workspace, including `~/` home paths within allowed workspaces. Returning from a file keeps a disabled input placeholder visible while session type is checked; the ordinary composer and its queued-message effects mount only after the chat is confirmed as ordinary. In browsers, use Download in the file viewer, Markdown preview or message file links to save the original filename and bytes directly, even when the system share sheet is blocked. Use Share to send the original file or choose Save to Files on supported iOS devices; browsers without file sharing fall back to a download. Markdown retains its `.md` filename and document MIME type. File viewing and sharing support Vertex and both OpenAI API-key and subscription conversations, including OpenShell workspaces. Older sandbox conversations without a verified workspace record need one resume in the same conversation before file access; the workspace and file must still exist. Rollout requires updating the backend and the bundled iOS app.
- **Document editor** — Markdown and HTML source, preview and split views; Markdown formatting, undo/redo, keyboard shortcuts, unsaved draft recovery within the current browser tab, and a layout that follows the mobile keyboard. Saves preserve drafts on errors and detect changes made by agents or other editors. Review the latest saved version before choosing whether to use it or keep your draft for the next save. Vertex and host OpenAI files use the host workspace; API-key and subscription OpenShell documents save in the verified conversation workspace without host fallback. Sandbox editing requires the original document content and an available workspace.
- **Markdown diagrams** — Mermaid fences render in chat, Files, inline previews and document previews, with theme-aware SVG, copy controls, and readable source for invalid or incomplete diagrams. Expanded chat previews stay open across message and navigation updates.
- **HTML artifacts** — preview and edit self-contained `.html` prototypes from Files or expandable chat links in a sandboxed, no-network renderer
- **Task board** — recursive multi-session task orchestration with spec mode, completion summaries, and verification hooks
- **Mobile Telos collection** — long handover titles stay within two lines while the detail page retains the full summary. The collection uses the Connections style, with search, sorting, profile filters and 44px mobile actions; desktop Work keeps its single workspace heading and compact action bar.
- **Durable Telos capture** — agents can create approved outcomes and save versioned task documents in live Telos. `TelosSaveArtifact`, `TelosFindArtifacts`, and `TelosReadArtifact` provide upload and historical retrieval through trusted host tools/MCP; session instructions teach agents to recover prior work and retain persistence receipts. Documents and item links live in the canonical Telos SQLite store outside the sandbox; code remains in Git and reusable guidance belongs in knowledge. [Operating contract](docs/operations/telos-artifacts.md).
- **Work outputs** — each Telos work detail shows its latest saved file revisions before milestones and reference material. Markdown, archives, images and other file bytes use the same durable store (5 MiB per file); Download and Share target the exact listed revision without an active agent session. Native clients use Share. A saved output is not automatically reviewed or delivered. Folder snapshots and external destination tracking are subsequent slices.
- **Upload work files** — the Outputs upload drawer accepts non-sensitive documents and images up to 5 MiB. Choose file or use Camera to request rear-camera capture on supported phones, review the selection, then upload explicitly. Reusing a filename retains immutable revisions; failed uploads preserve the selection for retry. Credentials and private financial or health evidence require private case storage, not this shared output store.
- **Worktree sandbox** — opt-in git worktree isolation per session, multi-repo support via `.mitzo.json`
- **Session resilience** — phone sleeps, WS drops, session survives. Reattach on reconnect. Message snapshot recovery for iOS silent drops. Session opening coordinates live replay with the restored history cursor; expired approvals clear locally so later requests remain accessible.
- **Durable inactivity closeout** — automatic closeout is admitted once per detach episode before runtime dispatch. Exact retries and restart recovery never repeat paid provider work. See [closeout admission](docs/design/closeout-admission.md).
- **Closeout live canary** — an opt-in Luna-only harness validates one durable closeout attempt against an isolated controller and explicit billing account. See [closeout live canary](docs/operations/closeout-live-canary.md).
- **iOS app** — native wrapper via Capacitor with push notifications and home-screen install. Xcode 27 builds use a single storyboard-backed UIKit scene, required to launch on iOS 27; scene callbacks preserve Capacitor links and watch relay background/foreground handling.
- **Auto-rename sessions** — sessions get meaningful names via LLM summarization after every few prompts
- **Quick actions** — one-tap commands via `.mitzo.json`
- **Notifications center** — shared desktop/mobile feed for approvals, questions, session completions, and new Inbox arrivals, with native iPhone/Apple Watch delivery
- **Image attachments** — send photos/screenshots from your camera
- **Session history** — resume past conversations, swipe to dismiss
- **Managed Connections** — attach reviewed Jira, GitHub, and bounded custom REST providers to eligible accounts; publish GitHub pull requests through an approved controller operation

## Quick start

```bash
git clone https://github.com/dimakis/mitzo.git && cd mitzo
npm install
cp .env.example .env  # set AUTH_PASSPHRASE, AUTH_SECRET, REPO_PATH
npm run build && npm start
# http://localhost:3100
```

Access from your phone: install [Tailscale](https://tailscale.com/download) on server and phone, then open `http://<tailscale-ip>:3100`. No HTTPS needed — Tailscale encrypts via WireGuard.

### Managed Connections

**Connections** is the global overview of configured AI accounts and services. Compact rows open account and service details, configured models, and read-only Ask/Agent/Auto policy explanations. Mode availability is not inferred from a provider label; runtime and model compatibility remain unchecked unless reported by an authoritative source. Configured assignments, past verification, and effective conversation access remain separate. Detail drawers use the overview’s grouped cards, icon and account-use badge, with separate account, sign-in, and access sections. Labels and values stack on mobile; model and mode details use the same spacing and typography. Close or Escape returns focus to the row that opened the drawer. **Add connection** opens the existing management controls. Website access distinguishes provider search, public page reads, and sandbox network policies; effective network access depends on each sandbox’s base rules, attached connections, and chat-specific grants.

For ordinary ChatGPT accounts, **Sign-in** is separate from effective access. An OpenShell account shows **Connected** only after a read-only check of its bound provider and current, unexpired subscription grant. Its email and plan are labelled **Configured** because the broker does not report the host login identity. A host account can show **Signed in** after its existing account discovery verifies the reported email and plan. Checks age after five minutes (or earlier grant expiry); failed checks and failed overview refreshes are explicit. Loading the overview does not start a chat, create a sandbox, refresh credentials, or call a model.

Connections are optional and require the reviewed OpenShell gateway setup. Enable `MITZO_CONNECTIONS_ENABLED=1` and configure the provider probe policies from [`infra/openshell/production.env.example`](infra/openshell/production.env.example). The [Connections acceptance guide](docs/connections-live-acceptance.md) lists the gateway requirements and checks to run before enabling providers in production.

Open **More → Connections → Add connection** to choose a provider, enter its one-shot credential, review the exact scope, and assign eligible accounts. For GitHub, enter the repositories as `owner/repository` pairs and the allowed base branches. The GitHub sandbox provider remains read-only. Publishing a committed feature branch and creating or updating a pull request uses the separate `github.publish-pr` operation with an explicit approval. Set a controller-only `GH_TOKEN` or `GITHUB_TOKEN` to enable that operation; it is never injected into the sandbox. Custom REST is an advanced, bounded provider and remains unavailable until its reviewed gateway probe and DNS policy are configured.

After a connection is verified, expand **Manage capability grants** on its card, select the assigned profiles allowed to request a reviewed capability, and save the grant. Reauthorization is required to save or revoke a grant. A grant permits a profile to request the action; each invocation still needs explicit approval and is recorded in the capability operation audit. The setup wizard enables no mutation capability on its own.

For the existing Google Workspace provider, enable `MITZO_GOOGLE_WORKSPACE_MANAGEMENT_ENABLED=true` to show Google health and recovery controls in Connections. The controller must have `gws` installed with a working local Google sign-in. **Review Google account** shows that identity before **Reconnect Google** replaces the gateway's expired authorization. Both actions require recent Mitzo reauthorization. Credentials stay in the controller and encrypted gateway storage; the browser and chats receive only status and the reviewed account email. This recovery imports Drive and read-only Calendar consent; Gmail requires separate authorization. A revoked local Google grant must first be reauthorized through `gws`; this panel does not yet provide a new Google OAuth sign-in flow.

The reviewed Google profile allows Slides reads, presentation creation, and `batchUpdate` edits while preserving read-only enforcement for Drive, Docs, Sheets, and Gmail. Apply the reviewed profile to OpenShell as part of rollout: rebuilding Mitzo does not update an already registered gateway profile. Token status is checked separately from attachment, so an expired or revoked grant is never shown as healthy merely because the provider is attached. See the [Google management CLI contract](docs/google-workspace-cli-contract.md) for the primary gateway response shapes and the separate owned-gateway requirements.

If the service template catalog is temporarily unavailable, existing connections remain manageable. You can test, revoke, or rotate their credentials; new connection setup resumes when the catalog is available again. Credential rotation uses nonsecret form metadata returned with each existing connection, so it does not depend on loading the setup catalog.

## Architecture

```
Phone (Tailscale) ──┬── HTTP: REST API
                    └── WebSocket: v2 streaming protocol
                        │
                    Server (Node + TypeScript)
                        │
                        ├── query-loop: SDK events → v2 protocol
                        ├── session-registry: detach/reattach/snapshot
                        ├── MCP servers from Cursor config
                        ├── git worktrees (opt-in)
                        └── passphrase + JWT auth
```

The server translates raw SDK stream events into a v2 block lifecycle protocol (`block_start` → `block_delta` → `block_end`). Explicit turn boundaries (`message_start`/`message_end`), deferred finalization, and message snapshots for reconnect recovery. See [docs/design/message-protocol-v2.md](docs/design/message-protocol-v2.md).

The [durable child session allocation design](docs/design/session-service-core.md) describes the SessionService foundation for future bounded Task Board workers and Symposium seats. It records a child conversation and its parent/grant link in one transaction before runtime setup, fences cancellation across descendants, and retains uncertain starts or missing results for recovery. This foundation does not yet change the current Task Board or Symposium runtime paths.

Symposium shutdown fences new admission and dispatch, drains retained seat and login
cleanup, and awaits the owned gateway child before closing custody stores. A bounded
failure reports incomplete cleanup and retains recovery evidence. This does not enable
same-session artifact continuation across a new gateway custody lifetime. See the
[shutdown contract](docs/features/symposium-shutdown.md).

Codex Symposium turns now persist a host-only [completion checkpoint](docs/features/symposium-completion-checkpoints.md)
after matching terminal completion and confirmed controller cleanup. The checkpoint
binds the exact claimed delivered input and returned text; it is not an artifact,
review receipt, full-context commitment, or budget-enforcement proof. Recovery reads
never automatically redispatch a turn.

### Symposium director and portable profiles

Changing a draft seat to a model without a thinking-level option clears the previous
model’s thinking level, so selecting Work Vertex Haiku after Personal Luna remains valid.

The mobile and desktop ChatViews include **Review team & approvals** for the Symposium
roster and directed-delivery approval. Use **Refresh review team** to load
newly queued deliveries while the panel is open. The conversation view offers
an all-seat audience, per-seat asides, and explicit excerpt sharing; queued
messages require approval before dispatch. Uncertain retries retain the original
request key for each audience and excerpt.

Start a fresh session with **New Symposium** from either ChatView, without first
sending an ordinary chat prompt. Select the dedicated Symposium account/model,
a supported coder or reviewer role, and an exact saved profile revision; the
profile picker also supports creating or importing a profile. **Create Symposium
draft** allocates only durable session and roster metadata. Review the draft and
acknowledge its boundary in Review team & approvals before activation; all production
admission checks still apply. Retried creation requests reuse the same session.
An explicitly installed owned host also prepares a private named artifact volume for
new drafts. If preparation is unavailable, the draft remains saved and the creation
panel offers **Retry shared files** or **Open draft**. Volume readiness alone does
not activate a seat or satisfy the separate runtime admission gate. See the
[session artifact lifecycle](docs/features/symposium-session-artifacts.md).

Ordinary chat send/interrupt routes cannot execute a configured Symposium, and
converting an existing ordinary conversation requires stopping it first.

Use **Add reviewer** in an existing conversation to choose a saved profile,
account/model, and an explicit review package (objective, acceptance criteria,
repository instructions, relevant diff/source, tests, and selected decisions).
Independent review is the default and includes no earlier conversation. Optional
context choices are an operator-written summary, selected shared excerpts, or
all proven shared excerpts. Only delivered broadcasts to every active member at
creation are eligible; private asides, queued inputs, and legacy turns without
audience proof are excluded. Edited deliveries contribute their delivered text.
The three setup sections explain the reviewer profile/account, the request and
conversation context, and sharing consent. After adding a reviewer, use **Go to
review approvals** to open and refresh this conversation's team panel, including
when it is already open. Requests appear before
team configuration, with agent names and **Needs approval** or **Approved — ready
to send** status. Choose **Approve** (or **Edit and approve**), then **Send approved
request** to start the review. Use **Open review findings** for the results.
The package is queued for approval, never automatically dispatched. **Queue
message for approval** creates a follow-up for explicitly selected agents. Advanced
context import is in a collapsed disclosure. Context source grants default to empty; a reference does not itself load conversation
history. Shared workspace access remains governed by the read-only host grant.

Adding a reviewer can prepare a stopped ordinary conversation's isolated roster,
but admission still requires the verified runtime. Roster changes revalidate
existing confirmed seats at the new configuration revision without resetting
their membership generations or sandbox identity. A partially completed setup
remains visible in Review team & approvals. Removing the last reviewer simplifies the
composer while preserving durable membership history and isolated routing; it
never switches the session back to ordinary execution. The development-only
`ui-preview.html` includes read-only reviewer choices for visual checks.

Portable profiles save immutable revisions of guidance, expected output, and
acceptance criteria. Select an exact revision for a seat, or export/import its
JSON; older revisions remain selectable after later revisions are saved. Revise
the latest version to create a new one. Conversational profile proposals require
operator review before saving. Profiles do not carry account credentials or
execution authority; those are bound separately by host-issued grants.

These implemented controls remain subject to runtime admission. The default server has no Symposium
provider runtime: activation and grant reissue fail closed until a trusted runtime
is installed. These controls do not enable production native seat execution.

Native OpenAI API and personal ChatGPT seats can read Mitzo's saved portable
profile catalog and draft profile updates with session tools. Drafts are persisted
in the session's review queue; only an explicit user **Save** creates an immutable
catalog revision, with revision conflict checks. Rebinding a seat remains a
separate director action. These tools recheck the current seat, durable attempt,
account route, and host grants before each call. Reviewer seats may propose
portable guidance for review but cannot save profiles or mutate shared artifacts.
Claude's profile-authoring tool path remains unavailable; its reviewed Vertex
launcher exposes only the explicitly selected native tool set. Mitzo owns profile authoring and version history; ContexGin remains a
context source, with explicit imports rather than implicit write-back.

The seat Landlock launcher permits read-only access to the supervisor's two public
CA certificate files under `/run/openshell-supervisor-ca/material`; it grants no
access to that directory, private keys, or other `/run` content. The
[offline CA regression](docs/spikes/openshell-codex/SEAT-PUBLIC-CA.md) records the
physical denial and the bounded fix. Existing runtime images must be rebuilt and
reviewed before this source change can affect them.

The disposable native-seat image now normalizes the reviewed Linux arm64 Codex
0.153.4 package to a regular `/usr/bin/codex` ELF during its build. This aligns
kernel executable identity with the existing exact-path network policy; it adds
no binary grants. See the [canonical native image proof](docs/spikes/openshell-codex/CANONICAL-CODEX.md).
The host device-login CLI version is separate and unchanged.

The [reviewed canonical native build](docs/features/symposium-reviewed-native-build.md)
records exact image/artifact pins and the attended Luna two-turn stream, replay and
cleanup evidence. Its pin update still requires all existing host, provider,
policy and physical admission checks; full application acceptance remains pending.

### Fresh owned-custodian release preparation

The explicit [owned-custodian preparation command](docs/operations/symposium-owned-release-preparation.md)
validates a fresh private configuration and reviewed runtime tuple without starting
providers. It emits a manual-start plist with no parent auto-restart and a durable
one-shot launch guard. Default ordinary deployment is unchanged. Existing production
state migration, parent recovery and database rollback remain unsupported by this path.

### Symposium native execution contracts

Native seat adapters route Codex and Claude through OpenShell and bind streamed
events and provider-confirmed receipts to an exact delivery claim. A private
host attempt registry records setup before launch and retains uncertain native
attempts across restart. Cleanup releases a claim only after proving it never
launched or confirming that its exact controller has stopped. Pending provider
detaches also survive reconciliation failure until attachments are verified.
The runtime supplies durable transcript recording by default, including early
events and closure after failure or cancellation; live broadcasting is optional.
Persisted native events retain their claim identity so confirmed restart cleanup
can close the exact unfinished transcript without inventing a successful result.
Transcript restore ignores recipient dispatch/thread-migration bookkeeping rather
than treating its recipient ID as message authorship. Unverifiable message attribution
still rejects the restore with a controlled HTTP error; it cannot terminate the server.

Both chat views now offer **Open review findings**. The application persists
review workflows and history, displays severity only when the reviewer reports it,
and requires explicit artifact-bound fix or dismissal
decisions, and requests delta review after a fix. Select an older workflow to read
its ordered decisions, reasons and evidence, or start a separate review of the current
artifact without losing that history. A verified current revision can
produce a PR review record; this action does **not** create or publish a PR.
Records are immutable host-stored snapshots with a content-derived ID and SHA-256
hash, binding the verified artifact to its exact workflow/history and evidence.
Repeated export of the same snapshot returns the same record; changed verified
history produces a new one. **Open saved review record** requires the Mitzo login
and remains available after runtime shutdown. Copy **Permanent saved review link**
to reopen the authenticated snapshot after a refresh or later visit. No record file is added to the
reviewed Git tree. See [immutable review records](docs/design/immutable-review-records.md)
for scope, integrity, and export limits.
Interactive callers cannot submit fabricated findings, usage, or verification:
the coordinator reads those facts from completed trusted host receipts.

This interface is wired into the application, but native review/fix execution
remains unavailable until a trusted adapter supplies enforced token budgets,
terminal usage, structured results, and artifact-bound verification. The panel
reports the missing capability rather than falling back to ordinary chat. Mocked
integration coverage establishes the workflow boundaries, not live production
readiness. Reviewer and Claude admission require independent host attestation
and live acceptance; environment settings alone do not enable them. See the
[integration gaps](docs/features/symposium.md#review-records-and-publication-boundary).

A dormant Symposium publication executor now composes the existing forced-approval
capability service with the saved review record, exact committed tree, current
writer/session/grant authority, and a mandatory completed host publication seal.
It revalidates those bindings after approval and uses read-only recovery for an
ambiguous external outcome. It is **not installed in the live host**: a pending
seal intent or unfenced Git observation cannot satisfy its seal contract. Trusted
hard-budget review execution and physical seal completion remain prerequisites.

### Symposium OpenShell 0.1 per-seat runtime

[Native create receipts](docs/operations/symposium-native-create-receipts.md) separate
terminal native creation from upload and configuration. An incomplete known-ID
seat remains cleanup-only; old unknown creates and restart adoption remain blocked.

The experimental 0.1 runtime gives each seat generation its own sandbox and exact
provider attachment inside one OpenShell workspace. Mitzo retains one conversation
view and routes each seat to its own sandbox. Reuse rechecks the physical sandbox
identity and provider attachments; uncertain creation or cleanup keeps the seat
reserved until reconciled. This path uses upstream OpenShell contracts without a
private gateway patch.

Shared artifacts use an explicitly admitted named volume, mounted read-write for
a writer and read-only for a reviewer. Host-side leases fence writers, verify the
physical mount, and release only after gateway and compute-host deletion proof.
Exact release receipts allow cleanup to finish after a crash without releasing a
replacement lease. Cleanup uses the retained sandbox and original lease identity even
after seat removal, suspension, or role changes; current authority is still required
for new admission.

Production remains disabled by default. A trusted server bootstrap must install
matching host attestation for the selected CLI, gateway, images, policy, provider
profiles, seed and artifacts. Attestations must map each exact provider instance
name, ID and type to its reviewed profile; the host must verify that association
in the selected workspace. Missing instance mappings or physical proof fail closed.
The legacy attestation scope is OpenAI writer roles. The separate owned-native
contract includes personal Codex and reviewer capability when all of its physical
and authorization gates pass. Claude via Vertex requires the separate measured
Claude image variant and a retained, same-custodian selected-provider receipt;
legacy attestations cannot enable it. An experimental [personal ChatGPT seat route](docs/features/symposium-chatgpt-subscription.md)
uses upstream Codex provider attachments and a private native authentication bootstrap.
It rejects the older private-gateway OAuth binding and host login imports, and keeps
subscription production admission closed pending independent account, credential
isolation and live acceptance evidence. An optional dedicated host, configured with
`MITZO_SYMPOSIUM_OWNED_HOST_CONFIG`, starts a digest-pinned unmodified upstream
gateway with private management authentication and physical native-image and
volume verification. `MITZO_BIND_HOST=127.0.0.1` can restrict the application
listener for local staging. Its Symposium account catalog is separate from regular
chat accounts; unavailable accounts never fall back to a work account. The owned
contract includes writer/reviewer and personal-seat capability, but still requires
independent account authorization and all production evidence gates. See
[dedicated gateway operation](docs/operations/symposium-owned-gateway.md) and the
[per-seat runtime handoff](docs/spikes/openshell-codex/SYMPOSIUM_PHASE3_HANDOFF.md)
for the architecture and remaining gates. Installing this code does not upgrade
or enable the active gateway.

The [feature-stack implementation and acceptance record](docs/features/symposium.md)
describes the composed Add reviewer/context UI, immutable review records,
publication preflight, and session artifact preparation. It distinguishes mocked
application coverage from the attended two-turn native
`gpt-5.6-luna` smoke. The smoke verified streaming, replay, exact replies and
probe cleanup; it did not establish full application or production admission.
Multiple personal account slots and explicit supported-model refresh are
implemented. Saved metadata survives restart, but personal authorization requires
fresh sign-in. The CA-enabled image must match the reviewed build pins and physical proof
before it can satisfy the production gate.

### Packages (`packages/`) — npm workspace

Mitzo uses an npm workspace with three internal packages shared between server and frontend:

| Package           | Purpose                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mitzo/protocol` | Core protocol types, Zod schemas (v2 WS messages, API schemas), tool summarization, event store definitions                                                      |
| `@mitzo/harness`  | Session registry, connection registry, permission handler, worktree guard, tool tiers, skill policy, auto-rename, notifications, logger                          |
| `@mitzo/client`   | Frontend state management: `MitzoConnection` (single multiplexed WS), Zustand store (`createMitzoStore`), v2 protocol parser, session switching, message reducer |

### Backend (`server/`)

**Core** — Event streaming, session lifecycle, SDK integration

| File                    | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `query-loop.ts`         | SDK → v2 event translator. Deferred `message_end`, snapshot state, block lifecycle. |
| `chat.ts`               | Agent SDK `query()`, prompt assembly, streaming-input queue, session restore API    |
| `session-registry.ts`   | Session state: detach, reattach, rekey, TTL abort, snapshot storage                 |
| `session-service.ts`    | Durable child allocation, host grant, cancellation, and start reconciliation ledger |
| `permission-handler.ts` | `canUseTool` callback — auto-allow by tier, prompt via WS + push notifications      |
| `async-queue.ts`        | `AsyncIterable` queue for follow-up messages and interrupt                          |

**Skills** — Slash-command system

| File                 | Purpose                                                                           |
| -------------------- | --------------------------------------------------------------------------------- |
| `skills.ts`          | Skill registry — scoped discovery, precedence, collisions                         |
| `slash-commands.ts`  | Slash-command parsing and prompt expansion                                        |
| `skill-policy.ts`    | Per-turn tool restriction from skill frontmatter                                  |
| `native-commands.ts` | Built-in native commands (`/skills`, `/models`, `/close`, `/deliberate`, `/fuse`) |

**Task Board** — Multi-session orchestration

Tasks with `sessionPolicy: spawn` run only in dedicated sessions. When session spawning is disabled, the workflow pauses with that task pending; a failed spawn blocks the task. Background workflows do not select an attached chat automatically.

`POST /api/loop/start` accepts `{ "goalId": "...", "specMode": false, "sessionId": "..." }`. The `sessionId` names the existing chat explicitly selected by the user; the server resolves it to the chat's driver client ID. Low-level callers may supply that driver `clientId` directly. A selected chat is required for spec mode and for any pending `reuse` task (or `auto` task while spawning is disabled), including later stages of the goal. A workflow containing only dedicated `spawn` tasks can omit it. `GET /api/loop/status` reports whether spawning is enabled. If a chat is needed but missing, the start API returns HTTP 422 with `code: "client_id_required"` and leaves the goal pending. Agents cannot infer a suitable existing chat from the list of connected sessions: the user must select one through the Task Board UI or supply its `sessionId` to the API. Ordinary chat reconnection uses session IDs independently of this endpoint.

| File                   | Purpose                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `task-store.ts`        | SQLite persistence: tree queries, cascade status, DFS ordering, orphan detection. WAL mode. |
| `task-orchestrator.ts` | Event-driven state machine (idle/running/paused), DFS sequential task assignment            |
| `task-tools.ts`        | Pure handler functions for agent task tools (TaskSet, TaskComplete, TaskStatus, TaskBlock)  |
| `task-context.ts`      | XML task context builder for system prompt injection                                        |
| `task-mcp-server.ts`   | Stdio MCP server exposing task tools as `mcp__task-board__*`                                |

**Worktrees & Session Isolation**

| File               | Purpose                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `worktree.ts`      | Git worktree lifecycle: create, remove, cleanup stale (scans `.claude/` and `.cursor/`)                               |
| `session-index.ts` | YAML session index at `<repo>/.claude/sessions/index.yaml`. Tracks active/closed sessions with repo worktree mappings |

**Observability**

| File                | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `logger.ts`         | Pino structured logging: JSON output, daily rotation, OTel trace context mixin, Loki integration |
| `tracing.ts`        | OpenTelemetry: BatchSpanProcessor, OTLP HTTP exporter to Jaeger                                  |
| `trace-context.ts`  | Trace context utilities                                                                          |
| `health-monitor.ts` | Service health monitoring (Yapper, ContexGin)                                                    |

**Notifications**

| File                      | Purpose                                      |
| ------------------------- | -------------------------------------------- |
| `notify.ts`               | ntfy push notifications                      |
| `pushover.ts`             | Pushover (Apple Watch) notifications         |
| `apns.ts`                 | Apple Push Notification Service (iOS native) |
| `notification-helpers.ts` | Shared notification formatting utilities     |

The authenticated `/notifications` page uses a durable local SQLite feed at
`.mitzo/notifications.db`. Desktop navigation and mobile **More** show the number
of unresolved requests, rather than the size of an unread backlog. Reading an
item does not grant permission; a response on any client resolves the shared
request. Expired or already resolved requests cannot be approved. Conversation
access grants must be reviewed in the session; ordinary requests support **Allow
once**, **Deny**, and structured question answers.

Preferences control native APNs approvals, questions, completion alerts
(unattended by default, all sessions, or off), preview privacy, and quiet hours
in an explicit timezone. Quiet hours defer pushes while requests retain their
existing deadlines. Lock-screen previews are generic unless enabled. New Inbox
POSTs appear in the feed; proposals and existing files do not trigger push or a
historical replay. This does not change existing ntfy/Pushover configuration.

Configure the existing `APNS_*` environment variables and register an iPhone to
enable native delivery. Push taps open the corresponding notification, session
completion alerts retain inline replies, and badge-only pushes use Apple's
[alert push type](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
The new native badge bridge also clears the icon to zero on authenticated refresh.
The preferences screen shows server/device readiness and offers a real test alert;
APNs acceptance is not proof of physical delivery. iPhone permissions, Focus,
and Watch mirroring settings determine what reaches the wrist.

The Watch app's **Notifications** entry loads the latest ten items through the
paired iPhone's authenticated relay, shows full request details, and supports
ordinary one-shot approval or denial. Questions and conversation access grants
are reviewed on iPhone. Oversized relay payloads fail with a request to review on
iPhone, rather than truncating approval details. A reachable paired iPhone is
required. Ship an updated iOS/Watch binary for the new native entry and badge
bridge; a web deployment alone cannot update installed native code.

| File                     | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `notification-store.ts`  | Durable feed, read state, delivery queue, and preferences                 |
| `notification-center.ts` | Permission lifecycle, session completion events, and APNs delivery policy |
| `notification-routes.ts` | Operator-authenticated feed and response API                              |

**WebSocket & Transport**

| File                | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `ws-handler-v2.ts`  | v2 WebSocket message dispatcher: hello handshake → session routing |
| `ws-transport.ts`   | `SessionTransport` adapter wrapping WebSocket connections          |
| `null-transport.ts` | Null transport for testing                                         |
| `ws-schemas.ts`     | Zod schemas for WebSocket message validation                       |

**Supporting**

| File                    | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `tool-tiers.ts`         | Risk classification + mode/tier auto-allow matrix |
| `tool-summary.ts`       | Summarizes tool inputs for pill display           |
| `permissions.ts`        | Request/response registry                         |
| `content-blocks.ts`     | SDK content block parsing                         |
| `event-store.ts`        | Persistent event store for session replay         |
| `auto-rename.ts`        | LLM-based session auto-renaming                   |
| `hook-bridge.ts`        | Project hooks → Agent SDK bridge                  |
| `api-schemas.ts`        | Zod validation schemas for HTTP                   |
| `mcp-config.ts`         | Loads Cursor MCP config                           |
| `repo-config.ts`        | `.mitzo.json` reader                              |
| `app.ts`                | Express app factory (testability via supertest)   |
| `inbox.ts`              | Inbox integration endpoint                        |
| `internal-token.ts`     | Internal token generation for inter-process auth  |
| `auth.ts`               | Passphrase + JWT                                  |
| `git-version.ts`        | Local/remote commit comparison                    |
| `port-check.ts`         | Prevents duplicate server instances               |
| `constants.ts`          | Server-wide constants                             |
| `index.ts`              | Express app, HTTP server + WebSocket              |
| `goal-client.ts`        | ContexGin Goal Registry client                    |
| `progress-tracker.ts`   | Progress tracking utilities                       |
| `prompt-compare.ts`     | Prompt comparison utilities                       |
| `workflow-templates.ts` | Workflow templates                                |
| `workload-store.ts`     | Workload persistence                              |
| `session-overview.ts`   | Session overview API                              |
| `signal-processor.ts`   | Signal processing utilities                       |

### Frontend (`frontend/`) — React 19 + Vite

React 19 + Vite. Ten pages (`Login`, `SessionList`, `ChatView`, `DesktopChatView`, `FileViewer`, `InboxView`, `CalendarView`, `TodoView`, `TodoDetailView`, `TaskBoard`), a `useReducer`-based message state machine (`useChatMessages`), module-level WebSocket pool with 500-message buffer, and components for thinking blocks, tool pills, tool groups, permission banners, and a slash-command picker. Capacitor wraps the frontend for iOS deployment via TestFlight.

The chat composer gives draft text the full width, with context information and action controls on separate rows. Session resources open from the toolbar; commands, attachments, and workspace options collapse into More in narrow composers while recording, interrupt, and send controls remain directly available.

For iOS development, run `./scripts/build-ios.sh` to build the iOS web assets and open Xcode. After the build, `./scripts/build-ios.sh --sync` copies the existing `frontend/dist-ios` assets into the iOS project without rebuilding them.

**Key Hooks:**

- `useChatMessages` — v2 protocol message reducer (MESSAGE_START/BLOCK_START/BLOCK_DELTA/BLOCK_END/TOOL_RESULT/MESSAGE_END/SESSION_END/MESSAGE_SNAPSHOT/RESTORE)
- `useTaskBoard` — task CRUD + loop control + WS subscriptions
- `useVoice` — STT (push-to-talk) + manual TTS (voice selection, sequential chunk playback)
- `useFileNavigation` / `useFileEditor` — file browser and editing
- `useSessionOverview` — session metadata and statistics
- `useServiceHealth` — health status for Yapper, ContexGin

**Key Components:**

- `MessageBubble` (UserBubble/TextBubble), `ThinkingBlock`, `ToolPill`, `ToolGroup`, `PermissionBanner`, `ChatInput`, `SlashPicker`
- `TaskNode`, `TaskCreateForm`, `LoopControls`, `TaskSidebar` — task board UI
- `VoiceSettings` — read-aloud voice picker grouped by language
- `SessionOverview` — session metadata card
- `ContextPanel` — boot context viewer
- `FileBrowserPanel` — file tree navigation

## Environment

| Variable                        | Description                                                    | Required |
| ------------------------------- | -------------------------------------------------------------- | -------- |
| `AUTH_PASSPHRASE`               | Login passphrase                                               | Yes      |
| `AUTH_SECRET`                   | JWT signing key (min 32 chars)                                 | Yes      |
| `REPO_PATH`                     | Default repo for sessions                                      | Yes      |
| `PORT`                          | Server port (default: `3100`)                                  | No       |
| `COOKIE_MAX_AGE_HOURS`          | JWT cookie lifetime in hours (default: `24`)                   | No       |
| `WORKTREE_ENABLED`              | Allow worktrees (default: `true`)                              | No       |
| `MITZO_WORKTREE_CLEANUP_POLICY` | Stale cleanup policy: `report` (default) or `execute`          | No       |
| `MCP_CONFIG_PATH`               | MCP config path (default: `~/.cursor/mcp.json`)                | No       |
| `LOG_LEVEL`                     | Log verbosity: `debug`, `info`, `warn`, `error`                | No       |
| `LOG_FILE_PATH`                 | Log file path (default: `logs/server.log`)                     | No       |
| `LOGGER_SYNC`                   | Set to `1` for synchronous logging                             | No       |
| `BASE_URL`                      | Public URL for notification deep links                         | No       |
| `YAPPER_PROXY_TARGET`           | Yapper backend URL (default: `http://localhost:8700`)          | No       |
| `CLAUDE_CODE_USE_VERTEX`        | Set to `1` to use Vertex AI for auto-rename                    | No       |
| `ANTHROPIC_VERTEX_PROJECT_ID`   | GCP project ID (required when using Vertex)                    | No       |
| `CLOUD_ML_REGION`               | GCP region for Vertex (default: `us-east5`)                    | No       |
| `NTFY_URL`                      | ntfy server URL (default: `https://ntfy.sh`)                   | No       |
| `NTFY_TOPIC`                    | ntfy topic for notifications                                   | No       |
| `NTFY_AUTH_TOKEN`               | ntfy auth token                                                | No       |
| `PUSHOVER_API_TOKEN`            | Pushover API token (for Apple Watch notifications)             | No       |
| `PUSHOVER_USER_KEY`             | Pushover user key                                              | No       |
| `APNS_KEY_PATH`                 | Path to Apple Push Notification Service .p8 key                | No       |
| `APNS_KEY_ID`                   | APNS key ID                                                    | No       |
| `APNS_TEAM_ID`                  | Apple Team ID                                                  | No       |
| `APNS_BUNDLE_ID`                | iOS app bundle ID (default: `com.mitzo.app`)                   | No       |
| `APNS_PRODUCTION`               | Use production APNS (default: `true`)                          | No       |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | OpenTelemetry OTLP endpoint (e.g., `http://localhost:4318`)    | No       |
| `LOKI_HOST`                     | Grafana Loki endpoint (e.g., `http://localhost:3200`)          | No       |
| `TRACE_CONTENT_MAX_CHARS`       | Max chars for trace content (default: `16384`)                 | No       |
| `CORS_ALLOWED_ORIGINS`          | Comma-separated CORS origins                                   | No       |
| `CONTEXGIN_URL`                 | ContexGin Goal Registry URL (default: `http://localhost:8321`) | No       |
| `MITZO_INTERNAL_TOKEN`          | Auto-generated token for inter-process auth                    | No       |

See `.env.example` for a starter template.

## `.mitzo.json`

Drop this in your repo root to customize the home screen, enable multi-repo sessions, and inject domain knowledge:

```json
{
  "quickActions": [
    {
      "label": "Run Tests",
      "desc": "Full suite",
      "prompt": "Run tests and report.",
      "extraTools": "Bash"
    }
  ],
  "repos": [{ "name": "sibling-repo", "path": "../sibling-repo" }],
  "contextBlocks": {
    "Architecture": "/path/to/architecture.md"
  },
  "venvPaths": [".venv/bin"]
}
```

- **quickActions** — one-tap buttons on the home screen
- **repos** — sibling repos for multi-repo worktree sessions (each gets its own isolated worktree)
- **contextBlocks** — markdown files injected into every session as domain knowledge
- **roots** — switchable repo roots in the file browser
- **venvPaths** — Python venv paths added to `PATH`

See [docs/onboarding.md](docs/onboarding.md) for a full configuration walkthrough.

## Development

### Documentation policy

Every pull request reviews this README. Pull requests that change production code
must update it when they affect installation, configuration, commands,
architecture, supported integrations, or user-visible behavior. A PR that does
not need a README change must record the reason in its PR description; CI checks
both the review acknowledgement and that exception.

```bash
npm run dev          # backend + frontend concurrently
npm test             # vitest — full suite
npx playwright install webkit chromium # first-time browser test setup
npm run test:browser  # Connections scrolling in mobile WebKit and desktop Chromium (mocked APIs)
npm run lint         # eslint
npm run format:check # prettier
```

Production artifacts are staged with
`./scripts/stage-openshell-release.sh <mgmt-repo> <new-seed-output>`. It requires
clean Mitzo and MGMT checkouts at current `origin/main`, then builds and verifies
the immutable image and seed, updates the stack lock and environment example
together, and runs focused tests. It never deploys; its generated diff is
reviewed and merged first.

A completed retained-runtime migration preserves its original checkpoint history while
allowing supported model changes within the same account and provider. Provider and grant
authority changes still block reopening. Connection reservations protect sandbox setup
and are released before first-turn admission reacquires the current grants, so a cold
chat start does not wait on its own setup lock.

Enrolled Codex chats report unavailable knowledge publication as an admission failure:
an admitted follow-up remains queued, and no provider turn starts until the publisher is healthy.
Check the publisher and retry the saved message. Deploy/start preflight also requires
working host Git with an executable HTTPS helper when a knowledge store is configured.
Deployment preflight uses the candidate launchd service PATH before restarting; the publisher's independent Git installation and
service PATH must also work. On macOS, resolve toolchain/license configuration or install
a working Git in the service PATH before releasing. The preflight does not accept licenses
or change host tools automatically.

The [MGMT knowledge publication contract](docs/operations/mgmt-knowledge-publication.md)
defines an independent publication lane for compatible knowledge. The MGMT
publisher extracts the complete builder bundle from a pinned Mitzo commit and
passes compatibility fields from that commit's runtime lock. Each publication
binds exact source, content hashes and modes, compiler/recipe identities and
runtime inputs in a trusted record; knowledge A and B can share one runtime
without changing a fixed application payload pin. Ordinary new seed uploads
verify the selected publication and use a private verified copy. The checked-in runtime lock records actual compiler, protected write boundary,
frozen-input and target-marker attestation from the accepted-source runtime.
This release metadata does not itself activate publication or enroll a consumer.
Retained ordinary Codex chats can select a verified publication between turns,
copy it into a separate versioned knowledge directory, and refresh the existing
provider thread's per-turn application context. Their writable task Git and checkpoint
history remain intact. Cached views are verified before reuse; a damaged selected
cache is replaced from the verified publication before compilation, preserving
task files and unrelated versions. The pinned ContexGin compiler includes tracked `AGENTS.md`.

Ordinary Codex tool-surface replacements preserve the canonical parent until a matching provider turn acknowledgment. Unknown post-dispatch outcomes block reopening; the [unpersisted-thread recovery contract](docs/operations/unpersisted-codex-thread-recovery.md) documents the exact scoped legacy quarantine and its preservation guards.

Runtime staging fingerprints the installed compiler dependency closure and recipe
and observes the target Python markers inside the image. These paths require a
reviewed dynamic runtime lock and enrollment at `publications/current/mgmt`;
legacy deployed environments remain unenrolled until explicitly migrated. Host, Claude, Responses and
Symposium consumer enrollment still require their respective adoption contracts.

Set host-only `MITZO_KNOWLEDGE_STORE_CONFIG` to enroll ordinary OpenShell Codex
chats in the configurable ContexGin publisher bridge. The selected store identifies
its accepted Git source and a clean pinned `mgmt-v1` adapter release. A signed
GitHub webhook wakes publication; sandbox creation and safe-turn admission also
reconcile the accepted ref, verify its snapshot and wait for exact revision
conversion. Frozen upload copies preserve the publication’s verified bytes and
file modes inside a private host directory, including under a restrictive host
umask. Provider acknowledgement records an account-scoped durable adoption
receipt. Shared knowledge updates preserve writable task branches and dirty
worktrees. This requires supervised publisher storage, adapter dependencies and a
compatible reviewed runtime; configuration alone cannot upgrade a legacy image.
See the operating contract for the configuration schema and delivery scope.

Supported retained ordinary Codex sandboxes migrate at resume or a completed-turn
admission boundary into an attested candidate. The transition preserves dirty and
untracked task Git state, the provider thread/account route and queued FIFO, and
keeps the original sandbox and immutable checkpoint. Read-only profile catalog
admission uses the deployed CLI’s scoped `provider list-profiles --output json`
command, with exact reviewed definitions and the same initial/final fences. Actual image/policy, ordinary
ownership, idle provider activity and measured host/VM capacity must verify; unknown
source contracts and unsupported Git/provider layouts remain visibly blocked.
Runtime admission verifies the full effective policy against reviewed provider
profiles and current approved attachments, including brokered OpenAI, automatic
GitHub and approved Google Workspace layers. Serializer defaults do not erase
credential inspection or unexpected permissions. Migration preserves the original
base-policy checkpoint identity and records separate effective-policy provenance.
Current runtimes retain normal provider recovery without entering migration. See
[retained runtime migration](docs/operations/retained-runtime-migration.md) for
transaction recovery, eligibility and rollout drain requirements.

Ordinary Codex startup holds its lifecycle reservation through sandbox recovery
and provider-thread registration, then releases it before the first queued turn
reacquires admission for runtime and knowledge checks.

Production deploys use `./scripts/create-release.sh origin/main`. The command
fetches only current `origin/main`, refuses every other commit, creates a
self-contained detached release clone, records full commit/tree/base provenance
in `release.txt`, and only then builds and updates launchd. `scripts/deploy.sh`
fails closed when those invariants are absent.
For releases built from a clean automation checkout, set `MITZO_RUNTIME_ROOT`
to the canonical installation that owns `.env` and `certs`; runtime material
is never taken from the feature checkout. Paths for checked-in stack locks,
policies, and provider profiles are rewritten to the immutable release so a
copied environment cannot mix code from two deployment generations.
When advancing the prepared MGMT seed, set `MITZO_RELEASE_SEED` to its `mgmt`
directory. Release creation requires the sibling `baseline.json` and changes
only the new release's copied `.env`, leaving the canonical runtime `.env`
untouched.

Before builds or service changes, deployment compares the installed LaunchAgent's
persisted knowledge enrollment with the candidate dotenv/plist settings. An
existing enrollment cannot silently disappear or change stores, and an enrolled
candidate must retain its publisher read credential; credential rotation is
allowed. Fresh and already unenrolled hosts remain valid. For a deliberate
transition, review the staged settings and run
`npm run deploy -- --allow-knowledge-enrollment-change` from the accepted release.
This per-invocation opt-out does not bypass runtime preflight or required
credential presence. Preserve canonical private host settings between releases;
[the deployment guard contract](docs/operations/mgmt-knowledge-publication.md#preserve-enrollment-during-deployment)
explains supported dotenv loading, fixed nonsecret diagnostics and the limits of
comparing current on-disk configuration.

Pre-commit: husky + lint-staged + commitlint (conventional commits). The hook also runs [gitleaks](https://github.com/gitleaks/gitleaks) if installed, scanning staged changes for secrets. gitleaks is **optional** — the hook skips it gracefully when not found. Install via `brew install gitleaks` (macOS) or see the [gitleaks docs](https://github.com/gitleaks/gitleaks#installing).

## Tech

Node.js, Express, React 19, Vite, TypeScript, Claude Agent SDK, Vitest, ESLint, Prettier.

## Attribution

Evolved from [claude-command-center](https://github.com/Afstkla/claude-command-center) by [Afstkla](https://github.com/Afstkla). The original used tmux; Mitzo uses the Agent SDK directly.

## License

MIT

### macOS runtime startup

The Podman launch agent preserves the VM process group after `podman machine start` exits. Without `AbandonProcessGroup`, launchd terminates those child processes and OpenShell sandbox startup fails even though the start command reports success. After installation, verify `podman info` still succeeds once the launch agent has exited. Use the production `com.mitzo.server` launch agent as the sole supervisor for Mitzo; stop and remove legacy PM2 startup entries before handing over the listening port.

The OpenAI Responses route uses bearer authentication in the Authorization header. Its base policy and gateway provider profile must disable request-body credential rewriting and retain enforced REST inspection. This requires a supervisor with the identity-aware streaming guard: literal placeholder examples in documents must pass unchanged, while actual credential identities in model input remain blocked. Production preflight checks both the configured base policy and live provider profile. Qualify the supervisor and policy together; changing only the policy on an older supervisor reintroduces documentation-triggered denials. Existing sandbox containers retain their supervisor image across stop/start and need a separately verified migration.

Symposium's [reusable reviewer profiles](docs/features/symposium.md#profiles-and-reusable-reviewer-recipes) include five editable starters, versioned portable context recipes, skill/tool references and provider compatibility. Import/export preserves exact revisions; applying a profile and selecting account/context remain explicit.

Symposium account selection also includes [guided personal subscription login](docs/operations/symposium-owned-gateway.md#in-app-personal-account-setup), with explicit local/SSH callback preparation, phone guidance and credential-free login status receipts.

Personal ChatGPT [device sign-in](docs/operations/symposium-device-auth.md) is available from **Connections → Personal ChatGPT accounts**
and Symposium reviewer setup. Enable device-code authentication in ChatGPT
Settings → Security, request a code, then open OpenAI on the phone or computer.
The running Mac host completes the connection; the UI shows verified account
identity and supports cancel, status recovery, and explicit reconnect. Connections
keeps multiple labeled personal account entries with separate Connect, Reconnect,
and Disconnect controls. Saved identities remain after restart; accounts marked
**Sign in required** need fresh authentication. Connecting does not select a
reviewer account/model or silently rebind an active seat.

Login receipts are private to the initiating authenticated session, and credential cleanup must complete before success. A separately signed-in browser cannot recover or cancel another session’s pending code.

Personal Symposium Connections support separate saved account slots with explicit
connect, reconnect, and disconnect. Connection transitions sync the private metadata file and its parent directory before credential lifecycle operations proceed. Persistence failure fences the connection for recovery. Saved metadata survives restart; account
authorization does not. See [personal connection lifecycle](docs/operations/symposium-personal-connections.md).

Personal login requires selecting a saved connection and displayed revision, including callback alternatives. Credential cleanup waits for owned-workspace sandbox creation to settle; uncertain creation stays blocked across restart.

Owned sandbox creation records uncertainty at the external dispatch boundary; read-only preflight failures do not strand credential cleanup or seat creation reservations.

The [model-discovery acceptance helper](docs/operations/symposium-model-discovery.md)
checks native subscription account type and model availability without inference.
It requires a trusted owned-host attestation, pins its configuration and provider,
and retains reconciliation evidence until gateway and physical cleanup agree.

The no-inference discovery helper requires complete, bounded paginated sandbox and
provider inventories; legacy bare-array responses cannot establish cleanup or attachment proof.
Discovery journal ownership is exclusive across host adapters; interrupted owners
retain a recovery lock, and SSH cleanup terminates its proxy process group.

Owned Symposium test instances require certificate SANs for both loopback and the Podman guest endpoint; see [disposable gateway TLS](docs/operations/symposium-disposable-tls.md).
Owned Podman hosts must explicitly bind the driver namespace label, including the pinned driver’s empty value; see [Podman namespace evidence](docs/operations/symposium-podman-namespace.md).
Owned artifact volumes also require a reviewed image-bound owner and terminal initialization receipt; see [artifact ownership readiness](docs/operations/symposium-artifact-ownership.md).
Shared artifacts use the reviewed native working directory; see [canonical artifact layout](docs/operations/symposium-artifact-layout.md).

- [Owned Symposium evidence candidate collection](docs/features/symposium-owned-evidence.md)

Native Symposium Codex turns use [validated cumulative token usage](docs/features/symposium.md#durable-delivery-attribution-and-recovery), keeping terminal accounting unknown because completion carries no final usage proof, including when cumulative updates arrive late. This does not enable budgeted review admission or claim a hard provider spending cap.

Discovery preflight rejection can undo an exact undispatched local journal under
its retained lock; dispatched or replaced evidence still requires reconciliation.
Unreadable discovery journals remain reconciliation-required, and completion clears
only the exact receipt under its retained lock.

Connections lists saved personal ChatGPT identities with per-connection sign-in,
reconnect and disconnect. Catalog mutations invalidate all open account pickers;
changed or unavailable selections require explicit confirmation.

Owned native personal accounts expose an operator-only, revision-scoped model refresh
endpoint. It performs account/model reads without inference, then publishes the catalog
only after sandbox and physical cleanup. A new catalog revision requires explicit seat
selection; interrupted discovery retains host recovery state.

Personal discovery preflight can release its local marker before the discovery
capability is entered; uncertain allocation still requires recovery.

Connections offers **Refresh supported models** for a connected personal account.
The action uses that displayed account revision, reports pending cleanup or host recovery,
and leaves model choice and active-seat rebinding explicit.

Browser callback alternatives are scoped to a saved personal account and its current revision. An open account manager follows the picker’s disabled state, and refreshing completed sign-ins releases stale UI locks.

Native Codex acceptance and exact terminal notifications now persist as private
[diagnostic observations](docs/operations/symposium-native-observations.md), independently
of controller cleanup. Usage remains explicitly unknown; these records do not enable
review admission or prove a hard token budget. Storage replay covers the same private
registry file, not automatic history adoption after fresh gateway custody.

Before external seat creation, local artifact and seat intent writes complete before workspace dispatch uncertainty is recorded. A live owner can undo its exact unbound local intent if those writes fail before dispatch; failed rollback and interrupted processes retain recovery requirements. Inventory absence never discharges an uncertain dispatched create.

A final seat or custody rejection from the retained workspace fence may undo local creation intent only before the fence attempts its durable uncertainty write. Failure during that write remains quarantined.

Native model-discovery failures retain [private staged diagnostics](docs/features/symposium-discovery-diagnostics.md) without changing conservative cleanup or recovery gates.

Symposium director controls support explicit primary routing transfer to an admitted seat
without changing its permissions; original-writer cleanup and replacement still require live acceptance. See [Symposium lifecycle](docs/features/symposium.md#durable-delivery-attribution-and-recovery).

Personal Connections offers explicit model-discovery cleanup only when the same
running host retains an exact, known-sandbox recovery capability. Successful cleanup
requires fresh sign-in and explicit seat rebind; unknown creation and legacy or
restarted quarantine remain blocked. See [discovery recovery](docs/features/symposium.md#model-discovery-recovery).

A dormant [pending artifact seal fence](docs/operations/symposium-artifact-seal.md) denies
new Symposium seat work while trusted-host sealing is pending. The pending fence alone
does not prove physical drain or immutable Git identity; native trusted-review dispatch remains disabled.
The pending seal can also reserve its exact artifact lease identity across writer cleanup;
this internal retention lock remains unsealed and does not prove physical revocation.
An internal physical-seal operation now composes runtime drain, exact absence checks and a
credential-free read-only Git verifier; its retained receipt still grants no native review
or publication permission, and new gateway custody cannot adopt it.

The gated [artifact successor copier](docs/operations/symposium-artifact-generations.md)
joins retained self-contained exports, credential-free physical import and the existing
SQLite generation ledger. Activation moves only the ledger pointer; session admission
still maps the initial volume and sealed sessions stay closed. Trusted fix authority is
required and remains unavailable in the current application.

The [sealed publication service](docs/operations/symposium-sealed-publication-authority.md)
binds an explicitly selected operator GitHub identity to a completed seal and forced
Create PR approval. Explicit private credential references now enable operator selection
and the completed-seal bridge in the review panel. Native hard-budget/final-usage review
receipts and an authorized initial repository/base import remain prerequisites; this
registration increment does not make fresh empty artifacts publishable.

Dormant [pending native review evidence](docs/operations/symposium-review-attempt-staging.md)
stores immutable linkage and bounded untrusted findings without enabling dispatch or receipt promotion.

Pending failed-seat cleanup supports [scoped fresh app reauthorization](docs/operations/symposium-native-create-receipts.md#fresh-app-authentication-for-a-pending-cleanup) in the Director UI and operator API while the original host retains custody. Authorization and cleanup require separate explicit actions; this does not provide restart recovery.

- [Local Symposium custodian](docs/operations/symposium-local-custodian.md): optional fresh-fixture owner process survives app loss, fences epochs and drains exact workloads before explicit restoration; custodian death remains quarantined.

[Selected Work Vertex provisioning](docs/operations/symposium-work-vertex.md) binds an explicit ADC snapshot and verified principal to a fresh gateway-owned provider. The reviewed native variant and retained owner require fresh provider readiness and a separately verified policy for each Vertex seat.

Owned Claude's reviewed variant preserves the original Codex-only image contract.
It pins Claude 2.1.156, its fixed Vertex launcher, and the local Landlock helper.
The helper grants read access only to its current process maps inode for Claude;
that inode remains readable by fork descendants, but no proc subtree, memory,
environment, other seat home, or credential file is granted. The launcher checks
project/region and the exact OpenShell credential placeholder, clears inherited
model/provider overrides, and execs the fixed native binary in the same PID.

Each Claude claim uses a fresh native session UUID. Follow-up turns carry the
complete eligible same-seat conversation as explicitly untrusted user context,
with a 64 KiB UTF-8 ceiling; unavailable or oversized history rejects dispatch.
No native state is copied and `--resume` is denied. Exact init/assistant model
receipts and actual session IDs are checked before native events are projected.
Claude buffers each message until its matching assistant ID/model receipt;
verified messages can appear across tool turns, but its unverified token deltas
are not shown live. Cancellation discards the bounded pending message buffer.
A planned UUID is not provider acceptance. Account/profile, host grants, provider
identity and the retained Vertex capability are rechecked at admission and dispatch.
Every capability capture pairs current refresh status with stable installed-token
expiry before and after it, requires a 60-second lifetime margin, and rejects
pending or uncertain readiness. Identity receipts never cache credential readiness.

The credential-free physical contract can be run explicitly with
`MITZO_CLAUDE_PHYSICAL_CONTRACT=1 npx vitest run server/__tests__/symposium-claude-physical.contract.test.ts`.
`MITZO_CONTRACT_PODMAN` optionally selects the Podman executable. It uses the
reviewed local candidate image with no network or mounts, isolated disposable
homes, dummy placeholders, and actual native `--version` only. It retains exact
uncertain helper identity on failure. This proves local launch/isolation, not
Vertex inference permission, live multi-turn acceptance, or enforced native review budgets.

Owned Vertex seats derive a private immutable policy from the reviewed base
filesystem/Landlock contract and the exact selected account, provider, project,
region and dated model. The common Codex network policy is never copied into a
Vertex seat. Before ready/reuse and final dispatch, the owner brackets the
supported effective-policy readback with immutable sandbox identity checks.
API-backed seats now retain terminal create identity before later policy,
provider or artifact checks, preserving exact cleanup after failure.

Owned Vertex admission evidence workers obtain selected public provider receipts through the retained host custody channel and revalidate them after physical probing. Provider credentials never enter worker messages.

The optional Symposium custodian rejects ordinary OpenAI/Codex host fallback: configure a separate ordinary OpenShell runtime, or keep ordinary accounts unavailable. See [custodian operations](docs/operations/symposium-local-custodian.md).

Supervised Symposium publication now retains configured publication credential references and
uses the current browser permission queue through the custodian channel. It still requires a
trusted review record, completed seal and explicit per-operation approval; this does not enable
native trusted review dispatch without its separate budget and final-usage guarantees.

An uncertain sealed publication can be verified after fresh app authentication while its original
custodian and credential handle remain retained. The explicit exact-operation action performs
read-only reconciliation; it never reissues Create PR, replaces an approval, or reconstructs
credentials after custodian loss. See [publication recovery](docs/operations/symposium-sealed-publication-authority.md#fresh-app-authentication-and-read-only-recovery).

The `Centaur merge gate` workflow publishes a `Centaur final LGTM` commit status. Main branch protection requires it alongside CI: only a final Centaur LGTM with a merge recommendation and zero blockers for the current head passes. Pushes invalidate old approvals; review edits and dismissals recheck the status. A review-cycle limit requires an explicit final review, never a bypass. The workflow executes no pull-request code with its status-write token.

### Encrypted ecosystem backups

An opt-in backup foundation provides store-owner SQLite snapshots, Restic encryption,
and immutable incremental export to iCloud Drive. It is not enabled in production.
Live store fences, independent recovery keys, upload verification, scheduling and
replacement-machine acceptance must be configured before claiming protection. See
[the implementation and rollout contract](docs/operations/icloud-ecosystem-backup.md).

The Mitzo/Telos core capture binds the running event/task owners and canonical Telos
owner, including DB-only relationships and saved artifact bytes. It validates all
source change watermarks before finalizing; overlapping writes discard the candidate
without blocking saves. This limited group is not full ecosystem coverage and has
no live upload schedule. See the [backup contract](docs/operations/icloud-ecosystem-backup.md).

### Backup dashboard

Backups is available under Settings on desktop and More → Settings on mobile. It shows setup,
coverage, durable recent runs and separately verified local capture and iCloud upload.
The iCloud destination card opens a host setup guide for storage, encryption/recovery
and verification; disabled actions explain their prerequisites.
An interactive operator can manually capture the Mitzo/Telos database group, encrypt
and verify it with Restic, export it to iCloud and later check upload evidence.
Host configuration and independent recovery confirmation are required before actions
are enabled. Scheduling, retention and broader ecosystem coverage remain incomplete;
see [backup operations](docs/operations/icloud-ecosystem-backup.md).

Dependency security checks remain enabled. The Node-only `node-forge` RSA verification backport is pinned and reproduced from its upstream archive during builds; malformed-signature regression tests cover the patched behavior. See [security backport provenance](vendor/security/README.md).

Voice HTTP and WebSocket forwarding uses a fixed-route proxy without the recursive glob/brace parser. Raw audio bodies, path/query forwarding, TLS certificate verification and unavailable-service errors are covered by regression tests.

Installs require Node 24 and npm 11.18.0 or newer so workspace security overrides are applied. CI and release creation select npm 11.18.0 explicitly; the Mac’s global npm is unchanged. MCP SDK, proxy address handling, source maps and KaTeX are updated to patched releases, and both root and standalone MCP-server audits pass without exceptions.

### Canonical staging on the configured macOS host

Reuse the singleton `com.mitzo.staging` service at `http://mitzo-staging.localhost:3190`.
The [operating procedure](docs/operations/canonical-staging.md) describes integrity/freshness
checks, exact-commit preparation, plan/apply updates, private audit/snapshots and uncertain
shutdown handling. Staging operations keep production and retained diagnostic resources
outside their scope; provider setup is separate.
