import { afterAll, expect, it } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { observeLocalCodexPhase, observeLocalCodexSyncPhase } from '../local-codex-observation.js';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

it('marks a returned native tool error as failed without throwing, changing the result or retaining private text', async () => {
  exporter.reset();
  const result = {
    success: false,
    contentItems: [{ type: 'inputText', text: 'private-tool-result' }],
  };
  expect(await observeLocalCodexPhase('host_tool_execution', async () => result)).toBe(result);
  const span = exporter.getFinishedSpans()[0];
  expect(span.status.code).toBe(2);
  expect(span.attributes['phase.outcome']).toBe('failed');
  expect(
    JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }),
  ).not.toContain('private-tool-result');
});

it('keeps a non-tool success field out of phase failure classification', async () => {
  exporter.reset();
  const result = { success: false };
  expect(await observeLocalCodexPhase('model_qualification', async () => result)).toBe(result);
  expect(exporter.getFinishedSpans()[0].status.code).toBe(1);
});

it('does not execute result accessors or let diagnostic inspection reject an otherwise fulfilled RPC', async () => {
  exporter.reset();
  let reads = 0;
  const result = {
    get success() {
      reads++;
      throw Error('private accessor');
    },
  };
  expect(await observeLocalCodexPhase('host_tool_execution', async () => result)).toBe(result);
  expect(reads).toBe(0);
  const opaque = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error('private proxy');
      },
    },
  );
  expect(await observeLocalCodexPhase('host_tool_execution', async () => opaque)).toBe(opaque);
});

it('times synchronous native capture and launch integrity beneath the active startup phase', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'offline-native-spans-')));
  try {
    const home = join(root, 'home'),
      source = join(root, 'source');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1]), { mode: 0o755 });
    exporter.reset();
    await observeLocalCodexPhase('bootstrap', async () => {
      const executable = FrozenHostCodexExecutable.capture(source, home);
      executable.assertLaunchCurrent();
      const error = new Error('private native failure');
      expect(() =>
        observeLocalCodexSyncPhase('native_version_check', () => {
          throw error;
        }),
      ).toThrow(error);
    });
    const spans = exporter.getFinishedSpans();
    const bootstrap = spans.find((s) => s.name === 'local_codex.bootstrap')!;
    for (const name of ['native_capture', 'native_launch_integrity', 'native_version_check']) {
      const span = spans.find((s) => s.name === 'local_codex.' + name)!;
      expect(span, name).toBeDefined();
      expect(span.parentSpanContext?.spanId).toBe(bootstrap.spanContext().spanId);
      expect(
        JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }),
      ).not.toMatch(/private native failure|offline-native-spans/);
    }
    expect(spans.find((s) => s.name === 'local_codex.native_version_check')?.status.code).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
