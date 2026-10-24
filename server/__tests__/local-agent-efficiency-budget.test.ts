import { normalizeMcpToolResult } from '../codex-tool-result.js';
import { expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { profileToolDefinitions } from '../session-profile-tools.js';
import { agentTaskToolDefinitions } from '../session-agent-task-tools.js';
import { agentCommunicationDefinitions } from '../agent-communication-tools.js';
import { sessionHistoryToolDefinitions } from '../session-history-tools.js';
import { nativeToolDefinitions } from '../native-tool-executor.js';
import { localRepositoryToolDefinitions } from '../session-local-repository-tools.js';
import { localRepositoryPreparationDefinition } from '../local-repository-preparation-tool.js';
import { githubPublishingDefinition } from '../github-publishing-tool.js';
import { createIntegrationToolDiscovery } from '../integration-tool-discovery.js';
import {
  localEfficiencyToolDefinitions,
  LOCAL_EFFICIENCY_INSTRUCTIONS,
} from '../local-agent-efficiency.js';
import { projectToolOutput } from '../tool-output-projection.js';

it('keeps a representative development surface and large-result replay under explicit delivery budgets', () => {
  const mcp = Array.from({ length: 65 }, (_, n) => ({
    name: `wire_${n}`,
    description: `Search issue ${n}. ${'Usage details. '.repeat(40)}`,
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  }));
  const direct = [
    ...profileToolDefinitions,
    ...agentTaskToolDefinitions,
    ...agentCommunicationDefinitions,
    ...sessionHistoryToolDefinitions,
  ];
  const core = [
    ...nativeToolDefinitions.filter((t) =>
      ['AskUserQuestion', 'GitCommit', 'GitHubRead'].includes(t.name),
    ),
    ...localRepositoryToolDefinitions,
    localRepositoryPreparationDefinition,
    githubPublishingDefinition,
  ];
  const base = {
    tools: mcp,
    displayName: (name: string) => `mcp__fixture__${name}`,
    assertCurrent: () => {},
    execute: async () => ({ content: 'offline', isError: false }),
  };
  const previous = createIntegrationToolDiscovery(base);
  const current = createIntegrationToolDiscovery({ ...base, directTools: direct });
  const bytes = (value: unknown) =>
    Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
  const previousBytes =
    bytes([...core, ...direct, ...previous.definitions]) + bytes(previous.instructions);
  const currentBytes =
    bytes([
      ...core,
      ...current.directDefinitions,
      ...current.definitions,
      ...localEfficiencyToolDefinitions,
    ]) + bytes(current.instructions + LOCAL_EFFICIENCY_INSTRUCTIONS);
  const output = 'fixture record\n'.repeat(10000);
  const previousOutput = normalizeMcpToolResult([{ type: 'text', text: output }], false).content;
  const preview = projectToolOutput(output, () => '22222222-2222-4222-8222-222222222222');
  const metrics = {
    schemaVersion: 1,
    kind: 'offline-serialized-replay',
    modelCalls: 0,
    previousDefinitionBytes: previousBytes,
    currentDefinitionBytes: currentBytes,
    definitionReductionPercent: 100 * (1 - currentBytes / previousBytes),
    fullOutputBytes: bytes(output),
    previousProducerOutputBytes: bytes(previousOutput),
    producerOutputReductionPercent: 100 * (1 - bytes(preview) / bytes(previousOutput)),
    previewBytes: bytes(preview),
    outputReductionPercent: 100 * (1 - bytes(preview) / bytes(output)),
    nativeSkillContextTokens: 1500,
    note: 'Serialized bytes are not exact model tokens or live latency measurements. Repository custody, edit/commit and publishing boundaries are exercised by the companion offline suites.',
  };
  expect(currentBytes).toBeLessThan(previousBytes * 0.8);
  expect(currentBytes).toBeLessThan(18000);
  expect(bytes(preview)).toBeLessThanOrEqual(8192);
  expect(bytes(preview)).toBeLessThan(bytes(output) * 0.1);
  if (process.env.MITZO_EFFICIENCY_METRICS_FILE)
    writeFileSync(process.env.MITZO_EFFICIENCY_METRICS_FILE, JSON.stringify(metrics, null, 2));
});
