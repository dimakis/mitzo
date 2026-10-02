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

Mitzo presents the exact request in its existing approval card. Approval executes that request and returns external source material in the current turn. Denial, cancellation, changed input, a changed session/account/model, or a later restrictive mode/skill decision prevents dispatch. Auto mode and cached tool grants cannot skip the card. `approvalScope: request` offers **Allow Once**; older clients' **Allow for session** responses are treated as one-time approvals. A subsequent request needs another approval.

Search uses the conversation's selected account and model. Provider search and model charges may apply. Mitzo never selects another account or substitutes a model after a rejection. Provider/model combinations without hosted search return an explicit failure; website reads remain independent of hosted-search support.

| Route                           | Search execution                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT/Codex host or OpenShell | A separate search-only thread through the same bound transport and verified account. Parent consent/thread configuration stays unchanged. Native execution, inherited MCPs, and host tools are disabled. A completed native search receipt is required. |
| OpenAI API                      | One Responses request with `web_search` selected, the explicit key/model, `store: false`, and source citations.                                                                                                                                         |
| Gemini/Vertex                   | One search-only `generateContent` request with `googleSearch`, the explicit project/region/token/model, grounding sources, and search suggestions. Grounding is kept separate from function calls.                                                      |
| Claude SDK                      | A separate request with the same account environment and selected model, only `WebSearch`, no project settings, no persistent session, and a bounded turn count.                                                                                        |

Google grounding and its unchanged search suggestion HTML appear together outside collapsed tool groups. The suggestion iframe permits links to open a browser, but cannot run scripts or share the application's origin. Other search results include clickable source links for the agent to cite.

Website access is a credential-free HTTPS GET to one public origin. It uses no authentication, cookies, proxy configuration, or pooled sockets. Every DNS answer must be public under the reviewed IANA address policy; the selected address and family are pinned to the TLS connection. Certificate verification is required. Same-origin redirects are rechecked, with a three-redirect limit. Another origin needs another request. Reads expire after 20 seconds and accept at most 128 KiB of uncompressed text/HTML/JSON/XML. They do not execute JavaScript, sign in, submit forms, fetch private networks, or grant shell networking. An HTTP refusal is reported separately from denied permission.

This feature covers ordinary chats. Symposium seat runtimes keep their separate tool contracts. Existing automatic Codex search consent remains a separate setting. Deploy the backend to expose the tool; distribute the updated frontend/iOS bundle for the request-only buttons and Google suggestion display. Existing active runtime tool surfaces may require a fresh chat or runtime reattachment after deployment.

## Validation

Tests cover the shared approval boundary, real permission cards, selected-account adapters with mocked transports, Codex search thread isolation and receipts, SSRF/DNS pinning, redirect handling, streaming limits, cancellation, SDK MCP wiring, and source display. Builds verify server artifacts and frontend types. A credential-free live read of `https://www.revenue.ie/` succeeded through the production fetch function. No live model calls are claimed by these tests. Live model tests must explicitly select an account-supported Luna model and announce the exact account/model; other models require explicit approval.

Provider references: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Google grounding and display requirements](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search), [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). Codex's pinned native search contract remains in `docs/spikes/codex-web-search-policy/app-server-contract.json`.
