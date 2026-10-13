// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AccountModelPicker } from '../AccountModelPicker';
import { ChatAgentProfilePicker } from '../ChatAgentProfilePicker';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { ChatExecutionPicker } from '../ChatExecutionPicker';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import type { useExplicitLocalChat } from '../../hooks/useExplicitLocalChat';
afterEach(cleanup);
it('derives software from the selected route and leaves unresolved OpenShell without a software claim', () => {
  const runtime = {
    visible: true,
    selectedLocal: true,
    bound: false,
    metadataUnavailable: false,
    inventory: localInventoryFixture(),
    intent: {
      ...createChatRuntimeSelection(),
      execution: { location: 'local', targetId: 'mac' },
      account: { accountId: 'personal', model: 'luna-fixture' },
    },
    update: vi.fn(),
    refresh: vi.fn(),
    review: vi.fn(),
  } as unknown as ReturnType<typeof useExplicitLocalChat>;
  const { rerender } = render(
    <MemoryRouter>
      <ChatExecutionPicker runtime={runtime} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Runs with Codex')).toBeInTheDocument();
  rerender(
    <MemoryRouter>
      <ChatExecutionPicker
        runtime={{ ...runtime, selectedLocal: false, intent: createChatRuntimeSelection() }}
      />
    </MemoryRouter>,
  );
  expect(screen.queryByText(/Runs with/)).toBeNull();
});
it('retains unavailable selected account/model/thinking and never fetches the legacy catalog', () => {
  const changed = vi.fn();
  const data = localInventoryFixture();
  render(
    <AccountModelPicker
      sessionId={null}
      preferredModel=""
      onChange={changed}
      controlled={{
        accounts: data.accounts.map((a) => ({ ...a, id: a.account.accountId })),
        selection: { accountId: 'missing', model: 'old-model', reasoningEffort: 'removed' },
        onChange: changed,
      }}
    />,
  );
  expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('missing');
  expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('old-model');
  expect(screen.getByRole('combobox', { name: 'Thinking' })).toHaveValue('removed');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
    target: { value: 'personal' },
  });
  expect(changed).toHaveBeenCalledWith({
    accountId: 'personal',
    model: 'old-model',
    reasoningEffort: 'removed',
  });
});
it('retains an unavailable exact published revision and offers no Default Mitzo substitute', () => {
  const changed = vi.fn();
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker
        sessionId={null}
        search=""
        onChange={changed}
        controlled={{
          versions: localInventoryFixture().agentProfiles,
          selection: { profileId: 'removed', revision: 4 },
          onChange: changed,
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue(
    JSON.stringify(['saved', 'removed', 4]),
  );
  expect(screen.queryByText('Default Mitzo')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});
it('preserves builtin identity visibly blocked when a published user profile has the same ID and revision', () => {
  const fixture = localInventoryFixture();
  const changed = vi.fn();
  render(
    <MemoryRouter>
      <ChatAgentProfilePicker
        sessionId={null}
        search=""
        onChange={changed}
        controlled={{
          versions: fixture.agentProfiles,
          selection: {
            kind: 'builtin',
            profileId: 'agent',
            revision: 1,
          } as import('@mitzo/protocol').AgentProfileSelection,
          onChange: changed,
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue(
    JSON.stringify(['builtin', 'agent', 1]),
  );
  expect(screen.getByRole('option', { name: /Unavailable builtin agent/ })).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), {
    target: { value: JSON.stringify(['saved', 'agent', 1]) },
  });
  expect(changed).toHaveBeenCalledWith({ profileId: 'agent', revision: 1 });
});

it('starts elsewhere with copied agent/account intent and a separate empty retained draft', async () => {
  const { listChatDrafts } = await import('../../lib/chat-drafts');
  localStorage.clear();
  const data = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
    accountReference: data.accounts[0].account,
  };
  const runtime = {
    visible: true,
    bound: true,
    continuation: true,
    selectedLocal: true,
    metadataUnavailable: false,
    inventory: data,
    intent,
    binding: {
      version: 2,
      account: data.accounts[0].account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
    },
    update: vi.fn(),
    refresh: vi.fn(),
    review: vi.fn(),
  } as unknown as ReturnType<typeof useExplicitLocalChat>;
  render(
    <MemoryRouter>
      <ChatExecutionPicker runtime={runtime} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New session on OpenShell' }));
  const drafts = listChatDrafts();
  expect(drafts).toHaveLength(1);
  expect(drafts[0].text).toBe('');
  expect(drafts[0].settings).toMatchObject({
    retainRuntimeIntent: true,
    repositoryWorkspaceId: null,
    selection: intent.account,
    runtimeSelection: {
      accountReference: data.accounts[0].account,
      account: intent.account,
      agentProfile: intent.agentProfile,
      execution: { location: 'openshell', targetId: null },
      capabilityRevision: null,
    },
  });
  expect(runtime.intent.execution).toEqual({ location: 'local', targetId: 'mac' });
  expect(runtime.update).not.toHaveBeenCalled();
  localStorage.clear();
});

it('uses only the Account control to explicitly reselect routing while model edits stay future intent', () => {
  const data = localInventoryFixture();
  const future = vi.fn(),
    account = vi.fn();
  render(
    <AccountModelPicker
      sessionId={null}
      preferredModel=""
      onChange={future}
      controlled={{
        accounts: data.accounts.map((entry) => ({ ...entry, id: entry.account.accountId })),
        selection: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
        onChange: future,
        onAccountChange: account,
      }}
    />,
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Thinking' }), {
    target: { value: 'high' },
  });
  expect(future).toHaveBeenCalledWith(expect.objectContaining({ reasoningEffort: 'high' }));
  expect(account).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), { target: { value: '' } });
  expect(account).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: undefined, model: 'luna-fixture' }),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
    target: { value: 'personal' },
  });
  expect(account).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'personal' }));
});
