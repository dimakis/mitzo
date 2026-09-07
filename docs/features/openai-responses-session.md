# OpenAI Responses session adapter

`ResponsesSession` implements the existing `ModelSession.turn()` boundary using the direct OpenAI Responses API. The server supplies an explicit account ID and API credential. It makes no environment, account, provider, or billing fallback.

The adapter translates streamed text/refusals and function calls into the events consumed by `sdkWrapperEmitter` and `runAgenticLoop`. Native execution remains the caller's `executeTool` responsibility. The adapter never executes model-generated commands itself.

Requests use `store: false` and request encrypted reasoning continuation data. `checkpoint()` returns a server-only snapshot containing the normalized application history and the original provider input/output items. Persist it beside the durable account binding after successful turns. Restore it with the same account ID and model; follow-up history must extend the checkpoint exactly. The snapshot contains private conversation data, not the API credential, and must not be exposed in the public account catalog or sent to the phone. Credential-reference identity remains the account-profile layer's responsibility.

Provider failure, incomplete output, malformed function arguments, mismatched history, and truncated streams throw rather than returning a successful tool turn. The request uses the supplied AbortSignal. Concurrent calls on the same instance are rejected. Final input usage is passed through the existing adapter, since Responses supplies it at completion. Initial streamed token counts are zero until that final usage arrives. Both terminated and incomplete event frames enforce a 4-MiB UTF-8 limit before JSON parsing.

The API endpoint is intentionally fixed to OpenAI for this native slice. Arbitrary proxy/base-URL routing is outside the account and credential contract; tests inject fetch without redirecting credentials to another host.

## Current boundary

This is an invocation adapter checkpoint, not a completed OpenAI mobile route. The [native execution foundation](openai-native-execution.md) adds permission-checked file/shell execution and a durable server-only runner. It is not yet connected to chat dispatch, follow-up queues, MCP clients or mobile account selection. Image input, reasoning-summary presentation, long-history compaction and lifecycle acceptance remain outstanding. Anthropic-style thinking budgets are rejected explicitly. No live account test has been performed for this adapter yet.

## References

- [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Function calling and continuation](https://developers.openai.com/api/docs/guides/function-calling)
