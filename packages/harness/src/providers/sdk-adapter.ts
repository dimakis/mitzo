/**
 * SDK Adapter — bridges ModelSession.turn() to the SDK wrapper event shapes
 * that query-loop.ts consumes.
 *
 * query-loop.ts expects five wrapper event types:
 *   - stream_event: wraps each raw Anthropic StreamEvent
 *   - assistant: emitted after a turn completes, carries session_id + content blocks
 *   - user: tool result events passed back to the model
 *   - result: terminal event with usage/cost/turns/duration
 *   - system: lifecycle events (compaction, etc.)
 *
 * sdkWrapperEmitter() handles a single turn.
 * runAgenticLoop() handles the full tool-use loop.
 */

import type {
  ModelSession,
  ConversationMessage,
  ContentBlock,
  StreamEvent,
} from './session-types.js';

// ── SDK wrapper event types (what query-loop.ts branches on) ────

export interface SdkAssistantEvent {
  type: 'assistant';
  session_id?: string;
  parent_tool_use_id: string | null;
  message: { content: ContentBlock[] };
  usage?: SdkUsage;
}

export interface SdkStreamEvent {
  type: 'stream_event';
  event: StreamEvent;
  parent_tool_use_id?: null;
}

export interface SdkUserEvent {
  type: 'user';
  message: { content: ContentBlock[] };
  parent_tool_use_id?: null;
}

export interface SdkResultEvent {
  type: 'result';
  session_id?: string;
  usage?: SdkUsage;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

export interface SdkSystemEvent {
  type: 'system';
  subtype?: string;
  [key: string]: unknown;
}

export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type SdkWrapperEvent =
  | SdkAssistantEvent
  | SdkStreamEvent
  | SdkUserEvent
  | SdkResultEvent
  | SdkSystemEvent;

// ── Tool use block (extracted from assistant response) ──────────

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── Agentic loop options ────────────────────────────────────────

export interface AgenticLoopOptions {
  sessionId?: string;
  maxTurns: number;
  signal?: AbortSignal;
  executeTool: (block: ToolUseBlock) => Promise<ToolResultBlock>;
}

// ── sdkWrapperEmitter ───────────────────────────────────────────

/**
 * Wrap a single ModelSession.turn() call into SDK wrapper events.
 *
 * Yields stream_event wrappers for every raw StreamEvent, then an
 * assistant wrapper with the accumulated content blocks and usage.
 */
export async function* sdkWrapperEmitter(
  session: ModelSession,
  messages: ConversationMessage[],
  opts: { sessionId?: string; startMs: number },
): AsyncGenerator<SdkWrapperEvent> {
  const contentBlocks: ContentBlock[] = [];
  const inputBuffers = new Map<number, string>();
  const usage: SdkUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  for await (const event of session.turn(messages)) {
    // Pass through as stream_event wrapper
    yield { type: 'stream_event', event, parent_tool_use_id: null };

    switch (event.type) {
      case 'message_start': {
        const msgUsage = event.message.usage as Record<string, number>;
        usage.input_tokens = msgUsage.input_tokens ?? 0;
        usage.output_tokens = msgUsage.output_tokens ?? 0;
        usage.cache_read_input_tokens = msgUsage.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens = msgUsage.cache_creation_input_tokens ?? 0;
        break;
      }

      case 'content_block_start': {
        const cb = event.content_block;
        if (cb.type === 'text') {
          contentBlocks[event.index] = { type: 'text', text: '' };
        } else if (cb.type === 'thinking') {
          contentBlocks[event.index] = { type: 'thinking', thinking: '' };
        } else if (cb.type === 'tool_use') {
          inputBuffers.set(event.index, '');
          contentBlocks[event.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
        }
        // Unknown block types are silently skipped — no entry in contentBlocks,
        // so subsequent deltas/stops for this index are no-ops.
        break;
      }

      case 'content_block_delta': {
        const block = contentBlocks[event.index];
        if (!block) break; // Unknown block type — no entry was created

        if (event.delta.type === 'text_delta' && block.type === 'text') {
          block.text += event.delta.text;
        } else if (event.delta.type === 'thinking_delta' && block.type === 'thinking') {
          block.thinking += event.delta.thinking;
        } else if (event.delta.type === 'input_json_delta') {
          const buf = inputBuffers.get(event.index) ?? '';
          inputBuffers.set(event.index, buf + event.delta.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        const block = contentBlocks[event.index];
        if (block?.type === 'tool_use') {
          const rawInput = inputBuffers.get(event.index) ?? '{}';
          try {
            block.input = JSON.parse(rawInput);
          } catch {
            block.input = {};
          }
          inputBuffers.delete(event.index);
        }
        break;
      }

      case 'message_delta':
        if (event.usage.input_tokens !== undefined) usage.input_tokens = event.usage.input_tokens;
        usage.output_tokens = event.usage.output_tokens;
        break;
    }
  }

  // Emit assistant wrapper (turn complete)
  yield {
    type: 'assistant',
    session_id: opts.sessionId,
    parent_tool_use_id: null,
    message: { content: contentBlocks.filter(Boolean) },
    usage,
  };
}

// ── runAgenticLoop ──────────────────────────────────────────────

/**
 * Full agentic loop: call ModelSession.turn(), handle tool_use blocks,
 * execute tools, append results, repeat. Yields SDK wrapper events
 * throughout so query-loop.ts can process them in real-time.
 */
export async function* runAgenticLoop(
  session: ModelSession,
  initialMessages: ConversationMessage[],
  opts: AgenticLoopOptions,
): AsyncGenerator<SdkWrapperEvent> {
  const startMs = Date.now();
  const messages = [...initialMessages];
  const sessionId = opts.sessionId ?? `session-${Date.now()}`;

  let turns = 0;
  let totalOutputTokens = 0;
  let lastInputTokens = 0;
  let lastCacheReadTokens = 0;
  let lastCacheCreationTokens = 0;

  while (turns < opts.maxTurns) {
    if (opts.signal?.aborted) break;

    turns++;
    const toolUseBlocks: ToolUseBlock[] = [];

    // Run one turn through the emitter
    for await (const event of sdkWrapperEmitter(session, messages, { sessionId, startMs })) {
      yield event;

      // Extract tool_use blocks from the assistant wrapper
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            toolUseBlocks.push(block);
          }
        }
        // Track usage
        if (event.usage) {
          lastInputTokens = event.usage.input_tokens ?? 0;
          totalOutputTokens += event.usage.output_tokens ?? 0;
          lastCacheReadTokens = event.usage.cache_read_input_tokens ?? 0;
          lastCacheCreationTokens = event.usage.cache_creation_input_tokens ?? 0;
        }
        // Append assistant message to conversation history
        messages.push({ role: 'assistant', content: event.message.content });
      }
    }

    // No tool calls — model is done
    if (toolUseBlocks.length === 0) break;

    // Check abort before executing tools
    if (opts.signal?.aborted) break;

    // Execute tools and collect results
    const toolResults: ContentBlock[] = [];
    for (const toolUse of toolUseBlocks) {
      if (opts.signal?.aborted) break;

      let result: ToolResultBlock;
      try {
        result = await opts.executeTool(toolUse);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Tool execution failed: ${message}`,
          is_error: true,
        };
      }

      // Yield user wrapper so query-loop can track tool results
      yield {
        type: 'user',
        message: { content: [result] },
        parent_tool_use_id: null,
      };

      toolResults.push(result);
    }

    // Append tool results as user message for next turn
    messages.push({ role: 'user', content: toolResults });
  }

  // Terminal result event
  yield {
    type: 'result',
    session_id: sessionId,
    num_turns: turns,
    duration_ms: Date.now() - startMs,
    usage: {
      input_tokens: lastInputTokens,
      output_tokens: totalOutputTokens,
      cache_read_input_tokens: lastCacheReadTokens,
      cache_creation_input_tokens: lastCacheCreationTokens,
    },
  };
}
