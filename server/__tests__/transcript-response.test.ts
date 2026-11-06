import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { createSessionMessagesHandler } from '../session-messages-route.js';

vi.mock('../logger.js', () => ({ createLogger: () => ({ info: vi.fn() }) }));
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

function response() {
  const headers = new Map<string, unknown>();
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: false,
    getHeader: (key: string) => headers.get(key),
    send: vi.fn(function (this: unknown, body: string) {
      headers.set('content-length', Buffer.byteLength(body));
      return this;
    }),
    json(value: unknown) {
      return this.send(JSON.stringify(value));
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  });
  return res;
}

it('ends serialization before waiting for response completion, retaining only counts and a session fingerprint', async () => {
  const value = [{ messageId: 'private-message', blocks: [{ content: 'private-body' }] }];
  const handler = createSessionMessagesHandler({
    getMessages: async () => value,
    getSessionTranscript: async () => value,
    getReconnectTranscript: () => value,
  });
  const res = response();
  const send = res.send;
  await handler(
    { params: { id: 'private-session' }, query: {} } as unknown as Request,
    res as unknown as Response,
    vi.fn(),
  );
  expect(res.send).toBe(send);
  expect(exporter.getFinishedSpans().map((span) => span.name)).toContain('transcript.serialize');
  expect(exporter.getFinishedSpans().map((span) => span.name)).not.toContain(
    'transcript.response_write',
  );
  res.writableFinished = true;
  res.emit('finish');
  res.emit('close');
  const spans = exporter.getFinishedSpans();
  expect(spans.filter((span) => span.name === 'transcript.request')).toHaveLength(1);
  const request = spans.find((span) => span.name === 'transcript.request')!;
  const write = spans.find((span) => span.name === 'transcript.response_write')!;
  expect(write.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
  expect(write.attributes['transcript.response_bytes']).toBe(
    Buffer.byteLength(JSON.stringify(value)),
  );
  expect(request.attributes['transcript.variant']).toBe('messages');
  expect(request.attributes['transcript.messages_count']).toBe(1);
  expect(
    JSON.stringify(spans.map((span) => [span.attributes, span.events, span.status])),
  ).not.toMatch(/private-session|private-message|private-body/);
});

it('observes independent writes for coalesced reads and records an aborted response once', async () => {
  let complete!: (value: unknown) => void;
  const getMessages = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const handler = createSessionMessagesHandler({
    getMessages,
    getSessionTranscript: getMessages,
    getReconnectTranscript: () => [],
  });
  const req = { params: { id: 'session' }, query: {} } as unknown as Request;
  const first = response(),
    second = response();
  const pending = [
    handler(req, first as unknown as Response, vi.fn()),
    handler(req, second as unknown as Response, vi.fn()),
  ];
  await Promise.resolve();
  expect(getMessages).toHaveBeenCalledTimes(1);
  complete([]);
  await Promise.all(pending);
  first.writableFinished = true;
  first.emit('finish');
  second.emit('close');
  second.emit('close');
  const requests = exporter.getFinishedSpans().filter((span) => span.name === 'transcript.request');
  expect(requests).toHaveLength(2);
  expect(requests.map((span) => span.attributes['transcript.coalesced']).sort()).toEqual([
    false,
    true,
  ]);
  const writes = exporter
    .getFinishedSpans()
    .filter((span) => span.name === 'transcript.response_write');
  expect(writes).toHaveLength(2);
  expect(writes.filter((span) => span.status.code === 2)).toHaveLength(1);
});
