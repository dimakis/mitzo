/**
 * The Claude CLI retries a stalled streaming request without streaming
 * (`STREAM_IDLE_TIMEOUT_MS` → non-streaming fallback). That reply arrives only as
 * complete `assistant` envelopes with no `stream_event`s. The query loop builds
 * durable blocks from stream events, so the reply's thinking, text and tool calls
 * were lost while its later tool results were still stored. The orphaned result then
 * made the whole conversation history unreadable.
 *
 * Replay each top-level envelope whose API message was never streamed as the
 * equivalent stream events, ahead of the envelope itself, so one block path owns
 * persistence, tool attribution and tracing. Streamed messages, child-agent
 * envelopes, CLI-synthesized notices and runtimes whose envelopes carry no API
 * message identity (Codex adapters) pass through unchanged.
 */

type SdkMessage = Record<string, unknown>;

export interface UnstreamedAssistantReplayObserver {
  /** One envelope was replayed as stream events. */
  replayed(detail: { messageId: string; blockCount: number; skippedBlockTypes: string[] }): void;
  /** Late stream events for an already replayed message were dropped. */
  suppressedLateStream(detail: { messageId: string }): void;
}

const MAX_MESSAGE_ID_LENGTH = 2000;

function topLevel(msg: SdkMessage): boolean {
  return msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;
}

function apiMessageId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_MESSAGE_ID_LENGTH
    ? value
    : null;
}

function streamEvent(source: SdkMessage, event: Record<string, unknown>): SdkMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    ...(typeof source.session_id === 'string' ? { session_id: source.session_id } : {}),
  };
}

/** Stream events equivalent to one content block, or null for unsupported kinds. */
function blockEvents(
  source: SdkMessage,
  index: number,
  block: Record<string, unknown>,
): SdkMessage[] | null {
  const event = (value: Record<string, unknown>) => streamEvent(source, value);
  const stop = event({ type: 'content_block_stop', index });
  if (block.type === 'text' && typeof block.text === 'string') {
    return [
      event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
      ...(block.text
        ? [
            event({
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: block.text },
            }),
          ]
        : []),
      stop,
    ];
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return [
      event({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      }),
      ...(block.thinking
        ? [
            event({
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: block.thinking },
            }),
          ]
        : []),
      stop,
    ];
  }
  if (block.type === 'redacted_thinking') {
    return [
      event({ type: 'content_block_start', index, content_block: { type: 'redacted_thinking' } }),
      stop,
    ];
  }
  if (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    block.id &&
    typeof block.name === 'string' &&
    block.name
  ) {
    return [
      event({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      }),
      event({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      }),
      stop,
    ];
  }
  return null;
}

export async function* replayUnstreamedAssistantMessages(
  source: AsyncIterable<SdkMessage>,
  observer: UnstreamedAssistantReplayObserver,
): AsyncGenerator<SdkMessage> {
  const streamed = new Set<string>();
  // Replayed message → next content index. The CLI may split one API message
  // into several envelopes; later envelopes continue that message's indices.
  const replayed = new Map<string, number>();
  let suppressing: string | null = null;

  for await (const msg of source) {
    if (msg.type === 'stream_event' && topLevel(msg)) {
      const event = msg.event as Record<string, unknown> | undefined;
      if (event?.type === 'message_start') {
        const id = apiMessageId((event.message as Record<string, unknown> | undefined)?.id);
        suppressing = id && replayed.has(id) ? id : null;
        if (suppressing) {
          observer.suppressedLateStream({ messageId: suppressing });
          continue;
        }
        if (id) streamed.add(id);
      }
      if (suppressing) continue;
      yield msg;
      continue;
    }

    if (msg.type === 'assistant' && topLevel(msg)) {
      const message = (msg.message ?? {}) as Record<string, unknown>;
      const id = apiMessageId(message.id);
      const content = Array.isArray(message.content)
        ? (message.content as Record<string, unknown>[])
        : [];
      if (
        id &&
        !streamed.has(id) &&
        message.model !== '<synthetic>' &&
        msg.isApiErrorMessage !== true &&
        content.length > 0
      ) {
        let index = replayed.get(id) ?? 0;
        const blocks: SdkMessage[] = [];
        const skippedBlockTypes: string[] = [];
        let blockCount = 0;
        for (const block of content) {
          const replay = block && typeof block === 'object' ? blockEvents(msg, index, block) : null;
          if (!replay) {
            skippedBlockTypes.push(String((block as { type?: unknown })?.type ?? 'unknown'));
            continue;
          }
          blocks.push(...replay);
          index += 1;
          blockCount += 1;
        }
        observer.replayed({ messageId: id, blockCount, skippedBlockTypes });
        if (blockCount > 0) {
          if (!replayed.has(id)) {
            yield streamEvent(msg, {
              type: 'message_start',
              message: {
                id,
                role: 'assistant',
                content: [],
                ...(typeof message.model === 'string' ? { model: message.model } : {}),
                ...(message.usage && typeof message.usage === 'object'
                  ? { usage: message.usage }
                  : {}),
              },
            });
          }
          replayed.set(id, index);
          for (const event of blocks) yield event;
        }
      }
    }
    yield msg;
  }
}
