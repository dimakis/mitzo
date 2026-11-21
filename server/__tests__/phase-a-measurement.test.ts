import { expect, it } from 'vitest';
import {
  summarizePhaseA,
  startPhaseAResources,
  type PhaseStart,
} from './fixtures/phase-a-measurement.js';
import type { TimingSpan } from './fixtures/prompt-trace-timing.js';

function fixture() {
  const commands = [
    { commandId: 'one', traceId: 'a'.repeat(32), kind: 'cold' as const },
    { commandId: 'two', traceId: 'b'.repeat(32), kind: 'queued' as const },
  ];
  const spans: TimingSpan[] = [];
  const starts: PhaseStart[] = [];
  function add(name: string, command: number, start: number, end: number, failed = false) {
    const spanId = String(spans.length + 1);
    const traceId = commands[command].traceId;
    const startTime: [number, number] = [0, start * 1e6];
    starts.push({ name, spanId, traceId, startTime });
    spans.push({
      name,
      startTime,
      endTime: [0, end * 1e6],
      spanContext: () => ({ traceId, spanId }),
      events: [],
      status: { code: failed ? 2 : 1 },
      attributes: {
        'mitzo.command.id': commands[command].commandId,
        'mitzo.route': 'chatgpt-subscription',
        'mitzo.account.id': 'ordinary-personal',
        'gen_ai.request.model': 'fixture-model',
        secret: 'DO NOT EXPORT',
      },
    });
  }
  add('codex.command.http', 0, 0, 5);
  add('codex.turn', 0, 5, 30);
  add('codex.command.http', 1, 10, 15);
  add('codex.turn', 1, 30, 50);
  add('local_codex.workspace_check', 0, 1, 2);
  add('local_codex.workspace_check', 0, 2, 3, true);
  add('local_codex.credential_check', 1, 11, 12);
  return { commands, spans, starts };
}

it('counts fast successes and failures per command without exporting raw attributes', () => {
  const f = fixture();
  const result = summarizePhaseA(f.spans, f.starts, f.commands);
  expect(result.coverage).toEqual({
    started: 3,
    ended: 3,
    unfinished: 0,
    unattributed: 0,
    complete: true,
  });
  expect(result.commands[0].checks.workspace_check).toEqual({ count: 2, failed: 1, wallMs: 2 });
  expect(result.commands[1].checks.credential_check.count).toBe(1);
  expect(result.commands[1].checks.workspace_check.count).toBe(0);
  expect(result.concurrency).toEqual({
    sessions: 1,
    commands: 2,
    maxOutstandingCommands: 2,
    maxActiveTurns: 1,
  });
  expect(result.route).toMatchObject({
    engine: 'codex',
    account: 'synthetic-personal',
    model: 'fixture-model',
    evidence: 'resolved turn spans',
  });
  expect(JSON.stringify(result)).not.toMatch(/DO NOT EXPORT|ordinary-personal|aaaaaaaa|"one"/);
});

it('reports missing and unattributed phase telemetry instead of a complete denominator', () => {
  const f = fixture();
  f.spans.pop();
  expect(summarizePhaseA(f.spans, f.starts, f.commands).coverage).toMatchObject({
    ended: 2,
    unfinished: 1,
    complete: false,
  });
  const other = fixture();
  other.spans[4].spanContext = () => ({ traceId: 'c'.repeat(32), spanId: '5' });
  other.starts[4].traceId = 'c'.repeat(32);
  expect(summarizePhaseA(other.spans, other.starts, other.commands).coverage).toMatchObject({
    unattributed: 1,
    complete: false,
  });
});

it('does not label absent check instrumentation as complete coverage', () => {
  const f = fixture();
  expect(
    summarizePhaseA(f.spans.slice(0, 4), f.starts.slice(0, 4), f.commands).coverage,
  ).toMatchObject({ started: 0, ended: 0, complete: false });
});

it.each([undefined, { code: 0 }])('refuses an unknown check outcome %j', (status) => {
  const f = fixture();
  f.spans[4].status = status;
  expect(() => summarizePhaseA(f.spans, f.starts, f.commands)).toThrow();
});

it.each(['duplicate', 'missing-start', 'nonfinite', 'reversed'])(
  'refuses %s phase data',
  (fault) => {
    const f = fixture();
    if (fault === 'duplicate') f.spans.push(f.spans[4]);
    if (fault === 'missing-start') f.starts.splice(4, 1);
    if (fault === 'nonfinite') f.spans[4].endTime = [0, NaN];
    if (fault === 'reversed') f.spans[4].endTime = [0, 0];
    expect(() => summarizePhaseA(f.spans, f.starts, f.commands)).toThrow();
  },
);

it.each(['missing', 'wrong-account', 'wrong-model', 'wrong-route'])(
  'refuses %s route attribution',
  (fault) => {
    const f = fixture();
    if (fault === 'missing')
      delete (f.spans[1].attributes as Record<string, unknown>)['mitzo.account.id'];
    if (fault === 'wrong-account')
      f.spans[1].attributes = { ...f.spans[1].attributes, 'mitzo.account.id': 'real-account' };
    if (fault === 'wrong-model')
      f.spans[3].attributes = { ...f.spans[3].attributes, 'gen_ai.request.model': 'paid-model' };
    if (fault === 'wrong-route')
      f.spans[3].attributes = { ...f.spans[3].attributes, 'mitzo.route': 'api' };
    expect(() => summarizePhaseA(f.spans, f.starts, f.commands)).toThrow();
  },
);

it('samples real process/host resources, stops idempotently and labels empty histograms honestly', async () => {
  const monitor = startPhaseAResources();
  await new Promise((resolve) => setTimeout(resolve, 55));
  const result = monitor.stop();
  expect(monitor.stop()).toBe(result);
  expect(result.elapsedMs).toBeGreaterThan(0);
  expect(result.process.cpuMs.user).toBeGreaterThanOrEqual(0);
  expect(result.process.memory.samples).toBeGreaterThanOrEqual(2);
  expect(result.process.memory.maxSampledRssBytes).toBeGreaterThanOrEqual(
    result.process.memory.startRssBytes,
  );
  expect(result.host.logicalCpus).toBeGreaterThan(0);
  expect(result.eventLoop.sampleCount).toBeGreaterThan(0);
  const empty = startPhaseAResources().stop();
  expect(empty.eventLoop.sampleCount).toBe(0);
  expect(empty.eventLoop.delayMs).toBeNull();
});
