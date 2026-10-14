import { sha256Hex } from '../lib/browser-crypto';
export function localInventoryFixture() {
  const result = {
    version: 1 as const,
    authority: 'configuration-only' as const,
    defaultLocation: 'openshell' as const,
    capabilityRevision: 'caps-r1',
    accounts: [
      {
        account: {
          accountId: 'personal',
          provider: 'openai-codex' as const,
          profileRevision: 'routing-r1',
        },
        label: 'Personal ChatGPT',
        models: [{ id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] }],
        modelDiscovery: { source: 'configured' as const, stale: false },
      },
    ],
    targets: [
      {
        targetId: 'mac',
        targetRevision: 'target-r1',
        label: 'This Mac',
        location: 'local' as const,
        harness: 'codex' as const,
      },
    ],
    routes: [
      {
        account: {
          accountId: 'personal',
          provider: 'openai-codex' as const,
          profileRevision: 'routing-r1',
        },
        targetId: 'mac',
        harness: 'codex' as const,
        modes: ['ask', 'agent', 'auto'] as ('ask' | 'agent' | 'auto')[],
        skillCeiling: 'unsupported' as const,
      },
    ],
    locations: [
      {
        location: 'openshell' as const,
        status: 'unavailable' as const,
        reason: 'openshell_projection_pending',
      },
      { location: 'local' as const, status: 'configured' as const },
    ],
    agentProfiles: [
      {
        profileId: 'agent',
        revision: 1,
        definition: {
          name: 'Repository helper',
          role: 'custom',
          instructions: 'Inspect carefully',
          expectedOutput: 'Report',
          acceptanceCriteria: ['Verified'],
          modelPolicyRole: 'worker',
        },
        contentHash: 'a'.repeat(64),
      },
    ],
  };
  result.agentProfiles[0].contentHash = sha256Hex(
    JSON.stringify(result.agentProfiles[0].definition),
  );
  return result;
}
