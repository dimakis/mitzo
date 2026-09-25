import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { ResponsesSession } from '../src/providers/responses-session.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const config = { model: 'test-model', systemPrompt: 'private instructions', maxTokens: 100 };
const messages = [{ role: 'user' as const, content: 'private prompt' }];

function session(signal?: AbortSignal) {
  return new ResponsesSession(
    { ...config, signal },
    { accountId: 'api-account', apiKey: 'secret-key' },
  );
}

function stream(events: object[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          ),
        );
        controller.close();
      },
    }),
  );
}

const completed = [
  { type: 'response.created', response: { id: 'resp-1', model: 'test-model' } },
  {
    type: 'response.completed',
    response: { output: [], usage: { input_tokens: 1, output_tokens: 2 } },
  },
];

beforeAll(() => provider.register());
afterAll(() => {
  trace.disable();
  context.disable();
});
afterEach(() => {
  exporter.reset();
  vi.unstubAllGlobals();
});

describe('OpenAI Responses request tracing', () => {
  it('creates one child span at turn invocation and keeps it open through the stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(completed)));
    const parent = trace.getTracer('test').startSpan('parent');
    const turn = context.with(trace.setSpan(context.active(), parent), () =>
      session().turn(messages),
    );
    parent.end();

    const iterator = turn[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'message_start' });
    expect(
      exporter.getFinishedSpans().filter((span) => span.name === 'openai.responses.create'),
    ).toHaveLength(0);
    await Array.fromAsync({ [Symbol.asyncIterator]: () => iterator });

    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'openai.responses.create');
    expect(spans).toHaveLength(1);
    expect(spans[0].parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(spans[0].status.code).toBe(SpanStatusCode.OK);
    expect(spans[0].attributes).toMatchObject({
      'mitzo.route': 'openai-api',
      'gen_ai.request.model': 'test-model',
      'http.response.status_code': 200,
    });
    expect(JSON.stringify(spans[0].attributes)).not.toMatch(
      /secret-key|private prompt|private instructions|api-account/,
    );
  });

  it('records a bounded HTTP failure without retaining provider diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { message: 'private response', code: 'private-code' } }),
            { status: 429 },
          ),
        ),
    );
    await expect(Array.fromAsync(session().turn(messages))).rejects.toMatchObject({
      status: 429,
      code: 'private-code',
    });
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'http.response.status_code': 429,
      'mitzo.failure.category': 'http',
    });
    expect(
      JSON.stringify({ attributes: span.attributes, status: span.status, events: span.events }),
    ).not.toMatch(/secret-key|private response|private-code|private prompt/);
  });

  it('ends the span after a stream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        stream([
          { type: 'response.created', response: { id: 'resp-1' } },
          { type: 'response.failed', response: { error: { message: 'private response' } } },
        ]),
      ),
    );
    await expect(Array.fromAsync(session().turn(messages))).rejects.toThrow();
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['mitzo.failure.category']).toBe('stream');
    expect(
      JSON.stringify({ attributes: span.attributes, status: span.status, events: span.events }),
    ).not.toContain('private response');
  });

  it('ends the span when a consumer stops early', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream(completed)));
    const iterator = session().turn(messages)[Symbol.asyncIterator]();
    await iterator.next();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await iterator.return?.();
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['mitzo.failure.category']).toBe('cancelled');
  });
});
