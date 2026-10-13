// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AccountModelPicker } from '../AccountModelPicker';
import { ChatAgentProfilePicker } from '../ChatAgentProfilePicker';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
afterEach(cleanup);
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
