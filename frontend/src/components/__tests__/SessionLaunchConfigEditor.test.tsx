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

it.each(['mac', 'retired-host', null])(
  'reviews and edits host %s with multiple eligible hosts without changing account or context intent',
  async (initialTarget) => {
    const inventory = localInventoryFixture();
    inventory.targets.push({ ...inventory.targets[0], targetId: 'second-mac', label: 'Build Mac' });
    inventory.routes.push({ ...inventory.routes[0], targetId: 'second-mac' });
    vi.mocked(apiFetch).mockImplementation(async () => Response.json(inventory));
    let observed!: SessionLaunchConfig;
    function Fixture() {
      const [configuration, setConfiguration] = useState<SessionLaunchConfig>({
        version: 1,
        runtime: {
          version: 1,
          account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
          accountReference: inventory.accounts[0].account,
          agentProfile: null,
          execution: { location: 'local', targetId: initialTarget },
        },
        mode: 'agent',
        isolation: true,
        repositoryWorkspaceId: null,
        contextBlocks: ['Preserve context'],
        extraTools: [],
      });
      observed = configuration;
      return (
        <SessionLaunchConfigEditor configuration={configuration} onChange={setConfiguration} />
      );
    }
    render(
      <BrowserRouter>
        <Fixture />
      </BrowserRouter>,
    );
    const host = await screen.findByRole('combobox', { name: 'Execution host' });
    await waitFor(() => expect(host.querySelector('option[value="second-mac"]')).toBeTruthy());
    expect((host as HTMLSelectElement).value).toBe(initialTarget ?? '');
    fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
    expect(observed.runtime.execution.targetId).toBe(initialTarget);
    fireEvent.change(host, { target: { value: 'second-mac' } });
    expect(observed.runtime.execution).toEqual({ location: 'local', targetId: 'second-mac' });
    expect(observed.runtime.account).toEqual({
      accountId: 'personal',
      model: 'luna-fixture',
      reasoningEffort: 'high',
    });
    expect(observed.contextBlocks).toEqual(['Preserve context']);
  },
);
