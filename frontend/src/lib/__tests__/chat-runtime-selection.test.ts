import { describe, expect, it } from 'vitest';
import {
  createChatRuntimeSelection,
  evaluateChatRuntimeSelection,
  replaceChatRuntimeSelection,
  snapshotChatRuntimeSelection,
  type ChatRuntimeSelection,
  type ChatRuntimeInventory,
} from '../chat-runtime-selection';

const selected = (): ChatRuntimeSelection => ({
  version: 1,
  account: { accountId: 'personal', model: 'luna', reasoningEffort: 'high' },
  agentProfile: { profileId: 'developer', revision: 2 },
  execution: { location: 'openshell', targetId: 'ordinary-sandbox' },
  capabilityRevision: 'inventory-1',
});
const inventory = (): ChatRuntimeInventory => ({
  capabilityRevision: 'inventory-1',
  agentProfiles: [{ profileId: 'developer', revision: 2 }],
  locations: [
    { location: 'openshell', available: true },
    { location: 'local', available: true },
  ],
  routes: [
    {
      accountId: 'personal',
      targetId: 'ordinary-sandbox',
      location: 'openshell',
      available: true,
      models: [{ id: 'luna', reasoningEfforts: ['low', 'high'] }],
    },
    {
      accountId: 'personal',
      targetId: 'mac',
      location: 'local',
      available: true,
      models: [{ id: 'luna', reasoningEfforts: ['low'] }],
    },
  ],
});

describe('chat runtime selection preservation', () => {
  it('starts with unresolved OpenShell even when only local is available', () => {
    const capabilities = inventory();
    capabilities.locations[0] = {
      location: 'openshell',
      available: false,
      reason: 'OpenShell enrollment is pending.',
    };
    const choice = createChatRuntimeSelection();
    const result = evaluateChatRuntimeSelection(choice, capabilities);
    expect(result.selection).toBe(choice);
    expect(choice.execution).toEqual({ location: 'openshell', targetId: null });
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'location_unavailable',
        message: 'OpenShell enrollment is pending.',
      }),
    );
  });

  it('retains a removed model and thinking value until explicitly replaced', () => {
    const choice = selected();
    const capabilities = inventory();
    capabilities.routes[0].models = [{ id: 'other', reasoningEfforts: ['low'] }];
    const result = evaluateChatRuntimeSelection(choice, capabilities);
    expect(result.selection).toBe(choice);
    expect(result.ready).toBe(false);
    expect(choice.account).toEqual(selected().account);
    expect(result.issues.map((issue) => issue.code)).toContain('model_unavailable');
  });

  it('keeps an invalid thinking value without adopting a model default', () => {
    const choice = selected();
    choice.account!.reasoningEffort = 'ultra';
    const result = evaluateChatRuntimeSelection(choice, inventory());
    expect(result.ready).toBe(false);
    expect(result.selection.account!.reasoningEffort).toBe('ultra');
    expect(result.issues.map((issue) => issue.code)).toContain('thinking_unavailable');
  });

  it('requires refresh for stale capabilities without rewriting the retained revision', () => {
    const choice = selected();
    const capabilities = inventory();
    capabilities.capabilityRevision = 'inventory-2';
    const result = evaluateChatRuntimeSelection(choice, capabilities);
    expect(result.ready).toBe(false);
    expect(result.refreshRequired).toBe(true);
    expect(choice.capabilityRevision).toBe('inventory-1');
  });

  it('fails closed when capabilities have not loaded', () => {
    const result = evaluateChatRuntimeSelection(selected(), null);
    expect(result.ready).toBe(false);
    expect(result.refreshRequired).toBe(true);
  });

  it('validates the account and target together, including location and ambiguity', () => {
    const choice = selected();
    choice.execution.location = 'local';
    expect(evaluateChatRuntimeSelection(choice, inventory()).ready).toBe(false);
    choice.execution.location = 'openshell';
    const capabilities = inventory();
    capabilities.routes.push({ ...capabilities.routes[0] });
    expect(evaluateChatRuntimeSelection(choice, capabilities).ready).toBe(false);
  });

  it('retains unavailable route and agent revision reasons', () => {
    const capabilities = inventory();
    capabilities.routes[0].available = false;
    capabilities.routes[0].reason = 'Account authorization must be renewed.';
    capabilities.agentProfiles = [];
    const result = evaluateChatRuntimeSelection(selected(), capabilities);
    expect(result.ready).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'route_unavailable',
        message: 'Account authorization must be renewed.',
      }),
    );
    expect(result.issues.map((issue) => issue.code)).toContain('agent_unavailable');
  });

  it.each(['account', 'agentProfile', 'target', 'location'] as const)(
    'rejects changing a bound conversation %s while retaining its current choice',
    (field) => {
      const current = selected();
      const candidate = selected();
      if (field === 'account') candidate.account!.accountId = 'work';
      if (field === 'agentProfile') candidate.agentProfile!.revision = 3;
      if (field === 'target') candidate.execution.targetId = 'mac';
      if (field === 'location') candidate.execution.location = 'local';
      const result = replaceChatRuntimeSelection(current, candidate, current);
      expect(result.accepted).toBe(false);
      expect(result.selection).toBe(current);
    },
  );

  it('allows future model and thinking edits but validates them separately', () => {
    const current = selected();
    const candidate = selected();
    candidate.account!.model = 'removed';
    candidate.account!.reasoningEffort = null;
    const replaced = replaceChatRuntimeSelection(current, candidate, current);
    expect(replaced.accepted).toBe(true);
    expect(evaluateChatRuntimeSelection(replaced.selection, inventory()).ready).toBe(false);
  });

  it('snapshots a valid dispatch without allowing later draft edits to alter retries', () => {
    const choice = selected();
    const snapshot = snapshotChatRuntimeSelection(choice, inventory());
    expect(snapshot).toEqual(choice);
    choice.execution.targetId = 'mac';
    choice.account!.reasoningEffort = 'low';
    choice.agentProfile!.revision = 3;
    expect(snapshot).toEqual(selected());
    expect(snapshotChatRuntimeSelection(choice, inventory())).toBeNull();
  });
});
