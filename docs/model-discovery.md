# Models, thinking, and image input

Mitzo discovers ChatGPT subscription models through the account's Codex `model/list` endpoint (all pages, including hidden entries). Vertex uses the configured project model allowlist: SDK model names do not establish access for a particular Google Cloud project. The account profile's configured list is the fallback when discovery has never succeeded. OpenAI API profiles continue to use their configured model list: the API's model listing does not provide the capability metadata needed to identify compatible chat models and thinking levels.

Discovery runs at server startup and hourly. Use **Refresh models** beside the model picker or `/models refresh` in chat to force discovery. `/models` shows the current catalog. Discovery does not submit a model turn. Concurrent refreshes for an account share one request; catalogs are isolated by the complete account configuration. A failed refresh keeps the last successful catalog and displays a failure notice. Account login and billing identity are still checked before execution.

For ChatGPT models, **Thinking** shows the reasoning levels reported by that particular model. The initial selection uses its reported default; switching models resets to the new model's default. The selected level travels through WebSocket/SSE send and interrupt requests and is stored with each queued command, including across restart recovery. Clients that omit it use the model/runtime default instead of a hard-coded low effort.

Codex attachments use native `image` input with data URLs, rather than tool-based file reading. Images are validated and persisted in the private conversation queue with the prompt, so queued/recovered work retains its attachments. PNG, JPEG, WebP, and GIF are accepted, up to ten images and 14 MB of base64 data per image. Restricted skill tool ceilings remain unsupported and are still rejected explicitly.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

The legacy model selector uses a configured Vertex allowlist only when project, region, and explicit `GOOGLE_APPLICATION_CREDENTIALS` match exactly one profile. Inherited provider switches, per-model Vertex region overrides, or alternate endpoints also prevent a profile match. With no match (including ambient ADC), it retains the conservative server defaults. Duplicate matching routes or invalid profile configuration return an explicit error rather than selecting an arbitrary profile.

Google Gemini chat uses a separate `google-vertex` account profile with the same `projectId`, `region`, `credentialRef`, and `models` fields as an Anthropic Vertex profile. This keeps the invocation adapter explicit even when both accounts use the same Google Cloud billing project. The native Gemini runtime supports text and tools, including durable continuation with private thought signatures. Responses arrive after each generation completes; token-by-token streaming and image attachments are not enabled for this adapter yet.

Configured work model lists are not entitlement checks. Verify access with the chosen project's credentials before adding models; a stale list can omit models the account can already invoke. OpenAI API accounts also use their configured model list, while ChatGPT subscriptions use automatic discovery.
