import { expect, it } from 'vitest';
import { summarizePromptTiming, type TimingSpan } from '../../scripts/lib/prompt-trace-timing.js';

const traceId = 'a'.repeat(32);
function fixture() {
  const spans: TimingSpan[] = [];
  function span(name: string, start: number, end: number, parent?: string) {
    const spanId = String(spans.length + 1).padStart(16, '0');
    const value: TimingSpan = {
      name,
      startTime: [0, start * 1e6],
      endTime: [0, end * 1e6],
      spanContext: () => ({ traceId, spanId }),
      parentSpanContext: parent ? { spanId: parent } : undefined,
      attributes: { 'mitzo.command.id': 'raw-command-sensitive', secret: 'DO NOT EXPORT' },
      events: [],
    };
    spans.push(value);
    return value;
  }
  span('codex.command.http', 0, 40);
  span('validation.admission.claim', 4, 8);
  span('codex.command.queue_wait', 10, 20);
  span('codex.command.preparation', 20, 25);
  const turn = span('codex.turn', 25, 100);
  for (const [name, end] of [
    ['dispatch', 27],
    ['acknowledgment', 70],
    ['first_output', 90],
  ] as const)
    span('codex.turn.' + name, 25, end, turn.spanContext().spanId);
  spans[7].attributes = { ...spans[7].attributes, 'mitzo.first_output.result': 'output' };
  const write = span('validation.turn.write', 26, 28);
  write.events = [{ name: 'write_queued', time: [0, 27e6] }];
  return {
    spans,
    expected: [{ commandId: 'raw-command-sensitive', traceId, kind: 'cold' as const }],
  };
}
it('separates durable queue, preparation, actual stream submission, ACK and output and exports only allowlisted data', () => {
  const f = fixture();
  const result = summarizePromptTiming(f.spans, f.expected);
  expect(result.samples[0].ms).toMatchObject({
    serverToDurableAdmission: 8,
    admissionToDurableQueue: 2,
    serverToDurableQueue: 10,
    queueWait: 10,
    preparation: 5,
    serverToWriteQueued: 27,
    streamWrite: 2,
    writeCompletedToAck: 42,
    ackToFirstOutput: 20,
    invocation: 2,
  });
  expect(result.summary.cold).toMatchObject({ n: 1, median: 28, min: 28, max: 28 });
  expect(result.summary.cold).not.toHaveProperty('p95');
  expect(JSON.stringify(result)).not.toContain('DO NOT EXPORT');
  expect(JSON.stringify(result)).not.toContain('raw-command-sensitive');
});
it.each([
  'validation.admission.claim',
  'codex.command.http',
  'codex.command.queue_wait',
  'codex.command.preparation',
  'codex.turn.dispatch',
  'codex.turn.acknowledgment',
  'codex.turn.first_output',
  'validation.turn.write',
])('refuses missing or duplicate %s instead of reporting a misleading latency', (name) => {
  const f = fixture();
  expect(() =>
    summarizePromptTiming(
      f.spans.filter((s) => s.name !== name),
      f.expected,
    ),
  ).toThrow();
  expect(() =>
    summarizePromptTiming([...f.spans, f.spans.find((s) => s.name === name)!], f.expected),
  ).toThrow();
});
it('refuses wrong command trace, bad ancestry, missing write completion, reversed order and exceeded opt-in budget', () => {
  const f = fixture();
  const original = f.spans[2].spanContext;
  f.spans[2].spanContext = () => ({ ...original(), traceId: 'b'.repeat(32) });
  expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow();
  f.spans[2].spanContext = original;
  f.spans[5].parentSpanContext = { spanId: 'wrong' };
  expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow();
  f.spans[5].parentSpanContext = { spanId: f.spans[4].spanContext().spanId };
  f.spans[8].events = [];
  expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow();
  f.spans[8].events = [{ name: 'write_queued', time: [0, 71e6] }];
  expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow();
  const valid = fixture();
  expect(() => summarizePromptTiming(valid.spans, valid.expected, 16)).toThrow('budget');
});
it('a delayed provider ACK does not inflate the application dispatch metric', () => {
  const f = fixture();
  const before = summarizePromptTiming(f.spans, f.expected);
  f.spans[6].endTime = [0, 80e6];
  const after = summarizePromptTiming(f.spans, f.expected);
  expect(after.samples[0].ms.serverToWriteQueued).toBe(before.samples[0].ms.serverToWriteQueued);
  expect(after.samples[0].ms.writeCompletedToAck).toBe(52);
});

it('accepts legitimate assistant output before the RPC ACK without summing overlapping spans', () => {
  const f = fixture();
  f.spans[6].endTime = [0, 95e6];
  expect(summarizePromptTiming(f.spans, f.expected).samples[0].ms.ackToFirstOutput).toBe(-5);
});

it('reports honest sample counts and adds nearest-rank p95 only with at least twenty samples', async () => {
  const { promptTimingSummary } = await import('../../scripts/lib/prompt-trace-timing.js');
  const samples = Array.from({ length: 20 }, (_, i) => ({
    kind: 'warm' as const,
    ms: { serverToWriteCompleted: i + 1 },
  }));
  expect(promptTimingSummary(samples).warm).toEqual({
    n: 20,
    median: 10.5,
    min: 1,
    max: 20,
    p95: 19,
  });
  expect(promptTimingSummary(samples.slice(0, 19)).warm).not.toHaveProperty('p95');
});

it('refuses terminal completion without accepted assistant output', () => {
  const f = fixture();
  f.spans[7].attributes = { 'mitzo.first_output.result': 'terminal_before_output' };
  expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow('no accepted assistant output');
});

it.each(['dispatch', 'acknowledgment', 'first_output'])(
  'refuses nonfinite %s boundaries instead of exporting null latency',
  (name) => {
    for (const value of [NaN, Infinity]) {
      const f = fixture();
      f.spans.find((span) => span.name === 'codex.turn.' + name)!.endTime = [0, value];
      expect(() => summarizePromptTiming(f.spans, f.expected)).toThrow();
    }
  },
);
