import { afterAll, expect, it } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { observeLocalCodexPhase } from '../local-codex-observation.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());

it('parents nested startup checks to their actual phase across awaits', async () => {
  exporter.reset();
  await observeLocalCodexPhase('model_qualification', async () => {
    await Promise.resolve();
    return observeLocalCodexPhase('credential_check', async () => 'current');
  });
  const spans = exporter.getFinishedSpans();
  const parent = spans.find((span) => span.name === 'local_codex.model_qualification')!;
  const child = spans.find((span) => span.name === 'local_codex.credential_check')!;
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
});

it('records failures without copying private errors into telemetry', async () => {
  exporter.reset();
  const error = new Error('private-credential-diagnostic');
  await expect(
    observeLocalCodexPhase('workspace_check', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const span = exporter.getFinishedSpans()[0];
  expect(span.status.code).toBe(2);
  expect(
    JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }),
  ).not.toContain(error.message);
});
