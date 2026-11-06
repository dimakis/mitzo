import { trace } from '@opentelemetry/api';
import { performance } from 'node:perf_hooks';
import { afterAll, expect, it, vi } from 'vitest';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  observeNativeApprovalCheck,
  observeLocalCodexPhase,
  observeLocalCodexSyncPhase,
} from '../local-codex-observation.js';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tracer } from '../tracing.js';

const diagnosticLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: diagnosticLog.info,
    error: vi.fn(),
    warn: diagnosticLog.warn,
  }),
}));

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
afterAll(() => provider.shutdown());

it.each(['span', 'logger'] as const)(
  'preserves successful artifacts and original failures when %s finalization throws',
  async (failure) => {
    const startSpan = tracer.startSpan.bind(tracer);
    const spy =
      failure === 'span'
        ? vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
            const span = startSpan(...args);
            span.end = () => {
              throw Error('Telemetry unavailable');
            };
            return span;
          })
        : undefined;
    diagnosticLog.warn.mockImplementation(() => {
      throw Error('Logger unavailable');
    });
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const artifact = { dispose: vi.fn() };
      const error = Error('Original operation failure');
      expect(
        await observeLocalCodexPhase('repository_object_capture', async () => {
          vi.advanceTimersByTime(600);
          return artifact;
        }),
      ).toBe(artifact);
      await expect(
        observeLocalCodexPhase('repository_object_capture', async () => {
          throw error;
        }),
      ).rejects.toBe(error);
      expect(
        observeLocalCodexSyncPhase('repository_object_capture', () => {
          vi.advanceTimersByTime(600);
          return artifact;
        }),
      ).toBe(artifact);
      expect(() =>
        observeLocalCodexSyncPhase('repository_object_capture', () => {
          throw error;
        }),
      ).toThrow(error);
    } finally {
      spy?.mockRestore();
      diagnosticLog.warn.mockReset();
      vi.useRealTimers();
    }
  },
);

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

it('retains slow successful phases at info level and reserves warnings for failures', async () => {
  diagnosticLog.warn.mockClear();
  diagnosticLog.info.mockClear();
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    await observeLocalCodexPhase('workspace_check', async () => {
      now = 600;
    });
    expect(diagnosticLog.info).toHaveBeenCalledOnce();
    expect(diagnosticLog.warn).not.toHaveBeenCalled();
    await expect(
      observeLocalCodexPhase('workspace_check', async () => {
        throw Error('unavailable');
      }),
    ).rejects.toThrow();
    expect(diagnosticLog.warn).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
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

it('adds no successful approval telemetry and preserves failures when diagnostics throw', () => {
  exporter.reset();
  const work = vi.fn();
  observeNativeApprovalCheck('reply', 'identity', work);
  expect(work).toHaveBeenCalledOnce();
  expect(exporter.getFinishedSpans()).toEqual([]);
  const error = new Error('private approval error');
  const getActiveSpan = vi.spyOn(trace, 'getActiveSpan').mockImplementation(() => {
    throw Error('telemetry unavailable');
  });
  try {
    expect(() =>
      observeNativeApprovalCheck('reply', 'execution_policy', () => {
        throw error;
      }),
    ).toThrow(error);
  } finally {
    getActiveSpan.mockRestore();
  }
});
