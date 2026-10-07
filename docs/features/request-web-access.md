# Request web access

Ordinary Mitzo chats expose `RequestWebAccess` on ChatGPT/Codex (host or OpenShell), direct OpenAI API, Gemini on Vertex, and Claude SDK routes. The agent can ask Mitzo to perform a concrete web operation instead of telling the user no request tool exists.

```json
{
  "operation": "search",
  "query": "Revenue historical tax returns myAccount API",
  "reason": "Verify the current official options"
}
```

```json
{
  "operation": "fetch",
  "url": "https://www.revenue.ie/",
  "reason": "Read Revenue's official guidance"
}
```

Search and ungranted public reads present the exact request in the existing approval card. Approval executes that request and returns external source material in the current turn. Denial, cancellation, changed input, a changed session/account/model, or a later restrictive mode/skill decision prevents dispatch. Auto mode and cached tool grants cannot skip the card. `approvalScope: request` offers **Allow Once**; older clients' **Allow for session** responses are treated as one-time approvals. A subsequent search or ungranted public read needs another approval. Session origin grants use the separate flow below.

Search uses the conversation's selected account and model. Provider search and model charges may apply. Mitzo never selects another account or substitutes a model after a rejection. Provider/model combinations without hosted search return an explicit failure; website reads remain independent of hosted-search support.

## Session URL approval

Use `request_access` when the agent needs a website that its normal networking cannot reach:

```json
{
  "operation": "request_access",
  "url": "http://homeassistant.local:8123/",
  "reason": "Read the Home Assistant instance the user asked me to inspect"
}
```

The user receives the exact origin, resolved destination addresses and a 15-minute credential-free read scope. The approval covers this session and AI account; a model/account change, expiry or `revoke_access` invalidates it. `fetch` can then read paths on the approved origin through Mitzo. HTTP, HTTPS, literal IP addresses, local/private networks and custom ports are supported after this explicit approval. Embedded URL credentials and other schemes are rejected. TLS certificates remain verified. No cookies, authentication, proxy environment or arbitrary shell networking are granted.

Each read resolves and pins the destination again. An unapproved address or another redirect origin stops the read and requires a new access request. Pending name resolution and reads cancel with the session. Reads accept bounded text responses only. Grants are held by the live session, are not shared between accounts, and disappear when the live session is replaced or the process restarts; reconnecting a transport to the same live session does not expand them. To revoke an origin, call the same tool with `operation: "revoke_access"`, the URL and a reason.

| Route                           | Search execution                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT/Codex host or OpenShell | A separate search-only thread through the same bound transport and verified account. Parent consent/thread configuration stays unchanged. Native execution, inherited MCPs, and host tools are disabled. A completed native search receipt is required. |
| OpenAI API                      | One Responses request with `web_search` selected, the explicit key/model, `store: false`, and source citations.                                                                                                                                         |
| Gemini/Vertex                   | One search-only `generateContent` request with `googleSearch`, the explicit project/region/token/model, grounding sources, and search suggestions. Grounding is kept separate from function calls.                                                      |
| Claude SDK                      | A separate request with the same account environment and selected model, only `WebSearch`, no project settings, no persistent session, and a bounded turn count.                                                                                        |

Google grounding and its unchanged search suggestion HTML appear together outside collapsed tool groups. The suggestion iframe permits links to open a browser, but cannot run scripts or share the application's origin. Other search results include clickable source links for the agent to cite.

Without a session origin grant, `fetch` requests retain the credential-free HTTPS GET flow to one public origin. It uses no authentication, cookies, proxy configuration, or pooled sockets. Every DNS answer must be public under the reviewed IANA address policy; the selected address and family are pinned to the TLS connection. Certificate verification is required. Same-origin redirects are rechecked, with a three-redirect limit. Another origin needs another request. Reads expire after 20 seconds and accept at most 128 KiB of uncompressed text/HTML/JSON/XML. They do not execute JavaScript, sign in, submit forms, fetch private networks, or grant shell networking. An HTTP refusal is reported separately from denied permission.

Ordinary chats use the shared session approval flow. Admitted Symposium seats also expose `RequestWebAccess` with `request_access`, `fetch` and `revoke_access` (provider-hosted search is not exposed by this seat surface). Their approval cards appear in the Symposium conversation and show the selected seat account/model, URL, exact origin and resolved addresses. An authenticated user approves the immutable request hash; cancellation, a changed attempt/route, expiry or revocation prevents reads. Seat grants last at most 15 minutes and end with the executing claim. At most three website approval cards can be outstanding per seat; orphaned pending approvals cannot be restored after owner restart.

Symposium `RequestGithubPublish` records a publication request for the user. **Open artifact review** leads to the existing sealed, reviewed-artifact and explicit credential/publication approval flow. The proposal fields are suggestions; they do not select a credential, approve a source commit, write to GitHub or substitute for the eventual exact publication card. Models must report the request as awaiting artifact review, never as a push or PR.

Codex/API/subscription seats use their fenced dynamic host tools. Vertex seats use a bounded private-HOME stdio/file transport, activated only after the pinned model receipt; it does not enable sandbox networking or carry controller credentials. Python runs with isolated imports and no site startup, request/response files use descriptor-based checks and atomic writes, and the adapter drains host requests before releasing the native attempt. The same authenticated decision routes are forwarded through the retained custodian's closed protocol when supervised mode is enabled. Existing automatic Codex search consent remains a separate setting. Deploy the backend to expose the tool; distribute the updated frontend/iOS bundle for the request-only buttons and Google suggestion display. Retained ordinary Codex conversations refresh the tool surface at safe admission through their existing continuity mechanism. API-key, Vertex and SDK conversations receive the shared tools when their runtime is recreated on resume; starting a new user conversation is not required. An already-running provider loop keeps its admitted tool surface until that boundary.

## Validation

Tests cover the shared approval boundary, real permission cards, selected-account adapters with mocked transports, Codex search thread isolation and receipts, SSRF/DNS pinning, redirect handling, streaming limits, cancellation, SDK MCP wiring, and source display. Builds verify server artifacts and frontend types. The new URL approval path is tested with mocked transports, real Mitzo permission cards and a disposable local HTTP server; this does not claim production adoption. No live model calls are claimed by these tests. Live model tests must explicitly select an account-supported Luna model and announce the exact account/model; other models require explicit approval.

Provider references: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Google grounding and display requirements](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search), [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). Codex's pinned native search contract remains in `docs/spikes/codex-web-search-policy/app-server-contract.json`.

Opening artifact review hands the seat’s publication suggestion to the existing review flow and clears its pending notification and queue slot. The stored handoff is not a completed review or permission to publish; sealing and exact publication approval still happen in that flow.

Handed-off publication suggestions remain visible as reference data in artifact review, including after reopening it from the generic review entry. The repository, base branch, title, body and draft choice are retained; these suggestions never select an artifact or authorize publication. Outstanding requests are listed separately from the bounded completed history so older approvals stay visible.

A controller-confirmed successful sealed publication also closes outstanding suggestions for that session, repository path and base branch, including publication through the generic review entry. The request history records the completed operation ID. This is advisory queue cleanup; the sealed artifact and exact publication approval remain the only publishing authority. Unrelated repositories or branches and unverified operations remain outstanding.
