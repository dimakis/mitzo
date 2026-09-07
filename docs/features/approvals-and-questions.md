# Approvals and user questions

Mitzo renders structured questions separately from tool approvals. Both travel through the existing permission channel, but an answer is not permission to use a tool for the rest of a session.

## Current SDK execution

The Anthropic Agent SDK path, including Vertex accounts, sends `AskUserQuestion` through `canUseTool`. The harness preserves question text, options, descriptions and multiple-selection flags. The client returns answer arrays keyed by question ID. The SDK adapter supplies `updatedInput.answers`, keyed by the original question text, with selected values joined by commas. Missing or malformed answers leave the request pending; questions cannot use session-wide approval.

Skill restrictions still apply before prompting. Ordinary tool approvals retain the existing mode, tier, skill and worktree checks. The UI says **Allow for session**, and describes the existing MCP server-wide scope of that choice. The actual tool-tier configuration remains authoritative: a card only appears when those checks require approval.

Approval cards display complete arguments rather than the shortened notification summary. Question cards support explicit option selection and free text without choosing an answer automatically. They use Mitzo's existing typography and theme variables, scroll their body on small screens, and keep actions available below it.

## Transport and lifetime

`permission_request` includes `permId`, optional application `sessionId`, an absolute `expiresAt`, and optional `questions`. `permission_response` adds optional `answers: Record<string, string[]>`. A response carrying a different bound session ID is rejected. Legacy responses without a session ID remain compatible.

The client queues concurrent requests and deduplicates repeated request IDs. Reconnecting or switching to a live session replays its unresolved requests with the original deadline. Resolution clears timeout and notification timers and emits `permission_resolved` to the active transport and observers. Stop/abort denies pending work; a socket closing during delivery cannot prevent resolution.

This registry is in memory. It does not restore approvals after a server restart or replay tool effects. Durable interrupted/uncertain outcomes belong to the server lifecycle integration. The client retains a submitted card until the server confirms resolution, so a queued or invalid response does not silently dismiss it. Draft answers are not durable across reloads.

## Other model backends

The shared UI contract should be translated at each execution adapter boundary, without putting provider response IDs into application session identity.

- **Direct OpenAI Responses:** the native executor exposes Read, Write, Edit and AskUserQuestion; native shell is unavailable. Questions use the shared interaction broker and return only selected answers as tool output. SDK `PermissionResult` objects are never sent as Responses tool output.
- **Codex app-server:** installed CLI 0.153.4 describes `tool/requestUserInput` with provider question IDs and answers shaped as `{ answers: { [id]: { answers: string[] } } }`. Preserve those IDs and the RPC request correlation separately from the Mitzo conversation ID. Its secret-input and restricted free-text flags need explicit UI support before exposing those requests. This card does not support secret input.
- **Codex command/file approvals:** translate only decisions advertised by the request and permitted by Mitzo policy. Provider session approval is not a substitute for Mitzo skill and worktree enforcement. Do not automatically accept policy amendments. Specialized tools and background execution still need enforcement analysis; receiving approval callbacks does not establish complete hook parity.
- **Other providers and MCP elicitation:** require explicit adapters and capability checks. A normal assistant message asking a question remains a chat message; it does not become a tool approval. The optional Praxis proxy route is not evidence that these interaction contracts are implemented for every provider.

The Codex mapping is based on the installed generated protocol schema and the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). These are integration requirements, not claims of completed backend lifecycle support.

## Isolated visual preview

Run `npx vite --config vite.preview.config.ts` from `frontend`, then open `/dev/approvals.html` on port 3102. The fixture uses the real component with synthetic requests and a light/dark theme toggle. It has no API or WebSocket proxy and performs no model calls. It is not a production build entry point.

Browser checks covered option selection, free-text submission and scrolling at 390 × 844 and 320 × 568. Physical-phone execution and restart acceptance remain outstanding; no production deployment is part of this change.
