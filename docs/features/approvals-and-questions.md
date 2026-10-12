# Approvals and user questions

Mitzo renders structured questions separately from tool approvals. Both travel through the existing permission channel, but an answer is not permission to use a tool for the rest of a session.

## Current SDK execution

The Anthropic Agent SDK path, including Vertex accounts, sends `AskUserQuestion` through `canUseTool`. The harness preserves question text, options, descriptions and multiple-selection flags. The client returns answer arrays keyed by question ID. The SDK adapter supplies `updatedInput.answers`, keyed by the original question text, with selected values joined by commas. Missing or malformed answers leave the request pending; questions cannot use session-wide approval.

Skill restrictions still apply before prompting. Ordinary tool approvals retain the existing mode, tier, skill and worktree checks. Every tool approval offers **Allow for session** alongside a one-time decision, with a description of the retained tool, service or connection scope. Structured questions remain one-time answers. The actual tool-tier configuration remains authoritative: a card only appears when those checks require approval.

Approval cards display complete arguments rather than the shortened notification summary. Question cards support explicit option selection and free text without choosing an answer automatically. They use Mitzo's existing typography and theme variables, scroll their body on small screens, and keep actions available below it.

## Transport and lifetime

`permission_request` includes `permId`, optional application `sessionId`, an absolute `expiresAt`, and optional `questions`. `permission_response` adds optional `answers: Record<string, string[]>`. A response carrying a different bound session ID is rejected. Legacy responses without a session ID remain compatible.

Interactive operators can answer an exact session-bound card from another authenticated device watching that session, through HTTP or WebSocket, without transferring execution ownership. The server validates the live transport login and watched session; a subscription or connection ID alone grants no approval authority. Internal service credentials cannot use the interactive HTTP approval endpoint.

The client queues concurrent requests and deduplicates repeated request IDs. Reconnecting or switching to a live session replays its unresolved requests with the original deadline. Resolution clears timeout and notification timers and emits `permission_resolved` to the active transport and observers. Stop/abort denies pending work; a socket closing during delivery cannot prevent resolution.

This registry is in memory. It does not restore approvals after a server restart or replay tool effects. Durable interrupted/uncertain outcomes belong to the server lifecycle integration. The client retains a submitted card until the server confirms resolution, so a queued or invalid response does not silently dismiss it. Draft answers are not durable across reloads. HTTP rejections retain the authoritative pending-card snapshot, so a card resolved on another device clears after a stale submission. Retrying clears the prior error before sending, making repeated identical conflicts recoverable. Cancellation and expiration are reported separately from a user denial.

## Other model backends

The shared UI contract should be translated at each execution adapter boundary, without putting provider response IDs into application session identity.

- **Direct OpenAI Responses:** the native executor exposes Read, Write, Edit, Bash and AskUserQuestion; Bash uses the shared mode policy and an OS sandbox. See [unified permissions](../design/unified-chat-permissions.md). Questions use the shared interaction broker and return only selected answers as tool output. SDK `PermissionResult` objects are never sent as Responses tool output.
- **Codex app-server:** installed CLI 0.153.4 describes `tool/requestUserInput` with provider question IDs and answers shaped as `{ answers: { [id]: { answers: string[] } } }`. Preserve those IDs and the RPC request correlation separately from the Mitzo conversation ID. Its secret-input and restricted free-text flags need explicit UI support before exposing those requests. This card does not support secret input.
- **Codex command/file approvals:** translate only decisions advertised by the request and permitted by Mitzo policy. Provider session approval is not a substitute for Mitzo skill and worktree enforcement. Do not automatically accept policy amendments. Specialized tools and background execution still need enforcement analysis; receiving approval callbacks does not establish complete hook parity.
- **Other providers and MCP elicitation:** require explicit adapters and capability checks. A normal assistant message asking a question remains a chat message; it does not become a tool approval. The optional Praxis proxy route is not evidence that these interaction contracts are implemented for every provider.

The Codex mapping is based on the installed generated protocol schema and the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). These are integration requirements, not claims of completed backend lifecycle support.

## Isolated visual preview

Run `npx vite --config vite.preview.config.ts` from `frontend`, then open `/dev/approvals.html` on port 3102. The fixture uses the real component with synthetic requests and a light/dark theme toggle. It has no API or WebSocket proxy and performs no model calls. It is not a production build entry point.

Browser checks covered option selection, free-text submission and scrolling at 390 × 844 and 320 × 568. Physical-phone execution and restart acceptance remain outstanding; no production deployment is part of this change.

## Shared approval scope and runtime coverage

The permission card advertises the scope that the executing adapter can retain. Ordinary tool approvals support session grants; MCP tools share the advertised server scope. The four trusted native Telos tools (`TelosCreateOutcome`, `TelosSaveArtifact`, `TelosFindArtifacts`, `TelosReadArtifact`) use that same Telos server scope. Names merely starting with `Telos` do not inherit it. Ask mode, skill ceilings and workspace checks remain authoritative after a grant.

Forced project-policy and native-tool prompts honor an explicit session-retention choice while retaining current mode, skill and workspace checks. A reviewed provider capability retains only its operation class, capability version, connection and semantic policy revision within the owning session. Each new input still passes current validation and execution checks; a different class, connection or revision needs its own approval. Explicit conversation integration approval stores its narrower connection/provider consent separately and does not add an unrelated generic tool allow-list entry. Public and private website access retain account/origin-scoped consent across model changes; web search keeps separate account/model-bound billing consent. Repository publication retains its reviewed repository/connection scope rather than a blanket publication-tool grant.

The absolute card deadline is enforced before its resolver applies a decision, even if the timeout callback has not run. Expired answers deny execution, add no grant and clear the pending card. A different session ID or unauthorized connection is rejected before it can alter another conversation's approval.

| Route or runtime                              | Shared authority and scope                                                                                                        | Offline verification                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude SDK and Vertex SDK                     | Harness policy and SDK hook ceiling; ordinary and forced-ask session grants; explicit deny hooks remain authoritative             | Session permission policy, harness permissions and native hook tests                 |
| Native Codex host                             | Harness approval before MCP/native execution; native tools and scoped operation classes retain explicit session consent           | Codex session/MCP, native executor and capability approval tests                     |
| OpenAI Responses and Gemini native API routes | Shared native executor and MCP approval adapter; account consent stays separate from tool approval                                | Native executor, Responses/session adapters and synthetic Google/Telos MCP execution |
| OpenShell API and subscription routes         | Conversation provider attachment remains separate from exact tool approval; trusted native Telos and MCP grants share scope       | Codex session/conversation, provider environment and session-grant tests             |
| Delegated contributors                        | Contributor binding and current mode/skill ceiling remain authoritative; parent access does not manufacture a broader child grant | Contributor lifecycle/profile and environment continuation tests                     |
| Web SSE and native WS                         | Interactive operator authority bound to a live open watched transport and exact pending session; ownership remains unchanged      | HTTP permission, WS dispatcher, auth binding and SSE reconciliation tests            |
| Cards and notifications                       | Request/session/conversation labels match retained scope; accurate cancellation/expiry; unresolved cards replay across reconnect  | Permission banner, permission lifecycle, notification and client tests               |

This matrix describes audited source paths and offline tests. It does not claim live account/provider or physical-phone acceptance. Tests use synthetic service peers and local temporary workspaces without credentials or model inference.

Native publication controllers retain scoped consent for the logical conversation independently of their temporary permission-registry runtime. Every invocation still validates the current authenticated controller and watch; another authenticated device in that conversation can use the same retained scope. Explicit closure or removal clears controller consent. A trusted successful publication revoke or provider disconnection clears only the affected connection scope, preserving unrelated session grants. Pending responses cannot restore revoked consent. Ending a provider turn or disposing the temporary controller runtime does not end the logical conversation.

Matching already-pending shared-handler approvals settle after a session grant only when their server-owned scope matches and their current mode, skill, owner and workspace checks still pass. Changed worktree identities across asynchronous revalidation deny the queued request. External consent brokers retain their own narrow scope and cancellation rules.

Environment-key checks establish availability in the launching shell, not rotation freshness or live service access. A trusted successful integration attachment can queue one bounded continuation for an ordinary locally owned turn. Externally owned reviewed turns instead return typed `environment_pending` unfinished work after the actual provider terminal outcome; the owner must issue its reviewed next command. Neither path manufactures execution admission or retries cancelled/failed work.
