import { z } from 'zod';
import {
  ContextMeasurementSchema,
  ContextObservationSchema,
  ContextRequestUsageSchema,
  type ContextMeasurement,
  type ContextObservation,
} from '@mitzo/protocol';
import { observedCodexUsage } from './codex-turn-usage.js';

const count = z.number().int().nonnegative().safe();
const label = z.string().min(1).max(256);
const breakdown = z.array(z.object({ tokens: count })).max(1024);
const ClaudeResponse = z.object({
  model: label,
  totalTokens: count,
  maxTokens: count.positive(),
  rawMaxTokens: count.positive(),
  categories: z
    .array(z.object({ id: label.optional(), name: label, tokens: count, kind: label }))
    .max(256),
  memoryFiles: breakdown,
  mcpTools: breakdown,
  agents: breakdown,
  skills: breakdown.optional(),
  systemTools: breakdown.optional(),
  systemPromptSections: breakdown.optional(),
  mcpInstructions: breakdown.optional(),
  deferredBuiltinTools: breakdown.optional(),
});

function sum(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Context measurement sum overflow');
  return total;
}

/** Pure normalization, not a provider call. Counts remain estimates even in full mode. */
export function normalizeClaudeContext(
  input: unknown,
  observation: ContextObservation,
  detail: 'summary' | 'full',
): ContextMeasurement {
  const context = ContextObservationSchema.parse(observation);
  const raw = ClaudeResponse.parse(input);
  if (raw.model !== context.binding.model) throw new Error('Context measurement model mismatch');
  const categories = raw.categories.map((row, index) => ({
    key: row.id ?? `category-${index}`,
    providerId: row.id,
    label: row.name,
    kind: (['used', 'free', 'buffer', 'deferred'].includes(row.kind)
      ? row.kind
      : 'unknown') as ContextMeasurement['categories'][number]['kind'],
    tokens: row.tokens,
    assurance: 'estimated' as const,
  }));
  const keys = new Set(categories.map((row) => row.key));
  const contributions: ContextMeasurement['contributions'] = [];
  for (const [key, rows] of [
    ['memory_files', raw.memoryFiles],
    ['mcp_tools', raw.mcpTools],
    ['custom_agents', raw.agents],
    ['skills', raw.skills],
    ['system_tools', raw.systemTools],
    ['system_prompt', raw.systemPromptSections],
    ['mcp_instructions', raw.mcpInstructions],
    ['system_tools_deferred', raw.deferredBuiltinTools],
  ] as const) {
    for (const [index, row] of (rows ?? []).entries())
      contributions.push({
        id: `${key}:${index}`,
        sourceRef: `sdk:${key}:${index}`,
        ...(keys.has(key) ? { categoryKey: key } : {}),
        tokens: row.tokens,
        relation: 'unknown',
        assurance: 'estimated',
      });
  }
  const values = (kind: string) =>
    categories.filter((row) => row.kind === kind).map((row) => row.tokens);
  const residualTokens = raw.totalTokens - sum(values('used'));
  const free = values('free');
  const buffer = values('buffer');
  return ContextMeasurementSchema.parse({
    ...context,
    version: 1,
    freshness: { state: 'current' },
    measurement: {
      basis: 'current-context-estimate',
      method: `claude-${detail}`,
      assurance: detail === 'summary' ? 'estimated' : 'mixed',
    },
    usedTokens: raw.totalTokens,
    categories,
    contributions,
    capacity: {
      // The control does not prove whether this resolved window is the hard model limit.
      compactionWindowTokens: raw.rawMaxTokens,
      usableWindowTokens: raw.maxTokens,
      ...(free.length ? { freeTokens: sum(free) } : {}),
      ...(buffer.length ? { bufferTokens: sum(buffer) } : {}),
      kind: 'unknown',
      source: 'claude-context-control',
      stale: false,
    },
    reconciliation: {
      residualTokens,
      status: categories.some((row) => row.kind === 'unknown')
        ? 'unknown'
        : residualTokens < 0
          ? 'inconsistent'
          : residualTokens > 0
            ? 'partial'
            : 'consistent',
    },
  });
}

const CodexEvent = z.object({
  threadId: label,
  turnId: label,
  tokenUsage: z.object({ last: ContextRequestUsageSchema }),
});

/** Same event contract for attached Mac/OpenShell owners; no transport parity claim. */
export function normalizeCodexContext(
  input: unknown,
  observation: ContextObservation,
): ContextMeasurement {
  const context = ContextObservationSchema.parse(observation);
  const event = CodexEvent.parse(input);
  // Reuse the accepted upstream-total/subset validator instead of inventing counters.
  const usage = observedCodexUsage(input);
  if (
    !usage ||
    event.threadId !== context.identity.threadId ||
    event.turnId !== context.identity.turnId
  )
    throw new Error('Invalid or mismatched Codex context observation');
  return ContextMeasurementSchema.parse({
    ...context,
    version: 1,
    freshness: { state: 'unknown', reason: 'latest-response-only' },
    measurement: { basis: 'latest-request', method: 'codex-event', assurance: 'provider-reported' },
    requestUsage: event.tokenUsage.last,
    categories: [],
    contributions: [],
    capacity: {
      ...(usage.contextCeiling > 0
        ? {
            modelLimits: {
              model: context.binding.model,
              source: 'runtime',
              contextWindow: usage.contextCeiling,
              checkedAt: context.observedAt,
              stale: false,
            },
          }
        : {}),
      kind: usage.contextCeiling > 0 ? 'model-limit' : 'unknown',
      source: 'codex-token-usage-event',
      stale: false,
    },
    reconciliation: { status: 'unknown' },
  });
}
