import { z } from 'zod';
import type {
  ContentBlock,
  ConversationMessage,
  ModelSession,
  ModelSessionConfig,
  StreamEvent,
} from './session-types.js';

const record = z.record(z.string(), z.unknown());
const eventSchema = z.object({
  type: z.string(),
  output_index: z.number().int().nonnegative().optional(),
  content_index: z.number().int().nonnegative().optional(),
  delta: z.string().optional(),
  item: record.optional(),
  part: record.optional(),
  response: z
    .object({
      id: z.string().optional(),
      model: z.string().optional(),
      output: z.array(record).optional(),
      usage: z
        .object({ input_tokens: z.number(), output_tokens: z.number() })
        .nullable()
        .optional(),
    })
    .passthrough()
    .optional(),
});

export interface ResponsesCheckpoint {
  accountId: string;
  model: string;
  history: ConversationMessage[];
  /** Provider output, including encrypted reasoning, is server-only continuation data. */
  input: Record<string, unknown>[];
}

export interface ResponsesSessionOptions {
  accountId: string;
  /** Explicit API credential resolved by the server; never inferred from another account. */
  apiKey: string;
  checkpoint?: ResponsesCheckpoint;
}

async function* readEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          // Never include provider payloads in parsing errors: they can contain private context.
          try {
            yield eventSchema.parse(JSON.parse(data));
          } catch {
            throw new Error('Invalid OpenAI response stream event');
          }
        }
      }
      if (buffer.length > 4 * 1024 * 1024)
        throw new Error('OpenAI response stream event is too large');
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function inputMessages(messages: ConversationMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message) => {
    if (message.role !== 'user')
      throw new Error('OpenAI resume requires a matching history checkpoint');
    if (typeof message.content === 'string') return [{ role: 'user', content: message.content }];
    return message.content.map((block): Record<string, unknown> => {
      if (block.type === 'text') return { role: 'user', content: block.text };
      if (block.type === 'tool_result')
        return { type: 'function_call_output', call_id: block.tool_use_id, output: block.content };
      throw new Error('Unsupported OpenAI input content block');
    });
  });
}

/** Direct API billing route. One instance belongs to one server-owned account binding. */
export class ResponsesSession implements ModelSession {
  readonly provider = 'openai';
  private state: ResponsesCheckpoint;
  private running = false;

  constructor(
    private config: ModelSessionConfig,
    private options: ResponsesSessionOptions,
  ) {
    if (!options.accountId.trim()) throw new Error('OpenAI account ID is required');
    if (options.checkpoint && options.checkpoint.accountId !== options.accountId)
      throw new Error('OpenAI checkpoint account does not match');
    if (!options.apiKey.trim()) throw new Error('OpenAI API key is required');
    if (config.thinking)
      throw new Error('Anthropic thinking budgets are unsupported by OpenAI Responses');
    if (options.checkpoint && options.checkpoint.model !== config.model)
      throw new Error('OpenAI checkpoint model does not match');
    this.state = structuredClone(
      options.checkpoint ?? {
        accountId: options.accountId,
        model: config.model,
        history: [],
        input: [],
      },
    );
  }

  /** Persist beside the account binding after a completed turn; never send to the phone. */
  checkpoint(): ResponsesCheckpoint {
    return structuredClone(this.state);
  }

  async *turn(messages: ConversationMessage[]): AsyncIterable<StreamEvent> {
    if (this.running) throw new Error('OpenAI session already has a running turn');
    if (
      JSON.stringify(messages.slice(0, this.state.history.length)) !==
      JSON.stringify(this.state.history)
    )
      throw new Error('OpenAI conversation history does not match its checkpoint');
    const input = [
      ...this.state.input,
      ...inputMessages(messages.slice(this.state.history.length)),
    ];
    this.running = true;
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        signal: this.config.signal,
        body: JSON.stringify({
          model: this.config.model,
          instructions: this.config.systemPrompt,
          max_output_tokens: this.config.maxTokens,
          stream: true,
          store: false,
          include: ['reasoning.encrypted_content'],
          input,
          tools: this.config.tools?.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
            strict: false,
          })),
        }),
      });
      if (!response.ok) throw new Error(`OpenAI API request failed (${response.status})`);
      if (!response.body) throw new Error('OpenAI response has no stream body');
      const blocks: ContentBlock[] = [];
      const indexes = new Map<string, number>();
      const argumentBuffers = new Map<number, string>();
      const closed = new Set<number>();
      let started = false;
      for await (const event of readEvents(response.body)) {
        this.config.signal?.throwIfAborted();
        if (event.type === 'response.created') {
          if (started || !event.response?.id) throw new Error('Invalid OpenAI response start');
          started = true;
          yield {
            type: 'message_start',
            message: {
              id: event.response.id,
              model: event.response.model ?? this.config.model,
              role: 'assistant',
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          };
        } else if (
          event.type === 'response.output_item.added' &&
          event.item?.type === 'function_call'
        ) {
          const id = z.string().parse(event.item.call_id);
          const name = z.string().parse(event.item.name);
          const index = blocks.length;
          indexes.set(`tool:${event.output_index}`, index);
          blocks.push({ type: 'tool_use', id, name, input: {} });
          argumentBuffers.set(index, '');
          yield {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name, input: {} },
          };
        } else if (
          event.type === 'response.content_part.added' &&
          ['output_text', 'refusal'].includes(String(event.part?.type))
        ) {
          const index = blocks.length;
          indexes.set(`text:${event.output_index}:${event.content_index}`, index);
          blocks.push({ type: 'text', text: '' });
          yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
        } else if (
          event.type === 'response.output_text.delta' ||
          event.type === 'response.refusal.delta'
        ) {
          const index = indexes.get(`text:${event.output_index}:${event.content_index}`);
          if (index === undefined || event.delta === undefined)
            throw new Error('Invalid OpenAI text delta');
          const block = blocks[index];
          if (block.type !== 'text') throw new Error('Invalid OpenAI text block');
          block.text += event.delta;
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: event.delta },
          };
        } else if (event.type === 'response.function_call_arguments.delta') {
          const index = indexes.get(`tool:${event.output_index}`);
          if (index === undefined || event.delta === undefined)
            throw new Error('Invalid OpenAI tool delta');
          argumentBuffers.set(index, argumentBuffers.get(index)! + event.delta);
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          };
        } else if (
          event.type === 'response.output_item.done' &&
          event.item?.type === 'function_call'
        ) {
          const index = indexes.get(`tool:${event.output_index}`);
          if (index === undefined) throw new Error('Invalid OpenAI tool completion');
          const block = blocks[index];
          if (block.type !== 'tool_use') throw new Error('Invalid OpenAI tool block');
          try {
            block.input = record.parse(JSON.parse(argumentBuffers.get(index)!));
          } catch {
            throw new Error('Invalid OpenAI tool arguments');
          }
          closed.add(index);
          yield { type: 'content_block_stop', index };
        } else if (event.type === 'response.content_part.done') {
          const index = indexes.get(`text:${event.output_index}:${event.content_index}`);
          if (index !== undefined) {
            closed.add(index);
            yield { type: 'content_block_stop', index };
          }
        } else if (event.type === 'response.completed') {
          if (
            !started ||
            !event.response?.output ||
            !event.response.usage ||
            closed.size !== blocks.length
          )
            throw new Error('Invalid OpenAI response completion');
          if (
            event.response.output.some(
              (item) => !['message', 'function_call', 'reasoning'].includes(String(item.type)),
            )
          )
            throw new Error('Unsupported OpenAI output item');
          this.state = structuredClone({
            accountId: this.options.accountId,
            model: this.config.model,
            input: [...input, ...event.response.output],
            history: [...messages, { role: 'assistant' as const, content: blocks }],
          });
          yield {
            type: 'message_delta',
            delta: {
              stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
            },
            usage: event.response.usage,
          };
          return;
        } else if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
          throw new Error('OpenAI response did not complete successfully');
        }
      }
      throw new Error('OpenAI stream ended without completion');
    } finally {
      this.running = false;
    }
  }
}
