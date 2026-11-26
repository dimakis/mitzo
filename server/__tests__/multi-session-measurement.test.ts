import { expect, it } from 'vitest';
import {
  summarizeMultiSession,
  parseSessionCount,
  type LoadCommand,
} from './fixtures/multi-session-measurement.js';
import type { TimingSpan } from './fixtures/prompt-trace-timing.js';
import type { PhaseStart } from './fixtures/phase-a-measurement.js';

function fixture() {
  const spans: TimingSpan[] = [],
    starts: PhaseStart[] = [],
    commands: LoadCommand[] = [];
  for (let session = 0; session < 2; session++) {
    for (const [round, kind] of (['cold', 'warm', 'queued'] as const).entries()) {
      const index = commands.length,
        offset = round * 200 + session * 10;
      const command = {
        commandId: 'private-command-' + index,
        traceId: (index + 1).toString(16).repeat(32),
        sessionId: 'private-session-' + session,
        kind,
        issuedAt: [0, offset * 1e6] as const,
        batchAt: [0, round * 200e6] as const,
      };
      commands.push(command);
      const add = (name: string, start: number, end: number, parent?: TimingSpan) => {
        const spanId = String(spans.length + 1);
        const value: TimingSpan = {
          name,
          startTime: [0, (offset + start) * 1e6],
          endTime: [0, (offset + end) * 1e6],
          spanContext: () => ({ traceId: command.traceId, spanId }),
          parentSpanContext: parent && { spanId: parent.spanContext().spanId },
          events: [],
          status: { code: 1 },
          attributes: {
            'mitzo.command.id': command.commandId,
            'mitzo.route': 'chatgpt-subscription',
            'mitzo.account.id': 'ordinary-personal',
            'gen_ai.request.model': 'fixture-model',
            'mitzo.first_output.result': 'output',
            secret: 'DO NOT EXPORT',
          },
        };
        spans.push(value);
        starts.push({ name, ...value.spanContext(), startTime: value.startTime });
        return value;
      };
      add('codex.command.http', 5, 35);
      add('validation.admission.claim', 6, 8);
      add('codex.command.queue_wait', 10, 20);
      add('codex.command.preparation', 20, 25);
      const turn = add('codex.turn', 25, 100);
      add('codex.turn.dispatch', 25, 27, turn);
      add('codex.turn.acknowledgment', 25, 70, turn);
      add('codex.turn.first_output', 25, 90, turn);
      add('validation.turn.write', 26, 28).events = [
        { name: 'write_queued', time: [0, (offset + 27) * 1e6] },
      ];
      add('local_codex.workspace_check', 6, 7);
    }
  }
  return { spans, starts, commands };
}

it('measures cross-session overlap, ingress delay and equal-work completion spread without leaking identities', () => {
  const f = fixture(),
    result = summarizeMultiSession(f.spans, f.starts, f.commands, 2);
  expect(result.concurrency).toEqual({
    sessions: 2,
    commands: 6,
    maxOutstandingCommands: 2,
    maxActiveTurns: 2,
  });
  expect(result.samples[0].ms).toMatchObject({
    clientToHandler: 5,
    clientToWriteCompleted: 28,
    batchToWriteCompleted: 28,
    queueWait: 10,
  });
  expect(result.byKind.cold.clientToHandler).toMatchObject({ n: 2, min: 5, max: 5 });
  expect(result.byKind.cold.completionSpreadMs).toBe(10);
  expect(result.sessions.map((s) => s.commands.length)).toEqual([3, 3]);
  expect(JSON.stringify(result)).not.toMatch(
    /private-session|private-command|DO NOT EXPORT|ordinary-personal/,
  );
});

it.each([
  'lost-command',
  'duplicate-kind',
  'wrong-session',
  'missing-phase',
  'wrong-route',
  'late-issue',
  'nonfinite',
  'wrong-batch',
  'partial-phase',
])('rejects %s rather than reporting a successful or fair workload', (fault) => {
  const f = fixture();
  if (fault === 'lost-command') f.commands.pop();
  if (fault === 'duplicate-kind') f.commands[1].kind = 'cold';
  if (fault === 'wrong-session') f.commands[1].sessionId = 'other';
  if (fault === 'missing-phase')
    f.spans = f.spans.filter((s) => s.name !== 'local_codex.workspace_check');
  if (fault === 'wrong-route')
    f.spans[4].attributes = { ...f.spans[4].attributes, 'mitzo.route': 'api' };
  if (fault === 'late-issue') f.commands[0].issuedAt = [0, 999e6];
  if (fault === 'nonfinite') f.commands[0].issuedAt = [0, NaN];
  if (fault === 'wrong-batch') f.commands[3].batchAt = [0, 1e6];
  if (fault === 'partial-phase') {
    const removed = f.spans.find((s) => s.name === 'local_codex.workspace_check')!;
    f.spans = f.spans.filter((s) => s !== removed);
    f.starts = f.starts.filter((s) => s.spanId !== removed.spanContext().spanId);
  }
  expect(() => summarizeMultiSession(f.spans, f.starts, f.commands, 2)).toThrow();
});

it.each(['0', '9', '1.5', 'NaN', '', '200'])('refuses unbounded workload %s', (value) =>
  expect(() => parseSessionCount(value)).toThrow(),
);
it.each(['1', '2', '4', '8'])('accepts bounded workload %s', (value) =>
  expect(parseSessionCount(value)).toBe(Number(value)),
);
