# Request web access

## Main-thread Codex research

Ordinary Codex chats can use native provider-hosted web search in their own thread
after the user allows it under Chat settings > More > Web search permission.
The OpenShell deployment availability default is `live`; an explicit
`MITZO_OPENSHELL_WEB_SEARCH=disabled` remains an operator kill switch. Availability
alone grants no access: new conversations remain unresolved/disabled, Ask stays
disabled, and consent changes are revision-checked and applied only between turns.
Existing deployments with an explicit off setting require a separate operator
configuration change. Native search does not enable shell networking.

Thread start, resume and fork instructions reflect the effective consent policy.
When enabled, the agent prefers native search, open and find in the current thread.
When disabled, it can use the existing separately approved exact-query tool where
available. URL reads keep their independent approval paths. This change does not
alter the stored approval decision or silently replace an account/model.

Research guidance asks the agent to establish the comparison target early, reuse
sources, batch independent lookups, prefer authorized GitHub integrations with
field filtering/pagination, and stop when supported claims answer the request.
Instructions guide behaviour; they do not impose a hard fetch count or establish
that a report's conclusions are correct.

Credential-free GitHub API list reads now return a structured summary of selected
fields for up to 100 records, retaining individual record URLs, page metadata,
provider total counts where present, issue/PR counts for that page, and real Link
pagination destinations. Bodies and verbose metadata are explicitly omitted;
individual detail endpoints retain full JSON. Use `fetch` with `view: full` on the
same URL when omitted fields or records are needed; the exact request and existing
origin/session checks still apply. Oversized trees report omitted
records and upstream truncation. Other hosts, unknown endpoints, invalid JSON and
plain text remain unchanged. Formatting happens after the same URL/DNS/approval
checks in both public and granted readers; pagination links grant no permission
and are never followed automatically.

Validation uses mocked provider/transport tests, consent lifecycle regressions,
and intercepted offline browser fixtures. It makes no live provider compatibility,
latency, cost or production-adoption claim. Production activation remains a
separate explicit action; canonical staging stays stood down.

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

Search and ungranted public reads present the exact request in the existing approval card. Approval executes that request and returns external source material in the current turn. Denial, cancellation, changed input, a changed session/account/model, or a later restrictive mode/skill decision prevents dispatch. Auto mode and cached tool-wide grants cannot replace explicit web-search consent.

Search cards offer **Allow Once** or **Allow for session**. Session consent covers provider-hosted searches using the current account and model until the live session ends. It survives switching chats and transport reconnects; a changed account or model retires it. Ending or recreating the runtime, including a server restart, requires new consent. Search consent does not grant website reads, URL access, credentials, shell networking, or other tools. Ungranted public reads keep `approvalScope: request` and need one-shot approval; session origin grants use the separate flow below.

## iOS notification approvals

With native push delivery configured and iOS notifications enabled, enable **Show sensitive details** in notification settings to review complete eligible requests in the banner and choose **Allow once** or **Deny** while another app is foreground. Redacted notifications keep **Review request**. Only bounded complete Bash command and web-access inputs are eligible; oversized requests, summary-only inputs, questions, and arbitrary integration grants keep full review. Quick approval is never offered with a truncated request. Web-search banners also offer **Allow searches for session**. The native app handles these actions in the background using the configured Mitzo server and its shared Keychain login, fetches the live request, and checks session identity and expiry, and requires the live tool name and exact input to match the details delivered in the banner before responding. Allow and Deny both require unlocking the device. The delegate is owned by AppDelegate and registered before launch finishes, so background actions do not require a scene or webview to load. Confirmation removes the delivered alert. A failed or uncertain response produces an error notification instead of claiming success or automatically retrying approval. Requests with questions or conversation-wide access still offer **Review request** in Mitzo.

The same search choices appear in the notification details screen. iOS controls banner presentation, lock-screen authentication, Focus, and notification settings. These changes require distributing the updated native iOS bundle as well as deploying the backend. Existing app versions offer their registered categories and cannot gain native background actions from a server update alone. See [Apple’s actionable notification documentation](https://developer.apple.com/documentation/usernotifications/declaring-your-actionable-notification-types).

Search uses the conversation's selected account and model. Provider search and model charges may apply. Mitzo never selects another account or substitutes a model after a rejection. Provider/model combinations without hosted search return an explicit failure; website reads remain independent of hosted-search support.

## Read outcomes and redirects

Web rows show the destination, including the HTTP/HTTPS scheme and query string, or the search query instead of the internal tool name and JSON. Web input summaries remain complete, bounded JSON so long URLs and reasons survive streaming and history restore. Details retain the original request.

Access grants show **Access granted · 15 minutes**; revocations show **Access revoked**. A grant does not itself read a page. Reads and searches show **Read complete** and **Search complete**. Errors distinguish successful approval from a failed read: website refusal (HTTP status), timeout, page-size limit, unsupported format, address lookup and connection failure. Fixed error messages reach both the UI and the agent; raw transport errors remain private.

An ungranted public HTTPS read that redirects to another origin asks for explicit approval of the new destination within the same tool call. Each destination is validated and the session/account/model boundary is checked after approval. The public-only HTTPS restrictions remain in force. A redirect never authorizes a different account, authenticated browsing or arbitrary networking.

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

Each read resolves and pins the destination again. An unapproved address stops the read and requires renewed access. A redirect to another origin pauses the current tool call and presents an explicit destination approval with that origin and its resolved addresses. Approval continues the read under the destination grant; it never widens the source grant. The original grant must remain valid throughout the read, including during destination approval. Denial, revocation, expiry, account/model changes or cancellation stop continuation. Redirect chains are bounded to three destination approvals. Pending name resolution and reads cancel with the session. Reads accept bounded text responses only. Grants are held by the live session, are not shared between accounts, and disappear when the live session is replaced or the process restarts; reconnecting a transport to the same live session does not expand them. To revoke an origin, call the same tool with `operation: "revoke_access"`, the URL and a reason.

| Route                           | Search execution                                                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT/Codex host or OpenShell | A separate search-only thread through the same bound transport and verified account. Parent consent/thread configuration stays unchanged. Native execution, inherited MCPs, and host tools are disabled. A completed native search receipt is required. |
| OpenAI API                      | One Responses request with `web_search` selected, the explicit key/model, `store: false`, and source citations.                                                                                                                                         |
| Gemini/Vertex                   | One search-only `generateContent` request with `googleSearch`, the explicit project/region/token/model, grounding sources, and search suggestions. Grounding is kept separate from function calls.                                                      |
| Claude SDK                      | A separate request with the same account environment and selected model, only `WebSearch`, no project settings, no persistent session, and a bounded turn count.                                                                                        |

Google grounding and its unchanged search suggestion HTML appear together outside collapsed tool groups. The suggestion iframe permits links to open a browser, but cannot run scripts or share the application's origin. Other search results include clickable source links for the agent to cite.

Without a session origin grant, `fetch` requests retain the credential-free HTTPS GET flow to one public origin. It uses no authentication, cookies, proxy configuration, or pooled sockets. Every DNS answer must be public under the reviewed IANA address policy; the selected address and family are pinned to the TLS connection. Certificate verification is required. Same-origin redirects are rechecked, with a three-redirect limit. Another origin needs another request. Reads expire after 20 seconds and accept at most 2 MiB of uncompressed text/HTML/JSON/XML as a transport resource guard. HTML is returned as inert readable text with source links; scripts, styles and navigation markup are omitted. Readable article text has no separate truncation threshold. Relative destinations honor the first valid HTML base URL. Repeated destinations are deduplicated; generated URL expansion stays proportional to the input, using compact URL references and a stated base when needed. XHTML and other XML retain their original source and XML semantics. The Symposium Vertex host bus and MCP reader allow 32 MiB encoded replies to cover the 2 MiB download, readable link metadata and JSON escaping. Existing model-request, setup, filesystem and claim guards remain unchanged. They do not execute JavaScript, sign in, submit forms, fetch private networks, or grant shell networking. An HTTP refusal is reported separately from denied permission.

Ordinary chats use the shared session approval flow. Admitted Symposium seats also expose `RequestWebAccess` with `request_access`, `fetch` and `revoke_access` (provider-hosted search is not exposed by this seat surface). Their approval cards appear in the Symposium conversation and show the selected seat account/model, URL, exact origin and resolved addresses. An authenticated user approves the immutable request hash; cancellation, a changed attempt/route, expiry or revocation prevents reads. Seat grants last at most 15 minutes and end with the executing claim. At most three website approval cards can be outstanding per seat; orphaned pending approvals cannot be restored after owner restart.

Symposium `RequestGithubPublish` records a publication request for the user. **Open artifact review** leads to the existing sealed, reviewed-artifact and explicit credential/publication approval flow. The proposal fields are suggestions; they do not select a credential, approve a source commit, write to GitHub or substitute for the eventual exact publication card. Models must report the request as awaiting artifact review, never as a push or PR.

Codex/API/subscription seats use their fenced dynamic host tools. Vertex seats use a bounded private-HOME stdio/file transport, activated only after the pinned model receipt; it does not enable sandbox networking or carry controller credentials. Python runs with isolated imports and no site startup, request/response files use descriptor-based checks and atomic writes, and the adapter drains host requests before releasing the native attempt. The same authenticated decision routes are forwarded through the retained custodian's closed protocol when supervised mode is enabled. Existing automatic Codex search consent remains a separate setting. Deploy the backend to expose the tool; distribute the updated frontend/iOS bundle for the request-only buttons and Google suggestion display. Retained ordinary Codex conversations refresh the tool surface at safe admission through their existing continuity mechanism. API-key, Vertex and SDK conversations receive the shared tools when their runtime is recreated on resume; starting a new user conversation is not required. An already-running provider loop keeps its admitted tool surface until that boundary.

## Runtime coverage and limits

The ordinary host tool is independent of the agent's filesystem/network sandbox. Local and OpenShell callers share consent and website-read execution; only the provider search adapter differs. Account/model changes invalidate search consent. Website origin consent does not become arbitrary networking. No separate search service is configured or implicitly selected by these adapters.

| Supported ordinary route                                  | Search execution                                         | Coverage                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex + OpenAI Personal, local/OpenShell                  | Separate native Codex thread on the verified route       | Pinned native receipt, safe errors, caller cancellation                                                                           |
| Codex + OpenAI API, OpenShell                             | Same native adapter with the pinned API provider         | Same native receipt and route verification                                                                                        |
| Responses + OpenAI API, local                             | Selected OpenAI Responses hosted search                  | Completed search/citation receipt, safe errors, provider output limits                                                            |
| Claude SDK + Vertex Claude, local owned and legacy routes | Search-only SDK child with selected environment/model    | Tool exposed on initial/resumed/recreated owned queries, original-owner and query-retirement fences, safe final-result validation |
| Gemini + Vertex Gemini, local                             | Google Search grounding on selected project/region/model | Grounding receipt and Search Suggestions retained, safe errors, provider output limits                                            |

The owned local Vertex MCP server exposes only `RequestWebAccess`, retaining publication exclusion. Each SDK query gets a fresh server tied to that query's retirement state. The separate search child records durable execution ownership, checks the original authority before startup and on every returned event, and checks it synchronously before native process startup when the protected launcher is present. Retired servers cannot dispatch searches in a successor query.

This matrix describes software paths and offline evidence, not live provider acceptance. The runtime compatibility resolver currently rejects Codex + Vertex and other unsupported combinations. Symposium seat tools currently expose approved website reads but no hosted search; they benefit from the shared readable-page correction but are not claimed to have gained search. Provider/model combinations without hosted search cannot be made search-capable by removing adapter bugs. Literal model-independent search requires a separately configured host search service with explicit provenance, credentials, charging, permission and deployment authority. Do not scrape search-engine HTML or switch AI accounts/models to pretend that this prerequisite exists.

## Validation

OpenAI search omits a Mitzo output-token ceiling. Supported GPT-5/6 reasoning searches request
`return_token_budget: unlimited`; other models keep the provider's supported web-search schema.
Approved searches have no Mitzo duration cutoff and stop on caller/session cancellation. Gemini also leaves output size to the selected provider; Claude SDK searches have no artificial three-turn cutoff.
Provider context, output and rate limits still apply. No extra request or model/account fallback is
made when a provider limit is reached.

OpenAI search failures retain server-authored reasons through the approval boundary: HTTP rejection,
authentication/access refusal, rate/quota limits, provider availability, transport failure, invalid
responses, incomplete output (including the output-token limit), missing completed search receipts,
and missing cited answers. Provider response bodies and raw exceptions are never returned. A failed
search does not retry on another account or model. These categories identify subsequent failures;
older generic results cannot establish which provider failure occurred.

Native Codex (host/OpenShell/Personal) searches use a separate adapter from direct OpenAI API searches. The pinned 0.160.0 [WebSearchItem](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/WebSearchItem.ts) has `id`, `query`, `action` and nullable `results`, with no `status` field. A matching `item/completed` notification supplies completion evidence; Mitzo still requires a completed matching turn and an answer with source URLs. Explicit failure status/error extensions are rejected. The adapter has no application duration cutoff and closes on caller cancellation. Initialization, account verification, configuration, route changes, turn failure, missing receipts and missing sources return fixed safe reasons; RPC/provider exception text is never exposed. No account/model fallback or automatic retry occurs.

The 14 October OpenShell conversation `a1c5a15f-5dd6-4b86-9e71-992808086486` recorded two approved search failures at 16:57 UTC and a GitHub read failing at the old 128 KiB limit. Its generic historical errors do not establish the native provider outcome. The configured production source `c125be291ffa` predates the accepted page/API fix in PR #931; merging a fix does not activate it in an existing release. Verification must distinguish accepted source, deployed source and actual runtime adoption. Canonical staging must pass its custody check before live acceptance, and any model test must use an explicitly selected supported Luna account/model. Native protocol fixtures now reproduce the status mismatch through the shared approval boundary.

The API, Gemini/Vertex, native Codex and Claude SDK adapters share a safe provider-error boundary. Gemini distinguishes HTTP failures, output exhaustion and missing grounding receipts while retaining Google Search Suggestions. Claude SDK result validation checks both subtype and `is_error` plus terminal completion; a success subtype with a failed final API request is not usable search output. Every adapter retains the exact selected model and credentials. Completed results are checked against the current permission/account/runtime authority before publication. Public and granted website reads recheck the original runtime owner after pending network I/O, as well as session/grant identity; retiring an SDK query or withdrawing its original authority with unchanged registry metadata withholds the page. Both website-read paths reject empty HTML shells as unreadable instead of recording successful source retrieval.

Tests cover the shared approval boundary, real permission cards, selected-account adapters with mocked transports, Codex search thread isolation and receipts, SSRF/DNS pinning, redirect handling, streaming limits, cancellation, SDK MCP wiring, and source display. Builds verify server artifacts and frontend types. The new URL approval path is tested with mocked transports, real Mitzo permission cards and a disposable local HTTP server; this does not claim production adoption. No live model calls are claimed by these tests. Live model tests must explicitly select an account-supported Luna model and announce the exact account/model; other models require explicit approval.

Provider references: [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Google grounding and display requirements](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search), [Claude web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool). Codex's pinned native search contract remains in `docs/spikes/codex-web-search-policy/app-server-contract.json`.

Opening artifact review hands the seat’s publication suggestion to the existing review flow and clears its pending notification and queue slot. The stored handoff is not a completed review or permission to publish; sealing and exact publication approval still happen in that flow.

Handed-off publication suggestions remain visible as reference data in artifact review, including after reopening it from the generic review entry. The repository, base branch, title, body and draft choice are retained; these suggestions never select an artifact or authorize publication. Outstanding requests are listed separately from the bounded completed history so older approvals stay visible.

A controller-confirmed successful sealed publication also closes outstanding suggestions for that session, repository path and base branch, including publication through the generic review entry. The request history records the completed operation ID. This is advisory queue cleanup; the sealed artifact and exact publication approval remain the only publishing authority. Unrelated repositories or branches and unverified operations remain outstanding.
