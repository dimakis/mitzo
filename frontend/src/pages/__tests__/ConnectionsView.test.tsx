// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsView } from '../ConnectionsView';
import * as connections from '../../lib/connections-api';
import type { ConnectionsCatalog } from '../../types/connections';

vi.mock('../../lib/connections-api', () => ({
  getConnections: vi.fn(),
  reauthorize: vi.fn(),
  createConnection: vi.fn(),
  updateAssignments: vi.fn(),
  testConnection: vi.fn(),
  rotateConnection: vi.fn(),
  revokeConnection: vi.fn(),
  retryConnection: vi.fn(),
  getConnectionAudit: vi.fn(),
}));

const catalog: ConnectionsCatalog = {
  connections: [
    {
      id: 'jira-1',
      label: 'Jira',
      status: 'active',
      revision: 2,
      endpoint: 'https://redhat.atlassian.net',
      desiredAccountIds: ['work'],
      identity: 'me@example.com',
      verifiedAt: 1_700_000_000_000,
      errorCode: null,
    },
  ],
  legacy: [
    { id: 'github', label: 'GitHub', management: 'operator-managed' },
    { id: 'google-workspace', label: 'Google Workspace', management: 'operator-managed' },
  ],
  eligibleAccounts: ['work', 'native'],
  appliesTo: 'new conversations only',
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(connections.getConnections).mockResolvedValue(catalog);
  vi.mocked(connections.reauthorize).mockResolvedValue({
    csrf: 'c'.repeat(32),
    expiresAt: Date.now() + 300_000,
  });
  vi.mocked(connections.createConnection).mockResolvedValue(catalog.connections[0]);
  vi.mocked(connections.testConnection).mockResolvedValue(catalog.connections[0]);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  vi.restoreAllMocks();
});
const render = async () => {
  act(() => root.render(<ConnectionsView />));
  await flush();
};
const input = (label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  ) as HTMLButtonElement;

describe('ConnectionsView', () => {
  it('shows actual identity, eligible profiles, legacy services, and new-conversation scope', async () => {
    await render();
    expect(container.textContent).toContain('me@example.com');
    expect(container.textContent).toContain('new conversations only');
    expect(container.textContent).toContain('GitHub (operator-managed)');
    expect(
      Array.from(container.querySelectorAll('input[type="checkbox"]')).some((item) =>
        item.parentElement?.textContent?.includes('work'),
      ),
    ).toBe(true);
  });
  it('reauthorizes then submits selected profiles and clears the token after success', async () => {
    await render();
    act(() => {
      fireEvent.change(input('Passphrase'), { target: { value: 'pass' } });
    });
    await act(async () => button('Reauthorize').click());
    const formToken = input('Jira API token');
    const email = container.querySelector('input[type="email"]') as HTMLInputElement;
    act(() => {
      fireEvent.change(email, { target: { value: 'me@example.com' } });
      fireEvent.change(formToken, { target: { value: 'secret' } });
    });
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    act(() => (boxes[0] as HTMLInputElement).click());
    await act(async () => button('Consent and connect Jira').click());
    expect(connections.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'secret', accountIds: ['work'], csrf: 'c'.repeat(32) }),
    );
    expect(formToken.value).toBe('');
  });
  it('keeps a failed identity test visibly unconnected and refreshes the status', async () => {
    vi.mocked(connections.testConnection).mockRejectedValue(
      new Error('Connection verification failed'),
    );
    await render();
    act(() => {
      fireEvent.change(input('Passphrase'), { target: { value: 'pass' } });
    });
    await act(async () => button('Reauthorize').click());
    await act(async () => button('Test identity').click());
    expect(container.textContent).toContain('Connection verification failed');
    expect(vi.mocked(connections.getConnections).mock.calls.length).toBeGreaterThan(1);
  });
  it('clears replacement tokens when the rotation form is dismissed', async () => {
    await render();
    act(() => button('Rotate token').click());
    const token = input('Replacement Jira API token');
    act(() => {
      fireEvent.change(token, { target: { value: 'replacement' } });
    });
    act(() => button('Cancel').click());
    expect(container.querySelector('[aria-label="Replacement Jira API token"]')).toBeNull();
    expect(container.textContent).not.toContain('replacement');
  });
  it('offers a true retry action for a failed initial provisioning', async () => {
    vi.mocked(connections.getConnections).mockResolvedValue({
      ...catalog,
      connections: [
        { ...catalog.connections[0], status: 'needs_attention', errorCode: 'PROVISION_FAILED' },
      ],
    });
    await render();
    expect(button('Retry with token')).toBeTruthy();
  });
});
