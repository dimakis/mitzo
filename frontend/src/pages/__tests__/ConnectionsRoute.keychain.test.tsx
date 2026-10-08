// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConnectionsRoute } from '../ConnectionsRoute';

vi.mock('../../lib/connections-api', () => ({
  getConnections: vi.fn(async () => ({
    connections: [],
    legacy: [],
    eligibleAccounts: [],
    openAIKeysManaged: true,
  })),
  getConnectionTemplates: vi.fn(async () => ({ templates: [], capabilities: [] })),
}));
vi.mock('../../components/CredentialConnectionsPanel', () => ({
  CredentialConnectionsPanel: ({ connectionId }: { connectionId?: string }) => (
    <p>Keychain controls: {connectionId ?? 'setup'}</p>
  ),
}));
vi.mock('../../components/OpenAIKeyControls', () => ({
  OpenAIKeyControls: ({ accountId }: { accountId?: string }) => <p>OpenAI controls: {accountId}</p>,
}));
afterEach(cleanup);
it('recognizes the enrollment route without exposing existing key replacement controls', async () => {
  render(
    <MemoryRouter initialEntries={['/connections?manage=openai-add']}>
      <ConnectionsRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByText('Adding OpenAI API accounts is unavailable.')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add OpenAI API account');
  expect(screen.queryByText(/OpenAI controls/)).toBeNull();
});

it('keeps OpenAI account management separate from Keychain service management', async () => {
  render(
    <MemoryRouter initialEntries={['/connections?manage=openai&connection=work']}>
      <ConnectionsRoute />
    </MemoryRouter>,
  );
  expect(await screen.findByText('OpenAI controls: work')).toBeTruthy();
  expect(screen.queryByText('Keychain controls: work')).toBeNull();
  expect(screen.queryByText('Choose ChatGPT')).toBeNull();
});

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
