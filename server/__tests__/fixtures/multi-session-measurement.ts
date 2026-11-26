/** Bounded offline workload reduction. Session aliases are assigned by submission order. */
import { summarizePhaseA, type PhaseStart } from './phase-a-measurement.js';
import {
  summarizePromptTiming,
  type PromptTimingCommand,
  type TimingSpan,
} from './prompt-trace-timing.js';

export type LoadCommand = PromptTimingCommand & {
  sessionId: string;
  issuedAt: readonly [number, number];
  batchAt: readonly [number, number];
};
export function parseSessionCount(value: string) {
  if (!/^[1-8]$/.test(value)) throw Error('Offline workload requires 1–8 sessions');
  return Number(value);
}
const ms = (value: readonly [number, number]) => value[0] * 1000 + value[1] / 1e6;
const round = (value: number) => Math.round(value * 1000) / 1000;
function peak(intervals: number[][]) {
  const edges = intervals
    .flatMap(([start, end]) =>
      start === end
        ? []
        : [
            [start, 1],
            [end, -1],
          ],
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    maximum = 0;
  for (const [, delta] of edges) maximum = Math.max(maximum, (active += delta));
  return maximum;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return {
    n,
    min: sorted[0],
    median: round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2),
    max: sorted[n - 1],
    mean: round(sorted.reduce((a, b) => a + b, 0) / n),
  };
}

export function summarizeMultiSession(
  spans: readonly TimingSpan[],
  starts: readonly PhaseStart[],
  commands: readonly LoadCommand[],
  sessionCount: number,
) {
  parseSessionCount(String(sessionCount));
  const identities = [...new Set(commands.map((c) => c.sessionId))];
  if (
    identities.length !== sessionCount ||
    commands.length !== sessionCount * 3 ||
    identities.some((id) => !id)
  )
    throw Error('Incomplete multi-session workload');
  const kinds = ['cold', 'warm', 'queued'] as const;
  for (const id of identities)
    if (
      kinds.some(
        (kind) => commands.filter((c) => c.sessionId === id && c.kind === kind).length !== 1,
      )
    )
      throw Error('Unequal or duplicate session workload');
  for (const kind of kinds)
    if (new Set(commands.filter((c) => c.kind === kind).map((c) => ms(c.batchAt))).size !== 1)
      throw Error('Commands must share a batch release boundary');
  // Validate globally before partitioning: otherwise orphan starts disappear from the denominator.
  const complete = summarizePhaseA(spans, starts, commands);
  if (!complete.coverage.complete) throw Error('Incomplete Phase A instrumentation');
  const timing = summarizePromptTiming(spans, commands);
  const outstanding: number[][] = [],
    active: number[][] = [];
  const samples = timing.samples.map((sample, index) => {
    const command = commands[index];
    const owned = (name: string) =>
      spans.find((s) => s.name === name && s.attributes['mitzo.command.id'] === command.commandId)!;
    // summarizePromptTiming above has already validated identity, count, ancestry and ordering.
    const http = owned('codex.command.http'),
      turn = owned('codex.turn'),
      write = owned('validation.turn.write');
    const issue = ms(command.issuedAt),
      batch = ms(command.batchAt),
      handler = ms(http.startTime);
    if (![issue, batch].every(Number.isFinite) || batch > issue || issue > handler)
      throw Error('Invalid client/batch timing boundary');
    outstanding.push([handler, ms(turn.endTime)]);
    active.push([ms(turn.startTime), ms(turn.endTime)]);
    return {
      sample: index + 1,
      session: identities.indexOf(command.sessionId) + 1,
      kind: command.kind,
      ms: {
        ...sample.ms,
        submissionSkew: round(issue - batch),
        clientToHandler: round(handler - issue),
        clientToWriteCompleted: round(ms(write.endTime) - issue),
        batchToWriteCompleted: round(ms(write.endTime) - batch),
        batchToTurnCompleted: round(ms(turn.endTime) - batch),
      },
      admissionPhases: sample.admissionPhases,
    };
  });
  return {
    version: 1,
    route: complete.route,
    coverage: complete.coverage,
    concurrency: {
      sessions: identities.length,
      commands: commands.length,
      maxOutstandingCommands: peak(outstanding),
      maxActiveTurns: peak(active),
    },
    byKind: Object.fromEntries(
      kinds.map((kind) => {
        const selected = samples.filter((s) => s.kind === kind);
        const metrics = Object.fromEntries(
          Object.keys(selected[0].ms).map((name) => [
            name,
            distribution(selected.map((s) => s.ms[name as keyof typeof s.ms]!)),
          ]),
        );
        const ends = selected.map((s) => s.ms.batchToTurnCompleted);
        return [
          kind,
          { ...metrics, completionSpreadMs: round(Math.max(...ends) - Math.min(...ends)) },
        ];
      }),
    ) as Record<
      PromptTimingCommand['kind'],
      Record<string, ReturnType<typeof distribution>> & { completionSpreadMs: number }
    >,
    sessions: identities.map((id, index) => {
      const own = commands.filter((c) => c.sessionId === id),
        traces = new Set(own.map((c) => c.traceId));
      const phases = summarizePhaseA(
        spans.filter((s) => traces.has(s.spanContext().traceId)),
        starts.filter((s) => traces.has(s.traceId)),
        own,
      );
      if (
        !phases.coverage.complete ||
        phases.commands.some((command) =>
          Object.values(command.checks).every((check) => check.count === 0),
        )
      )
        throw Error('Missing per-command Phase A instrumentation');
      if (phases.concurrency.maxActiveTurns !== 1)
        throw Error('Unexpected overlapping turns within one session');
      return {
        session: index + 1,
        route: phases.route,
        coverage: phases.coverage,
        concurrency: phases.concurrency,
        commands: phases.commands,
      };
    }),
    samples,
  };
}
