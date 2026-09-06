# OpenAI Responses session adapter

`ResponsesSession` implements the existing `ModelSession.turn()` boundary using the direct OpenAI Responses API. The server supplies an explicit account ID and API credential. It makes no environment, account, provider, or billing fallback.

The adapter translates streamed text/refusals and function calls into the events consumed by `sdkWrapperEmitter` and `runAgenticLoop`. Native execution remains the caller's `executeTool` responsibility. The adapter never executes model-generated commands itself.

Requests use `store: false` and request encrypted reasoning continuation data. `checkpoint()` returns a server-only snapshot containing the normalized application history and the original provider input/output items. Persist it beside the durable account binding after successful turns. Restore it with the same account ID and model; follow-up history must extend the checkpoint exactly. The snapshot contains private conversation data, not the API credential, and must not be exposed in the public account catalog or sent to the phone. Credential-reference identity remains the account-profile layer's responsibility.

Provider failure, incomplete output, malformed function arguments, mismatched history, and truncated streams throw rather than returning a successful tool turn. The request uses the supplied AbortSignal. Concurrent calls on the same instance are rejected. Final input usage is passed through the existing adapter, since Responses supplies it at completion.

## Current boundary

This is an invocation adapter checkpoint, not a completed OpenAI mobile route. Account catalog activation, server dispatch, native tool and permission integration, persisted checkpoints, image input, reasoning-summary presentation, long-history compaction, and lifecycle acceptance still need implementation. Anthropic-style thinking budgets are rejected explicitly. No live account test has been performed for this adapter yet.

## References

- [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
- [Function calling and continuation](https://developers.openai.com/api/docs/guides/function-calling)
