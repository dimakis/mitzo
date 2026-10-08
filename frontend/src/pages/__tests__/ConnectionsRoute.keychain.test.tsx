// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsRoute } from '../ConnectionsRoute';

vi.mock('../../lib/connections-api', () => ({
  getConnections: vi.fn(async () => ({ connections: [], legacy: [], eligibleAccounts: [] })),
  getConnectionTemplates: vi.fn(async () => ({ templates: [], capabilities: [] })),
}));
vi.mock('../../components/CredentialConnectionsPanel', () => ({
  CredentialConnectionsPanel: ({ connectionId }: { connectionId?: string }) => (
    <p>Keychain controls: {connectionId ?? 'setup'}</p>
  ),
}));
afterEach(cleanup);

it('opens only the selected Keychain connection from its management destination', async () => {
  render(
    <MemoryRouter initialEntries={['/connections?manage=keychain&connection=service%2Fa%26b']}>
      <ConnectionsRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Keychain controls: service/a&b')).toBeTruthy();
  expect(screen.queryByText('Choose ChatGPT')).toBeNull();
});

it('offers Keychain setup through the add chooser without opening management controls', async () => {
  render(
    <MemoryRouter initialEntries={['/connections']}>
      <ConnectionsRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('link', { name: 'Choose Apple Keychain' })).toHaveProperty(
    'href',
    expect.stringContaining('/connections?manage=keychain'),
  );
  expect(screen.queryByText('Keychain controls: setup')).toBeNull();
});
