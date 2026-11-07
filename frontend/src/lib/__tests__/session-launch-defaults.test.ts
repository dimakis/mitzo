// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../api-fetch';
import {
  loadSessionLaunchDefaults,
  saveSessionLaunchDefaults,
  sessionLaunchConfigurationDraft,
  savedRepositorySelectionReason,
  unsupportedSessionExtraToolsReason,
  unsupportedSessionContextReason,
} from '../session-launch-defaults';

vi.mock('../api-fetch', () => ({ apiFetch: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const configuration = {
  version: 1 as const,
  runtime: {
    version: 1 as const,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
    accountReference: {
      accountId: 'personal',
      provider: 'openai-codex' as const,
      profileRevision: 'r1',
    },
    agentProfile: { kind: 'builtin' as const, profileId: 'mitzo-default', revision: 1 },
    execution: { location: 'local' as const, targetId: 'mac-1' },
  },
  mode: 'ask' as const,
  isolation: false,
  repositoryWorkspaceId: null,
  contextBlocks: ['Project context'],
  extraTools: ['Read'],
};

it('round trips every launch setting through the durable default endpoint', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ revision: 8, configuration }));
  expect(await saveSessionLaunchDefaults(configuration, 7)).toEqual({ revision: 8, configuration });
  expect(apiFetch).toHaveBeenCalledWith('/api/session-launch/defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 7, configuration }),
  });
  expect(await loadSessionLaunchDefaults()).toEqual({ revision: 8, configuration });
});

it('clears durable defaults and surfaces failed or stale saves', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ revision: 9, configuration: null }));
  expect(await saveSessionLaunchDefaults(null, 8)).toEqual({ revision: 9, configuration: null });
  vi.mocked(apiFetch).mockResolvedValueOnce(
    Response.json({ error: 'Defaults changed. Refresh before saving.' }, { status: 409 }),
  );
  await expect(saveSessionLaunchDefaults(configuration, 8)).rejects.toThrow('Defaults changed');
});

it('restores Local Mac and its exact host while invalidating prior execution review', () => {
  const draft = sessionLaunchConfigurationDraft(configuration);
  expect(draft.settings.runtimeSelection).toEqual({
    ...configuration.runtime,
    capabilityRevision: null,
  });
  expect(draft.settings.mode).toBe('ask');
  expect(draft.settings.isolation).toBe(false);
  expect(draft.contextBlocks).toEqual(configuration.contextBlocks);
  expect(new URLSearchParams(draft.settings.search).get('extraTools')).toBe('Read');
  expect(draft.settings.sourceSnapshots).toBeUndefined();
});

it('retains a saved repository as unresolved source intent and never reuses its prepared checkout', () => {
  const draft = sessionLaunchConfigurationDraft({
    ...configuration,
    repositoryWorkspaceId: 'old-prepared-checkout',
  });
  expect(draft.settings.repositoryWorkspaceId).toBeNull();
  expect(draft.settings.savedRepositoryWorkspaceId).toBe('old-prepared-checkout');
  expect(savedRepositorySelectionReason('old-prepared-checkout', null, false)).toContain(
    'fresh checkout',
  );
  expect(
    savedRepositorySelectionReason(
      'old-prepared-checkout',
      { repositoryWorkspaceId: 'old-prepared-checkout', blocked: false },
      false,
    ),
  ).toContain('fresh checkout');
  expect(
    savedRepositorySelectionReason(
      'old-prepared-checkout',
      { repositoryWorkspaceId: 'new-checkout', blocked: true },
      false,
    ),
  ).toContain('fresh checkout');
  expect(
    savedRepositorySelectionReason(
      'old-prepared-checkout',
      { repositoryWorkspaceId: 'new-checkout', blocked: false },
      false,
    ),
  ).toBeUndefined();
  expect(savedRepositorySelectionReason('old-prepared-checkout', null, true)).toBeUndefined();
});

it('blocks native first commands with retained tools or context rather than dropping settings', () => {
  expect(unsupportedSessionExtraToolsReason('Read,Glob', true)).toContain('unsupported');
  expect(unsupportedSessionExtraToolsReason('', true)).toBeUndefined();
  expect(unsupportedSessionExtraToolsReason('Read', false)).toBeUndefined();
  expect(unsupportedSessionContextReason(['Saved project notes'], true)).toContain('unsupported');
  expect(unsupportedSessionContextReason([], true)).toBeUndefined();
});
