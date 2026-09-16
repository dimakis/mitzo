// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionErrorMessage, ConnectionsView } from '../ConnectionsView';
import * as connections from '../../lib/connections-api';
import type { ConnectionTemplateCatalog, ConnectionsCatalog } from '../../types/connections';

vi.mock('../../lib/connections-api', () => ({
  getConnections: vi.fn(),
  getConnectionTemplates: vi.fn(),
  reauthorize: vi.fn(),
  createConnection: vi.fn(),
  updateAssignments: vi.fn(),
  testConnection: vi.fn(),
  rotateConnection: vi.fn(),
  revokeConnection: vi.fn(),
  deleteConnection: vi.fn(),
  retryConnection: vi.fn(),
  getConnectionAudit: vi.fn(),
}));

const catalog: ConnectionsCatalog = {
  connections: [
    {
      id: 'jira-1',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Jira',
      status: 'active',
      revision: 2,
      endpoint: 'https://redhat.atlassian.net',
      publicConfig: { email: 'me@example.com' },
      desiredAccountIds: ['work'],
      identity: 'me@example.com',
      verifiedAt: 1_700_000_000_000,
      errorCode: null,
    },
  ],
  legacy: [{ id: 'github', label: 'GitHub', management: 'operator-managed' }],
  eligibleAccounts: ['work', 'native'],
  appliesTo: 'new conversations only',
};
const templates: ConnectionTemplateCatalog = {
  templates: [
    {
      id: 'jira-readonly',
      version: 1,
      label: 'Jira',
      category: 'data',
      description: 'Read Jira metadata.',
      risk: 'read-only',
      capabilityIds: [],
      credentialFields: [
        {
          key: 'token',
          label: 'API token',
          description: 'One-shot secret.',
          style: 'api-token',
          secret: true,
          required: true,
        },
      ],
      connectionFields: [
        {
          key: 'email',
          label: 'Atlassian account email',
          description: 'Account identity.',
          kind: 'string',
          required: true,
        },
      ],
    },
    {
      id: 'github-readonly',
      version: 1,
      label: 'GitHub',
      category: 'source-control',
      description: 'Read GitHub repositories.',
      risk: 'read-only',
      capabilityIds: ['github.publish-pr'],
      credentialFields: [
        {
          key: 'token',
          label: 'Access token',
          description: 'One-shot secret.',
          style: 'bearer-token',
          secret: true,
          required: true,
        },
      ],
      connectionFields: [],
    },
    {
      id: 'custom-rest-readonly',
      version: 1,
      label: 'Custom REST API',
      category: 'custom-api',
      description: 'Operator-defined HTTPS REST reads.',
      risk: 'operator-defined',
      capabilityIds: [],
      credentialFields: [
        {
          key: 'token',
          label: 'Access token',
          description: 'One-shot secret.',
          style: 'bearer-token',
          secret: true,
          required: true,
        },
      ],
      connectionFields: [
        {
          key: 'endpoint',
          label: 'HTTPS endpoint',
          description: 'Public HTTPS only.',
          kind: 'url',
          required: true,
        },
      ],
    },
  ],
  capabilities: [
    {
      id: 'github.publish-pr',
      version: 1,
      label: 'Publish pull request',
      description: 'Publish committed work.',
      connectionTemplateIds: ['github-readonly'],
      approval: 'always',
      idempotency: 'required',
    },
  ],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  ) as HTMLButtonElement;
const input = (label: string) =>
  container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
const continueWizard = async () => {
  await act(async () => button('Continue').click());
};
const reauthorize = async () => {
  act(() => fireEvent.change(input('Passphrase'), { target: { value: 'pass' } }));
  await act(async () => button('Reauthorize').click());
};
const chooseJiraToAssignments = async () => {
  await act(async () => button('Choose Jira').click());
  act(() => fireEvent.change(input('API token'), { target: { value: 'secret' } }));
  await continueWizard();
  act(() =>
    fireEvent.change(input('Atlassian account email'), { target: { value: 'me@example.com' } }),
  );
  await continueWizard();
  await continueWizard();
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(connections.getConnections).mockResolvedValue(catalog);
  vi.mocked(connections.getConnectionTemplates).mockResolvedValue(templates);
  vi.mocked(connections.reauthorize).mockResolvedValue({
    csrf: 'c'.repeat(32),
    expiresAt: Date.now() + 300_000,
  });
  vi.mocked(connections.createConnection).mockResolvedValue(catalog.connections[0]);
  vi.mocked(connections.testConnection).mockResolvedValue(catalog.connections[0]);
  vi.mocked(connections.deleteConnection).mockResolvedValue(undefined);
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

describe('ConnectionsView', () => {
  it('shows reviewed catalog cards with category, authentication, and risk summaries', async () => {
    await render();
    expect(container.textContent).toContain('Read-only sandbox egress');
    expect(container.textContent).toContain('Operator-defined reviewed access');
    expect(container.textContent).toContain('Authentication: bearer token');
    expect(container.textContent).toContain('GitHub (operator-managed)');
  });
  it('uses native keyboard-focusable service controls to progress through the wizard', async () => {
    await render();
    const choose = button('Choose GitHub');
    const user = userEvent.setup();
    choose.focus();
    expect(document.activeElement).toBe(choose);
    await user.keyboard('{Enter}');
    expect(container.textContent).toContain('Authenticate with GitHub');
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Authenticate');
  });
  it('validates required fields, clears secrets on template change, and never renders the old secret', async () => {
    await render();
    await act(async () => button('Choose Jira').click());
    const continueButton = button('Continue');
    expect(continueButton.disabled).toBe(true);
    act(() => fireEvent.change(input('API token'), { target: { value: 'first-secret' } }));
    expect(continueButton.disabled).toBe(false);
    await act(async () => button('Back').click());
    await act(async () => button('Choose GitHub').click());
    expect(input('Access token').value).toBe('');
    expect(container.textContent).not.toContain('first-secret');
  });
  it('does not retain secret component state across unmount and re-entry', async () => {
    await render();
    await act(async () => button('Choose Jira').click());
    act(() => fireEvent.change(input('API token'), { target: { value: 'transient-secret' } }));
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => button('Choose Jira').click());
    expect(input('API token').value).toBe('');
    expect(container.textContent).not.toContain('transient-secret');
  });
  it('submits generic fields and one-shot credentials only after review, then clears the secret', async () => {
    await render();
    await chooseJiraToAssignments();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await continueWizard();
    expect(container.textContent).toContain('Effective access review');
    expect(container.textContent).toContain('Read Jira metadata.');
    expect(container.textContent).not.toContain('secret');
    await reauthorize();
    await act(async () => button('Verify and connect Jira').click());
    expect(connections.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: 'jira-readonly',
        fields: { email: 'me@example.com' },
        credentials: { token: 'secret' },
        accountIds: ['work'],
        csrf: 'c'.repeat(32),
      }),
    );
    expect(container.textContent).not.toContain('secret');
  });
  it('clears credentials after a failed submission and refreshes authoritative state', async () => {
    vi.mocked(connections.createConnection).mockRejectedValue(
      new Error('Connection verification failed'),
    );
    await render();
    await chooseJiraToAssignments();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await continueWizard();
    await reauthorize();
    await act(async () => button('Verify and connect Jira').click());
    expect(container.textContent).toContain('Connection verification failed');
    expect(container.textContent).not.toContain('secret');
    expect(vi.mocked(connections.getConnections).mock.calls.length).toBeGreaterThan(1);
  });
  it('describes capability selection as non-durable intent until capability grants land', async () => {
    await render();
    await act(async () => button('Choose GitHub').click());
    act(() => fireEvent.change(input('Access token'), { target: { value: 'secret' } }));
    await continueWizard();
    await continueWizard();
    expect(container.textContent).toContain(
      'does not activate capabilities during connection creation',
    );
    expect(container.textContent).toContain('Publish pull request');
  });
  it('recovers from a stale revision by refreshing after the server conflict', async () => {
    vi.mocked(connections.updateAssignments).mockRejectedValue(
      new Error('Connection changed; refresh and try again.'),
    );
    await render();
    await reauthorize();
    const native = Array.from(container.querySelectorAll('input[type="checkbox"]')).find((item) =>
      item.parentElement?.textContent?.includes('native'),
    ) as HTMLInputElement;
    await act(async () => native.click());
    expect(container.textContent).toContain('Connection changed; refresh and try again.');
    expect(vi.mocked(connections.getConnections).mock.calls.length).toBeGreaterThan(1);
  });
  it('clears rotation secrets when dismissed and supplies generic credential maps', async () => {
    await render();
    await act(async () => button('Rotate credentials').click());
    act(() =>
      fireEvent.change(input('Replacement API token'), { target: { value: 'replacement' } }),
    );
    act(() => button('Cancel').click());
    expect(container.querySelector('[aria-label="Replacement API token"]')).toBeNull();
    expect(container.textContent).not.toContain('replacement');
  });
  it('retains existing recovery wording and has a narrow mobile layout rule', () => {
    expect(connectionErrorMessage('JIRA_AUTH_REJECTED')).toContain('email matches');
    expect(connectionErrorMessage('ACCOUNT_ALREADY_ASSIGNED')).toContain(
      'Remove the old connection',
    );
    const styles = readFileSync('frontend/src/styles/workspace.css', 'utf8');
    expect(styles).toContain('@media (max-width: 520px)');
    expect(styles).toContain('.connections-template');
  });
});
