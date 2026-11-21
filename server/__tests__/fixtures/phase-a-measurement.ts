/** Offline-only reduction of complete in-memory observations. Never export raw attributes. */
import { cpus, freemem, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { PromptTimingCommand, TimingSpan } from './prompt-trace-timing.js';

export type PhaseStart = {
  name: string;
  spanId: string;
  traceId: string;
  startTime: readonly [number, number];
};
const checks = [
  'workspace_check',
  'workspace_revalidation',
  'credential_check',
  'repository_credential_check',
  'keychain_read',
] as const;
const phaseName = (name: string) => checks.find((check) => name === `local_codex.${check}`);
const key = (span: { traceId: string; spanId: string }) => `${span.traceId}:${span.spanId}`;
const ms = (time: readonly [number, number]) => time[0] * 1000 + time[1] / 1e6;
const round = (value: number) => Math.round(value * 1000) / 1000;
function interval(span: TimingSpan): [number, number] {
  const start = ms(span.startTime),
    end = ms(span.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw Error('Invalid Phase A timing interval');
  return [start, end];
}
function peak(intervals: [number, number][]) {
  const events = intervals
    .filter(([start, end]) => end > start)
    .flatMap(([start, end]) => [
      [start, 1],
      [end, -1],
    ])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    maximum = 0;
  for (const [, delta] of events) maximum = Math.max(maximum, (active += delta));
  return maximum;
}

export function summarizePhaseA(
  spans: readonly TimingSpan[],
  starts: readonly PhaseStart[],
  commands: readonly PromptTimingCommand[],
) {
  if (
    !commands.length ||
    new Set(commands.map((c) => c.commandId)).size !== commands.length ||
    new Set(commands.map((c) => c.traceId)).size !== commands.length
  )
    throw Error('Phase A requires unique command and trace identities');
  const started = starts.filter((s) => phaseName(s.name));
  const byId = new Map(started.map((s) => [key(s), s]));
  if (byId.size !== started.length) throw Error('Duplicate Phase A start');
  const ended = spans.filter((s) => phaseName(s.name));
  const seen = new Set<string>();
  for (const span of ended) {
    const id = key(span.spanContext()),
      start = byId.get(id);
    if (
      seen.has(id) ||
      !start ||
      start.name !== span.name ||
      ms(start.startTime) !== ms(span.startTime)
    )
      throw Error('Missing, duplicate or mismatched Phase A boundary');
    seen.add(id);
    interval(span);
  }
  const commandTraces = new Set(commands.map((c) => c.traceId));
  const unattributed = started.filter((s) => !commandTraces.has(s.traceId)).length;
  const outstanding: [number, number][] = [],
    active: [number, number][] = [];
  const samples = commands.map((command, index) => {
    const one = (name: string) => {
      const found = spans.filter(
        (s) => s.name === name && s.attributes['mitzo.command.id'] === command.commandId,
      );
      if (found.length !== 1 || found[0].spanContext().traceId !== command.traceId)
        throw Error('Missing or mismatched Phase A command span');
      interval(found[0]);
      return found[0];
    };
    const http = one('codex.command.http'),
      turn = one('codex.turn');
    // Qualify the only adapter exercised by this fixture; never label a real account as synthetic.
    if (
      turn.attributes['mitzo.route'] !== 'chatgpt-subscription' ||
      turn.attributes['mitzo.account.id'] !== 'ordinary-personal' ||
      turn.attributes['gen_ai.request.model'] !== 'fixture-model'
    )
      throw Error('Missing or unexpected resolved synthetic route');
    const [httpStart] = interval(http),
      [turnStart, turnEnd] = interval(turn);
    if (turnStart < httpStart) throw Error('Reversed Phase A command interval');
    outstanding.push([httpStart, turnEnd]);
    active.push([turnStart, turnEnd]);
    return {
      sample: index + 1,
      kind: command.kind,
      checks: Object.fromEntries(
        checks.map((check) => {
          const values = ended.filter(
            (s) => phaseName(s.name) === check && s.spanContext().traceId === command.traceId,
          );
          return [
            check,
            {
              count: values.length,
              failed: values.filter((s) => s.status?.code === 2).length,
              wallMs: round(
                values.reduce((sum, s) => {
                  const [start, end] = interval(s);
                  return sum + end - start;
                }, 0),
              ),
            },
          ];
        }),
      ),
    };
  });
  return {
    version: 1,
    route: {
      engine: 'codex',
      execution: 'local-synthetic',
      account: 'synthetic-personal',
      model: 'fixture-model',
      route: 'chatgpt-subscription',
      evidence: 'resolved turn spans',
    },
    coverage: {
      started: started.length,
      ended: ended.length,
      unfinished: started.length - ended.length,
      unattributed,
      complete: started.length === ended.length && unattributed === 0,
    },
    concurrency: {
      sessions: 1,
      commands: commands.length,
      maxOutstandingCommands: peak(outstanding),
      maxActiveTurns: peak(active),
    },
    commands: samples,
  };
}

/** No warning threshold: record every histogram interval, including zero-sample coverage. */
export function startPhaseAResources() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const start = performance.now(),
    cpu = process.cpuUsage(),
    loop = performance.eventLoopUtilization();
  const hostCpu = cpus(),
    memory = process.memoryUsage(),
    initialFree = freemem();
  let maxRss = memory.rss,
    maxHeap = memory.heapUsed,
    minFree = initialFree,
    samples = 0;
  const sample = () => {
    const current = process.memoryUsage();
    maxRss = Math.max(maxRss, current.rss);
    maxHeap = Math.max(maxHeap, current.heapUsed);
    minFree = Math.min(minFree, freemem());
    samples++;
    return current;
  };
  sample();
  const timer = setInterval(sample, 20);
  timer.unref();
  function finish() {
    clearInterval(timer);
    histogram.disable();
    const endMemory = sample(),
      elapsedMs = performance.now() - start,
      used = process.cpuUsage(cpu);
    const hostEnd = cpus();
    const ticks = (list: ReturnType<typeof cpus>, idle: boolean) =>
      list.reduce(
        (sum, c) => sum + (idle ? c.times.idle : Object.values(c.times).reduce((a, b) => a + b, 0)),
        0,
      );
    const total = ticks(hostEnd, false) - ticks(hostCpu, false),
      idle = ticks(hostEnd, true) - ticks(hostCpu, true);
    return {
      elapsedMs: round(elapsedMs),
      process: {
        cpuMs: { user: used.user / 1000, system: used.system / 1000 },
        cpuPercentOfOneCore: round((used.user + used.system) / 10 / elapsedMs),
        memory: {
          samples,
          sampleIntervalMs: 20,
          startRssBytes: memory.rss,
          endRssBytes: endMemory.rss,
          maxSampledRssBytes: maxRss,
          maxSampledHeapUsedBytes: maxHeap,
        },
      },
      host: {
        logicalCpus: hostCpu.length,
        totalMemoryBytes: totalmem(),
        startFreeMemoryBytes: initialFree,
        endFreeMemoryBytes: freemem(),
        minSampledFreeMemoryBytes: minFree,
        cpuBusyFraction:
          total > 0 && hostCpu.length === hostEnd.length ? round(1 - idle / total) : null,
      },
      eventLoop: {
        resolutionMs: 20,
        sampleCount: histogram.count,
        utilization: performance.eventLoopUtilization(loop).utilization,
        delayMs: histogram.count
          ? {
              mean: histogram.mean / 1e6,
              max: histogram.max / 1e6,
              p50: histogram.percentile(50) / 1e6,
              p95: histogram.percentile(95) / 1e6,
              p99: histogram.percentile(99) / 1e6,
            }
          : null,
      },
    };
  }
  let result: ReturnType<typeof finish> | undefined;
  return { stop: () => (result ??= finish()) };
}
