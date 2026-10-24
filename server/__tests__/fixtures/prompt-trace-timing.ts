/** Offline trace reduction. Raw spans (including prompts/paths on unrelated spans)
 * never leave the caller; export only this explicit timing/correlation allowlist. */
export type TimingSpan = {
  name: string;
  startTime: readonly [number, number];
  endTime: readonly [number, number];
  spanContext(): { traceId: string; spanId: string };
  parentSpanContext?: { spanId: string };
  attributes: Readonly<Record<string, unknown>>;
  events: readonly { name: string; time: readonly [number, number] }[];
  status?: { code: number };
  otel?: {
    startTime: readonly [number, number];
    endTime: readonly [number, number];
    events: readonly { name: string; time: readonly [number, number] }[];
  };
};
export type PromptTimingCommand = {
  commandId: string;
  traceId: string;
  kind: 'cold' | 'warm' | 'queued';
};
const millis = (time: readonly [number, number]) => time[0] * 1000 + time[1] / 1e6;
const round = (value: number) => Math.round(value * 1000) / 1000;
export function summarizePromptTiming(
  spans: readonly TimingSpan[],
  commands: readonly PromptTimingCommand[],
  dispatchBudgetMs?: number,
) {
  if (
    !commands.length ||
    new Set(commands.map((c) => c.commandId)).size !== commands.length ||
    new Set(commands.map((c) => c.traceId)).size !== commands.length
  )
    throw Error('Timing commands must have unique command and trace identities');
  if (
    dispatchBudgetMs !== undefined &&
    (!Number.isFinite(dispatchBudgetMs) || dispatchBudgetMs <= 0)
  )
    throw Error('Invalid timing budget');
  const samples = commands.map((command, index) => {
    if (!/^[a-f0-9]{32}$/.test(command.traceId) || /^0+$/.test(command.traceId))
      throw Error('Invalid timing trace');
    const one = (name: string, parent?: TimingSpan) => {
      const found = spans.filter(
        (s) =>
          s.name === name &&
          (parent
            ? s.parentSpanContext?.spanId === parent.spanContext().spanId
            : s.attributes['mitzo.command.id'] === command.commandId),
      );
      if (
        found.length !== 1 ||
        found[0].spanContext().traceId !== command.traceId ||
        found[0].status?.code === 2
      )
        throw Error('Missing, duplicate, failed or mismatched timing span: ' + name);
      const value = found[0];
      const start = millis(value.startTime),
        end = millis(value.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        throw Error('Invalid or reversed timing span');
      return value;
    };
    const http = one('codex.command.http');
    const admission = one('validation.admission.claim');
    const queue = one('codex.command.queue_wait');
    const preparation = one('codex.command.preparation');
    const turn = one('codex.turn');
    const invocation = one('codex.turn.dispatch', turn);
    const ack = one('codex.turn.acknowledgment', turn);
    const output = one('codex.turn.first_output', turn);
    if (output.attributes['mitzo.first_output.result'] !== 'output')
      throw Error('Timing sample has no accepted assistant output');
    const write = one('validation.turn.write');
    const queued = write.events.filter((e) => e.name === 'write_queued');
    if (queued.length !== 1) throw Error('Missing or duplicate stream write boundary');
    const points = [
      http.startTime,
      admission.endTime,
      queue.startTime,
      queue.endTime,
      preparation.startTime,
      invocation.startTime,
      preparation.endTime,
      write.startTime,
      queued[0].time,
      write.endTime,
    ].map(millis);
    if (points.some((value, i) => !Number.isFinite(value) || (i > 0 && value < points[i - 1])))
      throw Error(
        'Invalid timing boundary order: ' + points.map((v) => round(v - points[0])).join(','),
      );
    const [
      entry,
      admitted,
      persisted,
      claimed,
      prepStart,
      invocationStart,
      prepEnd,
      writeStart,
      writeQueued,
      writeComplete,
    ] = points;
    const acknowledged = millis(ack.endTime),
      firstOutput = millis(output.endTime);
    if (
      acknowledged < invocationStart ||
      firstOutput < invocationStart ||
      millis(turn.endTime) < Math.max(acknowledged, firstOutput)
    )
      throw Error('Invalid provider boundary order');
    const serverToWriteQueued = writeQueued - entry;
    if (
      dispatchBudgetMs !== undefined &&
      writeComplete - entry - (claimed - persisted) > dispatchBudgetMs
    )
      throw Error('Application dispatch timing budget exceeded');
    const admissionPhases = spans
      .filter(
        (s) =>
          s.spanContext().traceId === command.traceId &&
          /^codex\.admission\.(retained_migration|provider_environment|agent_context|knowledge|task_capabilities|lifecycle_wait)$/.test(
            s.name,
          ),
      )
      .map((s) => ({
        name: s.name,
        startMs: round(millis(s.startTime) - entry),
        endMs: round(millis(s.endTime) - entry),
      }));
    return {
      admissionPhases,
      sample: index + 1,
      kind: command.kind,
      traceId: command.traceId,
      ms: {
        serverToDurableAdmission: round(admitted - entry),
        admissionToDurableQueue: round(persisted - admitted),
        serverToDurableQueue: round(persisted - entry),
        queueWait: round(claimed - persisted),
        preparation: round(prepEnd - prepStart),
        invocation: round(millis(invocation.endTime) - millis(invocation.startTime)),
        serverToWriteQueued: round(serverToWriteQueued),
        serverToWriteCompleted: round(writeComplete - entry),
        applicationDispatchExcludingQueue: round(writeComplete - entry - (claimed - persisted)),
        streamWrite: round(writeComplete - writeStart),
        ...(write.otel && http.otel
          ? {
              otelWriteQueuedMs: round(
                millis(write.otel.events.find((e) => e.name === 'write_queued')!.time) -
                  millis(http.otel.startTime),
              ),
            }
          : {}),
        writeCompletedToAck: round(acknowledged - writeComplete),
        writeCompletedToFirstOutput: round(firstOutput - writeComplete),
        ackToFirstOutput: round(firstOutput - acknowledged),
        serverToFirstOutput: round(firstOutput - entry),
      },
      spans: [http, admission, queue, preparation, turn, invocation, ack, output, write].map(
        (s) => ({
          name: s.name,
          spanId: s.spanContext().spanId,
          parentSpanId: s.parentSpanContext?.spanId,
          ...(s.otel && http.otel
            ? {
                otelStartMs: round(millis(s.otel.startTime) - millis(http.otel.startTime)),
                otelEndMs: round(millis(s.otel.endTime) - millis(http.otel.startTime)),
              }
            : {}),
          startMs: round(millis(s.startTime) - entry),
          endMs: round(millis(s.endTime) - entry),
        }),
      ),
    };
  });
  return {
    version: 1,
    boundary: 'owned command HTTP handler entry to controlled stdio write_completed',
    units: 'milliseconds',
    samples,
    summary: promptTimingSummary(samples),
  };
}

export function promptTimingSummary(
  samples: readonly { kind: PromptTimingCommand['kind']; ms: { serverToWriteCompleted: number } }[],
) {
  return Object.fromEntries(
    (['cold', 'warm', 'queued'] as const).map((kind) => {
      const values = samples
        .filter((s) => s.kind === kind)
        .map((s) => s.ms.serverToWriteCompleted)
        .sort((a, b) => a - b);
      const n = values.length;
      return [
        kind,
        n
          ? {
              n,
              median: round((values[Math.floor((n - 1) / 2)] + values[Math.ceil((n - 1) / 2)]) / 2),
              min: values[0],
              max: values[n - 1],
              ...(n >= 20 ? { p95: values[Math.ceil(n * 0.95) - 1] } : {}),
            }
          : { n: 0 },
      ];
    }),
  );
}
