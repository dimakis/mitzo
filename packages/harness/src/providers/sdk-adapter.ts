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

  // Track block metadata for assembly
  const blockMeta = new Map<number, { type: string; name?: string; id?: string }>();

  for await (const event of session.turn(messages)) {
    // Pass through as stream_event wrapper
    yield { type: 'stream_event', event, parent_tool_use_id: null };

    switch (event.type) {
      case 'message_start':
        usage.input_tokens = event.message.usage.input_tokens;
        usage.output_tokens = event.message.usage.output_tokens;
        break;

      case 'content_block_start': {
        const cb = event.content_block;
        blockMeta.set(event.index, {
          type: cb.type,
          ...(cb.type === 'tool_use' ? { name: cb.name, id: cb.id } : {}),
        });
        if (cb.type === 'text') {
          contentBlocks.push({ type: 'text', text: '' });
        } else if (cb.type === 'thinking') {
          contentBlocks.push({ type: 'thinking', thinking: '' });
        } else if (cb.type === 'tool_use') {
          inputBuffers.set(event.index, '');
          // Placeholder — input will be filled on block_stop
          contentBlocks.push({ type: 'tool_use', id: cb.id, name: cb.name, input: {} });
        }
        break;
      }

      case 'content_block_delta': {
        const meta = blockMeta.get(event.index);
        if (!meta) break;
        const blockIdx = findBlockIndex(contentBlocks, event.index, blockMeta);

        if (event.delta.type === 'text_delta' && blockIdx >= 0) {
          const block = contentBlocks[blockIdx];
          if (block.type === 'text') block.text += event.delta.text;
        } else if (event.delta.type === 'thinking_delta' && blockIdx >= 0) {
          const block = contentBlocks[blockIdx];
          if (block.type === 'thinking') block.thinking += event.delta.thinking;
        } else if (event.delta.type === 'input_json_delta') {
          const buf = inputBuffers.get(event.index) ?? '';
          inputBuffers.set(event.index, buf + event.delta.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        const meta = blockMeta.get(event.index);
        if (meta?.type === 'tool_use') {
          const blockIdx = findBlockIndex(contentBlocks, event.index, blockMeta);
          if (blockIdx >= 0) {
            const block = contentBlocks[blockIdx];
            if (block.type === 'tool_use') {
              const rawInput = inputBuffers.get(event.index) ?? '{}';
              try {
                block.input = JSON.parse(rawInput);
              } catch {
                block.input = {};
              }
            }
          }
          inputBuffers.delete(event.index);
        }
        break;
      }

      case 'message_delta':
        usage.output_tokens = event.usage.output_tokens;
        break;
    }
  }

  // Emit assistant wrapper (turn complete)
  yield {
    type: 'assistant',
    session_id: opts.sessionId,
    parent_tool_use_id: null,
    message: { content: contentBlocks },
    usage,
  };
}

/**
 * Find the position of a block in contentBlocks by stream index.
 * Content blocks are pushed in order, so stream index maps 1:1 to array index.
 */
function findBlockIndex(
  _blocks: ContentBlock[],
  streamIndex: number,
  _meta: Map<number, { type: string }>,
): number {
  // Stream indices are sequential starting from 0, matching push order
  return streamIndex;
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

      const result = await opts.executeTool(toolUse);

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
    },
  };
}
