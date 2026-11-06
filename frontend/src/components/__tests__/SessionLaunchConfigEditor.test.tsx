// @vitest-environment jsdom
import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { SessionLaunchConfigEditor } from '../SessionLaunchConfigEditor';
import { apiFetch } from '../../lib/api-fetch';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('reviews existing picker observations, retains Local Mac host and edits isolated configuration', async () => {
  const inventory = localInventoryFixture();
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(inventory));
  const valid = vi.fn();
  let observed!: SessionLaunchConfig;
  function Fixture() {
    const [configuration, setConfiguration] = useState<SessionLaunchConfig>({
      version: 1,
      runtime: {
        version: 1,
        account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
        accountReference: inventory.accounts[0].account,
        agentProfile: { profileId: 'agent', revision: 1 },
        execution: { location: 'local', targetId: 'mac' },
      },
      mode: 'agent',
      isolation: true,
      repositoryWorkspaceId: null,
      contextBlocks: [],
      extraTools: [],
    });
    observed = configuration;
    return (
      <SessionLaunchConfigEditor
        configuration={configuration}
        onChange={setConfiguration}
        onValidityChange={valid}
      />
    );
  }
  render(
    <BrowserRouter>
      <Fixture />
    </BrowserRouter>,
  );
  await waitFor(() => expect(valid).toHaveBeenLastCalledWith(null));
  expect(observed.runtime.execution).toEqual({ location: 'local', targetId: 'mac' });
  fireEvent.change(screen.getByLabelText('Permission mode'), { target: { value: 'ask' } });
  expect(observed.mode).toBe('ask');
  fireEvent.change(screen.getByLabelText('Context'), {
    target: { value: 'A handoff with spaces\nand newlines' },
  });
  expect(observed.contextBlocks).toEqual(['A handoff with spaces\nand newlines']);
  expect(observed.runtime).not.toHaveProperty('capabilityRevision');
  expect(screen.queryByText('Make default for new chats')).toBeNull();
});
