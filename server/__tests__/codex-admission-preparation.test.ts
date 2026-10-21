import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  admissionPhase,
  admissionLifecycle,
  prepareKnowledgeAndCapabilities,
} from '../codex-admission-preparation.js';

const telemetry = vi.hoisted(() => ({
  spans: [] as {
    name: string;
    setStatus: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setAttribute: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    spanContext: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('../tracing.js', () => ({
  tracer: {
    startSpan: (name: string) => {
      const span = {
        name,
        setStatus: vi.fn(),
        end: vi.fn(),
        setAttribute: vi.fn(),
        recordException: vi.fn(),
        spanContext: vi.fn(),
      };
      telemetry.spans.push(span);
      return span;
    },
  },
}));
afterEach(() => {
  telemetry.spans.length = 0;
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('per-command knowledge and read-only inventory preparation', () => {
  it('starts both operations and waits for their longer critical path', async () => {
    const knowledge = deferred<string>();
    const inventory = deferred<string>();
    const select = vi.fn(() => knowledge.promise);
    const inspect = vi.fn(() => inventory.promise);
    let completed = false;
    const preparing = prepareKnowledgeAndCapabilities(select, inspect);
    void preparing.then(() => (completed = true));
    expect(select).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    knowledge.resolve('fresh selection');
    await tick();
    expect(completed).toBe(false);
    inventory.resolve('fresh inventory');
    await expect(preparing).resolves.toEqual(['fresh selection', 'fresh inventory']);
    expect(telemetry.spans.map((s) => s.name)).toEqual([
      'codex.admission.knowledge',
      'codex.admission.task_capabilities',
    ]);
    expect(telemetry.spans.every((s) => s.end.mock.calls.length === 1)).toBe(true);
  });

  it.each(['knowledge', 'inventory'] as const)(
    'does not release the caller when %s fails while the other operation is running',
    async (failed) => {
      const knowledge = deferred<string>();
      const inventory = deferred<string>();
      const error = new Error('private diagnostic /task/credential-value');
      let settled = false;
      const preparing = prepareKnowledgeAndCapabilities(
        () => knowledge.promise,
        () => inventory.promise,
      );
      void preparing.then(
        () => (settled = true),
        () => (settled = true),
      );
      const first = failed === 'knowledge' ? knowledge : inventory;
      const second = failed === 'knowledge' ? inventory : knowledge;
      first.reject(error);
      await tick();
      expect(settled).toBe(false);
      expect(telemetry.spans.filter((s) => s.end.mock.calls.length)).toHaveLength(1);
      second.resolve('complete');
      await expect(preparing).rejects.toBe(error);
      expect(telemetry.spans.every((s) => s.end.mock.calls.length === 1)).toBe(true);
      expect(telemetry.spans.every((s) => s.recordException.mock.calls.length === 0)).toBe(true);
      expect(telemetry.spans.every((s) => s.setAttribute.mock.calls.length === 0)).toBe(true);
      expect(telemetry.spans.flatMap((s) => s.setStatus.mock.calls)).not.toContainEqual([
        expect.objectContaining({ message: expect.anything() }),
      ]);
    },
  );

  it('retains knowledge failure precedence when both fail, including cancellation', async () => {
    const abort = new AbortController();
    const knowledge = deferred<string>();
    const inventory = deferred<string>();
    const preparing = prepareKnowledgeAndCapabilities(
      () => knowledge.promise,
      () => inventory.promise,
    );
    void preparing.catch(() => {});
    abort.abort();
    inventory.reject(new Error('inventory aborted'));
    knowledge.reject(abort.signal.reason);
    await expect(preparing).rejects.toBe(abort.signal.reason);
  });

  it('takes a fresh observation for every invocation', async () => {
    const knowledge = vi
      .fn()
      .mockResolvedValueOnce('revision A')
      .mockResolvedValueOnce('revision B');
    const inventory = vi.fn().mockResolvedValueOnce('present').mockResolvedValueOnce('absent');
    await expect(prepareKnowledgeAndCapabilities(knowledge, inventory)).resolves.toEqual([
      'revision A',
      'present',
    ]);
    await expect(prepareKnowledgeAndCapabilities(knowledge, inventory)).resolves.toEqual([
      'revision B',
      'absent',
    ]);
    expect(knowledge).toHaveBeenCalledTimes(2);
    expect(inventory).toHaveBeenCalledTimes(2);
  });
});

it('ends and redacts a failed admission phase, including synchronous errors', async () => {
  const error = new Error('secret CLI stderr');
  await expect(
    admissionPhase('provider_environment', () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const span = telemetry.spans[0];
  expect(span.name).toBe('codex.admission.provider_environment');
  expect(span.setStatus).toHaveBeenCalledExactlyOnceWith({ code: SpanStatusCode.ERROR });
  expect(span.end).toHaveBeenCalledOnce();
  expect(span.recordException).not.toHaveBeenCalled();
  expect(span.setAttribute).not.toHaveBeenCalled();
});

it('measures lifecycle waiting without ending the operation span before the lock is released', async () => {
  const acquire = deferred<void>();
  const complete = deferred<string>();
  const work = vi.fn(() => admissionPhase('provider_environment', () => complete.promise));
  const admission = admissionLifecycle(async (run) => {
    await acquire.promise;
    return run();
  }, work);
  const waiting = telemetry.spans[0];
  expect(waiting.name).toBe('codex.admission.lifecycle_wait');
  expect(waiting.end).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
  acquire.resolve();
  await tick();
  expect(waiting.end).toHaveBeenCalledOnce();
  expect(work).toHaveBeenCalledOnce();
  expect(telemetry.spans[1].end).not.toHaveBeenCalled();
  complete.resolve('prepared');
  await expect(admission).resolves.toBe('prepared');
  expect(telemetry.spans[1].end).toHaveBeenCalledOnce();
});

it('ends the lifecycle wait span if admission is refused before the operation starts', async () => {
  const work = vi.fn();
  const error = new Error('private lifecycle identity');
  await expect(
    admissionLifecycle(async () => {
      throw error;
    }, work),
  ).rejects.toBe(error);
  expect(work).not.toHaveBeenCalled();
  expect(telemetry.spans[0].setStatus).toHaveBeenCalledExactlyOnceWith({
    code: SpanStatusCode.ERROR,
  });
  expect(telemetry.spans[0].end).toHaveBeenCalledOnce();
});
