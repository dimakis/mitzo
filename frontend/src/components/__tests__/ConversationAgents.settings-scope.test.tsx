// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { WorkspaceControls } from '../WorkspaceControls';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
  currentVerifiedAuthSessionId: () => 'offline-settings-login',
}));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/agent-library')
      return Response.json({
        drafts: [],
        versions: [
          {
            profileId: 'reviewer',
            revision: 1,
            definition: {
              name: 'Reviewer',
              descriptor: 'Independent review',
              role: 'agent',
              instructions: 'Review the plan.',
              expectedOutput: 'Findings',
              acceptanceCriteria: ['Evidence'],
              modelPolicyRole: 'agent',
            },
          },
        ],
      });
    if (path === '/api/accounts')
      return Response.json([
        {
          id: 'offline-account',
          label: 'Offline account',
          models: [{ id: 'offline-model', label: 'Offline model', reasoningEfforts: ['high'] }],
        },
      ]);
    if (String(path).startsWith('/api/chat/runtime/capabilities')) {
      const account = {
        accountId: 'offline-account',
        provider: 'openai-codex',
        profileRevision: 'r1',
      };
      const models = [{ id: 'offline-model', label: 'Offline model' }];
      return Response.json({
        version: 1,
        authority: 'configuration-only',
        defaultLocation: 'openshell',
        capabilityRevision: 'r1',
        accounts: [
          {
            account,
            label: 'Offline account',
            models,
            modelDiscovery: { source: 'configured', stale: false },
          },
        ],
        targets: [
          {
            targetId: 'local-mac',
            targetRevision: 'r1',
            label: 'Local Mac',
            location: 'local',
            harness: 'codex',
          },
        ],
        routes: [
          {
            account,
            targetId: 'local-mac',
            location: 'local',
            harness: 'codex',
            modes: ['agent'],
            models,
          },
        ],
        locations: [{ location: 'local', status: 'configured' }],
        agentProfiles: [],
      });
    }
    if (String(path).startsWith('/api/repository-workspaces/catalog'))
      return Response.json({
        available: true,
        location: 'local',
        repositories: [
          {
            connectionId: 'local',
            repositoryId: 'project',
            repository: 'local/project',
            label: 'Selected project',
          },
        ],
      });
    throw Error(`Unexpected fixture request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

it('keeps real Add agent pickers inside the dialog when opened from compact chat settings', async () => {
  const joiningMutation = vi.fn(async () => {
    throw Error('Setup must not start joining');
  });
  render(
    <MemoryRouter>
      <WorkspaceControls
        status="Ready"
        settings={<input aria-label="Source setting" defaultValue="Original chat" />}
        actions={
          <ConversationAgents
            compact
            scope="source-chat"
            agents={[{ id: 'source-chat', name: 'Architect', state: 'Current conversation' }]}
            messages={[]}
            joiningOwner={{
              kind: 'application',
              sourceConversationId: 'source-chat',
              collaborationId: '00000000-0000-4000-8000-000000000001',
              captureReview: joiningMutation,
              review: joiningMutation,
              confirm: joiningMutation,
              recover: joiningMutation,
            }}
          />
        }
      >
        <p>Original chat controls</p>
      </WorkspaceControls>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Agents, Architect' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  const agent = await within(dialog).findByRole('combobox', { name: 'Agent', exact: true });
  const account = await within(dialog).findByRole('combobox', { name: 'Account', exact: true });
  const model = within(dialog).getByRole('combobox', { name: 'Model', exact: true });
  expect((account as HTMLSelectElement).value).toBe('offline-account');
  expect((model as HTMLSelectElement).value).toBe('offline-model');
  expect(within(dialog).getByRole('combobox', { name: 'Thinking level' })).toBeTruthy();
  fireEvent.change(agent, { target: { value: '["saved","reviewer",1]' } });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name in this chat' }), {
    target: { value: 'Bob' },
  });
  fireEvent.click(within(dialog).getByRole('radio', { name: 'Mac host' }));
  fireEvent.click(
    await within(dialog).findByRole('button', { name: 'Add repository', exact: true }),
  );
  expect(await within(dialog).findByRole('combobox', { name: 'Local repository' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add agent', exact: true }));
  expect(
    (screen.getByRole('textbox', { name: 'Name in this chat' }) as HTMLInputElement).value,
  ).toBe('Bob');
  expect(await screen.findByRole('combobox', { name: 'Account', exact: true })).toBeTruthy();
  expect(
    (screen.getByRole('combobox', { name: 'Agent', exact: true }) as HTMLSelectElement).value,
  ).toBe('["saved","reviewer",1]');
  fireEvent.click(screen.getByRole('button', { name: 'Close Agents' }));
  fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
  expect((screen.getByRole('textbox', { name: 'Source setting' }) as HTMLInputElement).value).toBe(
    'Original chat',
  );
  expect(screen.queryByRole('combobox', { name: 'Agent', exact: true })).toBeNull();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET'),
  ).toBe(true);
  expect(joiningMutation).not.toHaveBeenCalled();
});
