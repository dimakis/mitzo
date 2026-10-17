# Published tools in ordinary Codex conversations

This is a source slice of Telos `b57a4c179d1d9e68`, under migration
`2c57d6a14b01eda3`. Source acceptance, route activation and live qualification
are separate. The full phase remains active while the limits below remain.

## Implemented surfaces

| Existing execution path | Explicit selection support                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Owned Local Codex       | Native workspace tools, existing profile tools, GitHub publication and selected configured stdio MCP tools.                    |
| Legacy host Codex       | Native workspace tools, existing connection/web/publication tools, configured stdio MCP tools and reviewed API template tools. |
| OpenShell Codex         | Explicit selections refuse admission. Existing profiles without a tool selection retain their prior behavior.                  |

An explicitly empty selection exposes only established required dynamic tools
(currently `AskUserQuestion`). Unselected sources never launch. Provider aliases
are not alternate tool identities. The executor checks the same immutable
selection used to filter provider definitions. Selected profiles cannot enable
project command hooks, and excluded web access cannot enable native search.
Existing native skill ceilings remain subject to Codex's explicit refusal;
this change does not claim mediation of native skill readers.

## Requirements and evidence

| Requirement                                  | Implementation and offline evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published identity and instructions          | Capture the published version once, verify its hash and retained identity, reject drift across awaited admission, and keep the owning command's profile/context checks. `codex-chat-selected-tools`, `codex-chat-session` and `ordinary-local-codex-selection-owner` exercise these boundaries.                                                                                                                                                                                                |
| Actual picker and owner eligibility          | `ordinary-local-codex-entry` tests the real capabilities endpoint with empty/native/MCP selections. The selection owner uses the owned route's supported surface and rejects unsupported connection helpers before workspace effects.                                                                                                                                                                                                                                                          |
| Exact tool advertisement and execution       | `codex-chat-selected-tools` exercises the actual adapter with published Library versions and the existing admission owners. `codex-chat-session` executes a selected native read through the owned adapter and refuses an unselected write.                                                                                                                                                                                                                                                    |
| MCP receipts and cleanup                     | Reuse `admitConfiguredTools`, with the current server-owned source getter and independent launch environment. Adapter tests cover selected-only launch, canonical permission identity, approved argument changes, current skill policy, revocation/cancellation/session replacement during approval, and cleanup after later API admission fails. Existing configured-tool authority/source-launch suites cover missing/changed receipts, changed descriptors and partial peer initialization. |
| API connection authority                     | Reuse `admitApiTools` and the credential connection owner. Adapter tests cover canonical access approval, bounded mapped results, an unselected raw connection call, skill denial and revocation during approval. Selection creates no connection grant.                                                                                                                                                                                                                                       |
| Trusted compiled context and acknowledgement | Preserve the existing developer/application channels and exact provider-turn acceptance callbacks. The ordinary context identity owner and the `agent-context-delivery`, `codex-ordinary-packet` and `codex-conversation` retain identity, payload and acknowledgement coverage. A prepared snapshot alone is not acceptance.                                                                                                                                                                  |
| Images and frozen inference settings         | Preserve the existing ordinary packet and conversation owners. Their suites cover user image serialization, model/thinking validation and queued command settings.                                                                                                                                                                                                                                                                                                                             |
| Existing engines and activation holds        | No dispatch selection changes: Local API continues through Responses; retained history and Gemini keep their owners. Owned Codex, Responses/configured-tool and route suites provide offline regression evidence.                                                                                                                                                                                                                                                                              |

## Remaining limits

Owned Local Codex does not yet admit connection/API template tools or web access.
OpenShell explicit tool selection remains unavailable. These capabilities need
their own owner and executor qualification before advertisement; this PR does not
complete tool parity across every target.

Configured MCP results preserve text and represent non-text blocks as unavailable
placeholders. User image input does not establish multimodal tool-result parity.
An active provider thread's tool surface cannot be silently refreshed; existing
thread-generation and retained-definition rules continue to apply.

New Local API dispatch, durable API custody and its continuation scenarios belong
to `04e660858b274b27`. Live qualification and production adoption remain pending.
Canonical staging stays stood down. No model account is required for these
offline fixtures.
