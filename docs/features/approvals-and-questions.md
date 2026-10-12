# Approvals and user questions

Mitzo renders structured questions separately from tool approvals. Both travel through the existing permission channel, but an answer is not permission to use a tool for the rest of a session.

## Current SDK execution

The Anthropic Agent SDK path, including Vertex accounts, sends `AskUserQuestion` through `canUseTool`. The harness preserves question text, options, descriptions and multiple-selection flags. The client returns answer arrays keyed by question ID. The SDK adapter supplies `updatedInput.answers`, keyed by the original question text, with selected values joined by commas. Missing or malformed answers leave the request pending; questions cannot use session-wide approval.

Skill restrictions still apply before prompting. Ordinary tool approvals retain the existing mode, tier, skill and worktree checks. The UI says **Allow for session**, and describes the existing MCP server-wide scope of that choice. The actual tool-tier configuration remains authoritative: a card only appears when those checks require approval.

Approval cards display complete arguments rather than the shortened notification summary. Question cards support explicit option selection and free text without choosing an answer automatically. They use Mitzo's existing typography and theme variables, scroll their body on small screens, and keep actions available below it.

## Transport and lifetime

`permission_request` includes `permId`, optional application `sessionId`, an absolute `expiresAt`, and optional `questions`. `permission_response` adds optional `answers: Record<string, string[]>`. A response carrying a different bound session ID is rejected. Legacy responses without a session ID remain compatible.

Interactive operators can answer an exact session-bound card from another authenticated device watching that session, through HTTP or WebSocket, without transferring execution ownership. The server validates the live transport login and watched session; a subscription or connection ID alone grants no approval authority. Internal service credentials cannot use the interactive HTTP approval endpoint.

The client queues concurrent requests and deduplicates repeated request IDs. Reconnecting or switching to a live session replays its unresolved requests with the original deadline. Resolution clears timeout and notification timers and emits `permission_resolved` to the active transport and observers. Stop/abort denies pending work; a socket closing during delivery cannot prevent resolution.

This registry is in memory. It does not restore approvals after a server restart or replay tool effects. Durable interrupted/uncertain outcomes belong to the server lifecycle integration. The client retains a submitted card until the server confirms resolution, so a queued or invalid response does not silently dismiss it. Draft answers are not durable across reloads. HTTP rejections retain the authoritative pending-card snapshot, so a card resolved on another device clears after a stale submission. Cancellation and expiration are reported separately from a user denial.

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

Forced exact-action and project-policy prompts default to request scope and offer only one-time approval. Git commits, explicit command/file approval requirements and reviewed provider capability operations cannot silently become reusable integration grants. Explicit conversation integration approval stores its narrower connection/provider consent separately and does not add an unrelated generic tool allow-list entry. Web search retains its account/model-bound session consent; URL access and publication remain request-only.

The absolute card deadline is enforced before its resolver applies a decision, even if the timeout callback has not run. Expired answers deny execution, add no grant and clear the pending card. A different session ID or unauthorized connection is rejected before it can alter another conversation's approval.

| Route or runtime                              | Shared authority and scope                                                                                                        | Offline verification                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude SDK and Vertex SDK                     | Harness policy and SDK hook ceiling; ordinary session grants; project forced gates remain request-only                            | Session permission policy, harness permissions and native hook tests                 |
| Native Codex host                             | Harness approval before MCP/native execution; exact-action gates remain request-only                                              | Codex session/MCP, native executor and capability approval tests                     |
| OpenAI Responses and Gemini native API routes | Shared native executor and MCP approval adapter; account consent stays separate from tool approval                                | Native executor, Responses/session adapters and synthetic Google/Telos MCP execution |
| OpenShell API and subscription routes         | Conversation provider attachment remains separate from exact tool approval; trusted native Telos and MCP grants share scope       | Codex session/conversation, provider environment and session-grant tests             |
| Delegated contributors                        | Contributor binding and current mode/skill ceiling remain authoritative; parent access does not manufacture a broader child grant | Contributor lifecycle/profile and environment continuation tests                     |
| Web SSE and native WS                         | Interactive operator authority bound to a live open watched transport and exact pending session; ownership remains unchanged      | HTTP permission, WS dispatcher, auth binding and SSE reconciliation tests            |
| Cards and notifications                       | Request/session/conversation labels match retained scope; accurate cancellation/expiry; unresolved cards replay across reconnect  | Permission banner, permission lifecycle, notification and client tests               |

This matrix describes audited source paths and offline tests. It does not claim live account/provider or physical-phone acceptance. Tests use synthetic service peers and local temporary workspaces without credentials or model inference.
