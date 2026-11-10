// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationRepositoryPicker } from '../ConversationRepositoryPicker';
import { joiningSetupFixture } from '../../preview/conversation-joining-fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: api.fetch }));
afterEach(() => {
  cleanup();
  api.fetch.mockReset();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function fixture(harness: 'codex' | 'claude-sdk' | 'responses', location = 'local') {
  const account = {
    accountId: 'selected',
    provider: harness === 'claude-sdk' ? 'anthropic-claude' : 'openai',
    profileRevision: 'r1',
  };
  const models = [{ id: 'fixture-model', label: 'Offline model' }];
  const setup = joiningSetupFixture();
  setup.selection = { accountId: 'selected', model: 'fixture-model', reasoningEffort: null };
  setup.runOn = location as 'local' | 'openshell';
  const inventory = {
    version: 1,
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    capabilityRevision: 'r1',
    accounts: [
      {
        account,
        label: 'Selected account',
        models,
        modelDiscovery: { source: 'configured', stale: false },
      },
    ],
    targets: [
      {
        targetId: 'target',
        targetRevision: 'r1',
        label: 'Selected environment',
        location,
        harness,
      },
    ],
    routes: [{ account, targetId: 'target', location, harness, modes: ['agent'], models }],
    locations: [{ location, status: 'configured' }],
    agentProfiles: [],
  };
  const id = '00000000-0000-4000-8000-000000000001';
  api.fetch.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url.includes('/runtime/capabilities')) return Response.json(inventory);
    if (url.includes('/catalog'))
      return Response.json({
        available: true,
        location: 'local',
        repositories: [
          {
            connectionId: 'local',
            repositoryId: 'primary',
            repository: 'local/primary',
            label: 'Project',
          },
        ],
      });
    expect(url).toBe('/api/repository-workspaces/local');
    expect(JSON.parse(String(options?.body)).ordinaryRuntime).toEqual({
      runOn: location,
      runtime: { account, harness, targetId: 'target' },
    });
    return Response.json({
      id,
      repository: 'local/primary',
      baseBranch: 'main',
      baseOid: 'a'.repeat(40),
      featureBranch: 'mitzo/task',
      state: 'ready',
      ordinaryRuntime: {
        version: 2,
        account,
        harness: { implementation: harness },
        execution: { location, targetId: 'target', targetRevision: 'r1' },
      },
    });
  });
  return { setup, id };
}

it.each(['claude-sdk', 'codex'] as const)(
  'prepares the selected repository through the actual picker using its configured %s account and harness',
  async (harness) => {
    const { setup, id } = fixture(harness);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
    const onChange = vi.fn();
    render(<ConversationRepositoryPicker setup={setup} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add repository' }));
    await user.selectOptions(screen.getByLabelText('Local repository'), 'local:local/primary');
    await user.click(screen.getByRole('button', { name: 'Use repository' }));
    await screen.findByText(/worktree starts from latest upstream main/i);
    expect(onChange).toHaveBeenLastCalledWith({
      repositoryWorkspaceId: id,
      permissionMode: 'agent',
    });
    expect(api.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      1,
    );
  },
);

it.each([
  ['responses', 'local'],
  ['claude-sdk', 'openshell'],
] as const)('keeps unsupported %s/%s preparation unavailable', async (harness, location) => {
  const { setup } = fixture(harness, location);
  render(<ConversationRepositoryPicker setup={setup} onChange={vi.fn()} />);
  await screen.findByText(/Choose an account, model and supported environment/);
  expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
  expect(api.fetch.mock.calls).toHaveLength(1);
});
