import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  ContentBlock,
  ConversationMessage,
  ModelSession,
  ModelSessionConfig,
  ResponsesCheckpoint,
  StreamEvent,
} from '@mitzo/harness';

const Part = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        name: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        id: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
const Content = z.object({ role: z.string(), parts: z.array(Part) });
const ResponseBody = z.object({
  candidates: z.array(z.object({ content: Content, finishReason: z.string() })),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
    })
    .optional(),
});
export interface GeminiOptions {
  accountId: string;
  projectId: string;
  region: string;
  getAccessToken(): Promise<string>;
  checkpoint?: ResponsesCheckpoint;
}
const toolName = (name: string) =>
  `tool_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
const callId = (contentIndex: number, partIndex: number) =>
  `gemini-call-${contentIndex}-${partIndex}`;

/** Native Gemini turns. Raw signed parts stay in the private checkpoint, never the public transcript. */
export class GeminiSession implements ModelSession {
  readonly provider = 'google-vertex';
  private state: ResponsesCheckpoint;
  private running = false;
  constructor(
    private config: ModelSessionConfig,
    private options: GeminiOptions,
  ) {
    if (
      !options.accountId ||
      !options.projectId ||
      !/^[a-z0-9-]+$/.test(options.region) ||
      !/^gemini-[a-zA-Z0-9.-]+$/.test(config.model)
    )
      throw new Error('Invalid Gemini account route');
    if (
      options.checkpoint &&
      (options.checkpoint.accountId !== options.accountId ||
        options.checkpoint.model !== config.model)
    )
      throw new Error('Gemini checkpoint account/model does not match');
    this.state = structuredClone(
      options.checkpoint ?? {
        accountId: options.accountId,
        model: config.model,
        history: [],
        input: [],
      },
    );
  }
  checkpoint(): ResponsesCheckpoint {
    return structuredClone(this.state);
  }
  async *turn(messages: ConversationMessage[]): AsyncIterable<StreamEvent> {
    if (this.running) throw new Error('Gemini session already running');
    if (!isDeepStrictEqual(messages.slice(0, this.state.history.length), this.state.history))
      throw new Error('Gemini history does not match checkpoint');
    this.config.signal?.throwIfAborted();
    const input = structuredClone(this.state.input);
    const calls = new Map<string, { name: string; id?: string }>();
    input.forEach((content, ci) =>
      Content.parse(content).parts.forEach((part, pi) => {
        if (part.functionCall) calls.set(callId(ci, pi), part.functionCall);
      }),
    );
    for (const message of messages.slice(this.state.history.length)) {
      if (message.role !== 'user')
        throw new Error('Gemini assistant history requires a checkpoint');
      const parts =
        typeof message.content === 'string'
          ? [{ text: message.content }]
          : message.content.map((block) => {
              if (block.type === 'text') return { text: block.text };
              if (block.type !== 'tool_result') throw new Error('Unsupported Gemini input');
              const call = calls.get(block.tool_use_id);
              if (!call) throw new Error('Unknown Gemini tool result');
              return {
                functionResponse: {
                  name: call.name,
                  ...(call.id ? { id: call.id } : {}),
                  response: block.is_error ? { error: block.content } : { output: block.content },
                },
              };
            });
      input.push({ role: 'user', parts });
    }
    this.running = true;
    try {
      const token = await this.options.getAccessToken();
      if (!token) throw new Error('Gemini credentials unavailable');
      this.config.signal?.throwIfAborted();
      const host =
        this.options.region === 'global'
          ? 'aiplatform.googleapis.com'
          : `${this.options.region}-aiplatform.googleapis.com`;
      const response = await fetch(
        `https://${host}/v1/projects/${encodeURIComponent(this.options.projectId)}/locations/${this.options.region}/publishers/google/models/${this.config.model}:generateContent`,
        {
          method: 'POST',
          signal: this.config.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: input,
            systemInstruction: { parts: [{ text: this.config.systemPrompt }] },
            generationConfig: { maxOutputTokens: this.config.maxTokens },
            ...(this.config.tools?.length
              ? {
                  tools: [
                    {
                      functionDeclarations: this.config.tools.map((t) => ({
                        name: toolName(t.name),
                        description: t.description,
                        parametersJsonSchema: t.input_schema,
                      })),
                    },
                  ],
                }
              : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
      const parsed = ResponseBody.safeParse(await response.json());
      const candidate = parsed.success ? parsed.data.candidates[0] : undefined;
      if (
        !parsed.success ||
        !candidate ||
        candidate.finishReason !== 'STOP' ||
        !candidate.content.parts.length
      )
        throw new Error('Gemini response did not complete successfully');
      const blocks: ContentBlock[] = [];
      for (const [pi, part] of candidate.content.parts.entries()) {
        if (part.functionCall) {
          const tool = this.config.tools?.find((t) => toolName(t.name) === part.functionCall!.name);
          if (!tool) throw new Error('Gemini requested an unknown tool');
          blocks.push({
            type: 'tool_use',
            id: callId(input.length, pi),
            name: tool.name,
            input: part.functionCall.args ?? {},
          });
        } else if (part.text !== undefined) {
          blocks.push(
            part.thought
              ? { type: 'thinking', thinking: part.text }
              : { type: 'text', text: part.text },
          );
        } else if (!part.thoughtSignature) throw new Error('Unsupported Gemini output');
      }
      if (!blocks.length) throw new Error('Gemini response has no usable output');
      this.config.signal?.throwIfAborted();
      yield {
        type: 'message_start',
        message: {
          id: randomUUID(),
          model: this.config.model,
          role: 'assistant',
          usage: {
            input_tokens: parsed.data.usageMetadata?.promptTokenCount ?? 0,
            output_tokens: 0,
          },
        },
      };
      for (const [index, block] of blocks.entries()) {
        yield {
          type: 'content_block_start',
          index,
          content_block:
            block.type === 'tool_use'
              ? { ...block, input: {} }
              : block.type === 'thinking'
                ? { type: 'thinking', thinking: '' }
                : { type: 'text', text: '' },
        };
        yield {
          type: 'content_block_delta',
          index,
          delta:
            block.type === 'tool_use'
              ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
              : block.type === 'thinking'
                ? { type: 'thinking_delta', thinking: block.thinking }
                : { type: 'text_delta', text: block.type === 'text' ? block.text : '' },
        };
        yield { type: 'content_block_stop', index };
      }
      this.state = structuredClone({
        accountId: this.options.accountId,
        model: this.config.model,
        history: [...messages, { role: 'assistant' as const, content: blocks }],
        input: [...input, candidate.content],
      });
      yield {
        type: 'message_delta',
        delta: { stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' },
        usage: {
          output_tokens:
            (parsed.data.usageMetadata?.candidatesTokenCount ?? 0) +
            (parsed.data.usageMetadata?.thoughtsTokenCount ?? 0),
        },
      };
    } finally {
      this.running = false;
    }
  }
}
