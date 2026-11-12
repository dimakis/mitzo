// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { useSessionLaunchDefaults } from '../../hooks/useSessionLaunchDefaults';
import { SessionLaunchDefaultsControl } from '../SessionLaunchDefaultsControl';
import { WorkspaceControls } from '../WorkspaceControls';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

it('saves every setting through the existing Defaults row and visibly reports a conflict', async () => {
  const configuration: SessionLaunchConfig = {
    version: 1,
    runtime: {
      version: 1,
      account: { accountId: 'work', model: 'luna-fixture', reasoningEffort: 'high' },
      agentProfile: { profileId: 'agent', revision: 2 },
      execution: { location: 'local', targetId: 'my-mac' },
    },
    mode: 'ask',
    isolation: false,
    repositoryWorkspaceId: 'source-hint',
    contextBlocks: ['Shared project context'],
    extraTools: ['Read'],
  };
  vi.mocked(apiFetch).mockImplementation(async (_url, options) =>
    options?.method === 'PUT'
      ? Response.json({ error: 'Defaults changed. Refresh before saving.' }, { status: 409 })
      : Response.json({ revision: 3, configuration: null }),
  );
  function Fixture() {
    const defaults = useSessionLaunchDefaults();
    return (
      <WorkspaceControls
        status="Ready"
        settings={
          <SessionLaunchDefaultsControl configuration={configuration} defaults={defaults} />
        }
      >
        {null}
      </WorkspaceControls>
    );
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'New-chat defaults, Not set' })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'New-chat defaults, Not set' }));
  fireEvent.click(screen.getByRole('button', { name: 'Make default for new chats' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Defaults changed'));
  expect(apiFetch).toHaveBeenCalledWith('/api/session-launch/defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 3, configuration }),
  });
  expect(screen.getByRole('button', { name: 'Retry session defaults' })).toBeTruthy();
});
