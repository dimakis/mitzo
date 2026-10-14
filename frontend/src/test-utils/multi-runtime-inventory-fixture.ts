import { localInventoryFixture } from './local-inventory-fixture';
import type { ExplicitLocalInventory } from '../lib/explicit-local-chat';
export function multiRuntimeInventoryFixture(): ExplicitLocalInventory {
  const base = localInventoryFixture();
  const api = { accountId: 'api', provider: 'openai' as const, profileRevision: 'api-r1' };
  const claude = {
    accountId: 'vertex',
    provider: 'anthropic-vertex' as const,
    profileRevision: 'vertex-r1',
  };
  return {
    ...base,
    accounts: [
      ...base.accounts,
      {
        account: api,
        label: 'API billing',
        models: [
          { id: 'shell-model', label: 'Shell model', reasoningEfforts: ['low', 'high'] },
          { id: 'local-model', label: 'Local model', reasoningEfforts: ['low'] },
        ],
        modelDiscovery: { source: 'configured', stale: false },
      },
      {
        account: claude,
        label: 'Vertex billing',
        models: [{ id: 'claude-model', label: 'Claude model', reasoningEfforts: ['high'] }],
        modelDiscovery: { source: 'configured', stale: false },
      },
    ],
    targets: [
      ...base.targets,
      {
        targetId: 'shell',
        targetRevision: 'shell-r1',
        label: 'OpenShell',
        location: 'openshell',
        harness: 'codex',
      },
      {
        targetId: 'responses',
        targetRevision: 'responses-r1',
        label: 'Local API',
        location: 'local',
        harness: 'responses',
      },
      {
        targetId: 'claude',
        targetRevision: 'claude-r1',
        label: 'Local Claude',
        location: 'local',
        harness: 'claude-sdk',
      },
    ],
    routes: [
      ...base.routes,
      {
        account: api,
        targetId: 'shell',
        harness: 'codex',
        modes: ['agent'],
        models: [{ id: 'shell-model', label: 'Shell model', reasoningEfforts: ['low', 'high'] }],
      },
      {
        account: api,
        targetId: 'responses',
        harness: 'responses',
        modes: ['agent'],
        models: [{ id: 'local-model', label: 'Local model', reasoningEfforts: ['low'] }],
      },
      {
        account: claude,
        targetId: 'claude',
        harness: 'claude-sdk',
        modes: ['agent'],
        models: [{ id: 'claude-model', label: 'Claude model', reasoningEfforts: ['high'] }],
      },
    ],
    locations: [
      { location: 'openshell', status: 'configured' },
      { location: 'local', status: 'configured' },
    ],
  };
}
