import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { trace } from '@opentelemetry/api';
const observed = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: () => observed }));
import { githubPublicationPreflight } from '../github-publication-preflight.js';
import { GithubPublicationReviewError } from '../github-publication-review-failure.js';
import { GithubSeedPublicationError } from '../github-seeded-source.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());
beforeEach(() => {
  exporter.reset();
  observed.warn.mockReset();
});

it('parents preflight to the invoking tool and records successful phase events without task input', async () => {
  const result = await trace
    .getTracer('mitzo')
    .startActiveSpan('tool.RequestGithubPublish', async (parent) => {
      try {
        return await githubPublicationPreflight(
          'operation',
          new AbortController().signal,
          async (phase) => {
            phase('inspection');
            await Promise.resolve();
            phase('review');
            return 'prepared';
          },
        );
      } finally {
        parent.end();
      }
    });
  expect(result).toBe('prepared');
  const spans = exporter.getFinishedSpans();
  const parent = spans.find((s) => s.name === 'tool.RequestGithubPublish')!;
  const span = spans.find((s) => s.name === 'github.publication.preflight')!;
  expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(span.attributes).toMatchObject({
    'publication.operation_id': 'operation',
    'publication.stage': 'review',
  });
  expect(span.events.map((event) => event.attributes?.['publication.stage'])).toEqual([
    'inspection',
    'review',
  ]);
  expect(span.status.code).toBe(1);
  expect(observed.warn).not.toHaveBeenCalled();
});

it('correlates a failing phase to the durable operation without leaking command diagnostics', async () => {
  const secret = 'https://credential@github.com/private/repo?token=SECRET';
  await expect(
    githubPublicationPreflight('operation', new AbortController().signal, async (phase) => {
      phase('reconstruction');
      throw Error(secret);
    }),
  ).rejects.toMatchObject({
    code: 'PUBLICATION_PREFLIGHT_FAILED',
    details: { stage: 'reconstruction' },
  });
  const span = exporter.getFinishedSpans()[0];
  expect(span.attributes).toMatchObject({
    'publication.operation_id': 'operation',
    'publication.stage': 'reconstruction',
    'publication.failure_code': 'PUBLICATION_PREFLIGHT_FAILED',
  });
  expect(span.status.code).toBe(2);
  expect(observed.warn).toHaveBeenCalledWith('GitHub publication preflight failed', {
    operationId: 'operation',
    stage: 'reconstruction',
    code: 'PUBLICATION_PREFLIGHT_FAILED',
  });
  expect(
    JSON.stringify({
      attributes: span.attributes,
      events: span.events,
      status: span.status,
      logs: observed.warn.mock.calls,
    }),
  ).not.toMatch(/credential|private\/repo|SECRET/);
});

it.each([
  new GithubPublicationReviewError('PUBLICATION_REVIEW_BLOCKED', { findings: [] }),
  new GithubSeedPublicationError('SEEDED_WORKSPACE_DIRTY', 'Commit outstanding work'),
])('preserves trusted review/seed diagnostics and their identity', async (failure) => {
  await expect(
    githubPublicationPreflight('operation', new AbortController().signal, async (phase) => {
      phase('review');
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(exporter.getFinishedSpans()[0].attributes['publication.failure_code']).toBe(failure.code);
});

it('preserves cancellation without exposing a private abort reason or retrying work', async () => {
  const controller = new AbortController();
  await expect(
    githubPublicationPreflight('operation', controller.signal, async (phase) => {
      phase('export');
      controller.abort(Error('private abort reason'));
      controller.signal.throwIfAborted();
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(exporter.getFinishedSpans()[0].attributes['publication.failure_code']).toBe('CANCELLED');
  expect(JSON.stringify(observed.warn.mock.calls)).not.toContain('private abort reason');
});
