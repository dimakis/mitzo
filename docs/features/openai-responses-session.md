# OpenAI Responses session adapter

> Historical implementation record. Custom OpenAI execution is retired. See
> [the current retirement and linked-continuation contract](legacy-execution-retirement.md).
> Retained private checkpoint data remains readable; it is not a native Codex thread.

`ResponsesSession` implements the existing `ModelSession.turn()` boundary using the direct OpenAI Responses API. The server supplies an explicit account ID and API credential. It makes no environment, account, provider, or billing fallback.

The adapter translates streamed text/refusals, visible reasoning summaries, and function calls into the events consumed by `sdkWrapperEmitter` and `runAgenticLoop`. Native execution remains the caller's `executeTool` responsibility. The adapter never executes model-generated commands itself.

Requests use `store: false` and request encrypted reasoning continuation data. GPT-5/GPT-6 reasoning families (excluding chat variants), o3/o4, and explicitly selected reasoning effort opt into `reasoning.summary: "auto"`. Non-reasoning models omit this option. Summary deltas stream as thinking blocks; completed summary items fill missing suffixes without duplication. Raw reasoning events and encrypted data are never emitted to the frontend. `checkpoint()` returns a server-only snapshot containing the normalized application history and the original provider input/output items. Persist it beside the durable account binding after successful turns. Restore it with the same account ID and model; follow-up history must extend the checkpoint exactly. The snapshot contains private conversation data, not the API credential, and must not be exposed in the public account catalog or sent to the phone. Credential-reference identity remains the account-profile layer's responsibility.

Provider failure, incomplete output, malformed function arguments, mismatched history, and truncated streams throw rather than returning a successful tool turn. The request uses the supplied AbortSignal. Concurrent calls on the same instance are rejected. Final input usage is passed through the existing adapter, since Responses supplies it at completion. Initial streamed token counts are zero until that final usage arrives. Both terminated and incomplete event frames enforce a 4-MiB UTF-8 limit before JSON parsing.

The API endpoint is intentionally fixed to OpenAI for this native slice. Arbitrary proxy/base-URL routing is outside the account and credential contract; tests inject fetch without redirecting credentials to another host.

## Image input and chat integration

OpenAI API chat dispatch accepts PNG, JPEG, WebP and GIF attachments up to 10 MiB decoded per image. Initial sends, follow-ups and interrupts carry validated base64 images with the prompt; multiple images preserve attachment order. The OpenShell route passes them to its existing Codex image handling. Direct Responses converts provider-neutral image blocks into `input_image` content with a base64 data URL and `detail: "auto"`, alongside `input_text` content.

Native history and server-only checkpoints retain image content across tool turns, explicit follow-ups and process restart. Retry identity includes the complete prompt and attachment bytes. Invalid attachments are rejected before a new provider admission or interruption of an active turn. Image previews continue to use the existing user-message transcript fields.

This does not enable images for the separate text-only ChatGPT-plan adviser or Google Vertex route. Long-history compaction and live account acceptance remain outstanding. Anthropic-style thinking budgets are rejected explicitly. Image acceptance is covered by mocked provider tests; no live account test was performed for this change. Canonical staging must pass its operating checks before a supported Luna model and charged account can be selected for live acceptance.

## References

- [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Function calling and continuation](https://developers.openai.com/api/docs/guides/function-calling)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
