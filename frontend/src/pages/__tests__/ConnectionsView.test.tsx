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
  getConnectionCapabilityGrants: vi.fn(),
  setConnectionCapabilityGrant: vi.fn(),
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
      available: true,
      capabilityTemplates: [],
      guidance: {
        body: 'Use a scoped token with Jira read permission.',
        href: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
        linkLabel: 'Atlassian token and scope guidance',
      },
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
          kind: 'email',
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
      available: false,
      capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }],
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
      id: 'jira-readonly',
      version: 2,
      label: 'Jira v2',
      category: 'data',
      description: 'Read Jira metadata through v2.',
      risk: 'read-only',
      available: true,
      capabilityTemplates: [],
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
          kind: 'email',
          required: true,
        },
      ],
    },
    {
      id: 'custom-rest-readonly',
      version: 1,
      label: 'Custom REST API',
      category: 'custom-api',
      description: 'Operator-defined HTTPS REST reads.',
      risk: 'operator-defined',
      available: false,
      capabilityTemplates: [],
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
        {
          key: 'port',
          label: 'HTTPS port',
          description: 'Reviewed ports.',
          kind: 'enum-list',
          required: true,
          choices: ['443', '8443'],
        },
        {
          key: 'protocol',
          label: 'Inspection protocol',
          description: 'Reviewed protocols.',
          kind: 'enum-list',
          required: true,
          choices: ['rest', 'graphql'],
        },
        {
          key: 'methods',
          label: 'Read methods',
          description: 'Reviewed methods.',
          kind: 'enum-list',
          required: true,
          choices: ['GET', 'HEAD', 'OPTIONS', 'GRAPHQL_QUERY'],
        },
        {
          key: 'paths',
          label: 'Allowed paths',
          description: 'Paths.',
          kind: 'string-list',
          required: true,
        },
        {
          key: 'credentialStyle',
          label: 'Credential style',
          description: 'Style.',
          kind: 'enum-list',
          required: true,
          choices: ['bearer-token', 'api-token'],
        },
        {
          key: 'credentialLocation',
          label: 'Credential location',
          description: 'Location.',
          kind: 'enum-list',
          required: true,
          choices: ['header', 'query'],
        },
        {
          key: 'credentialName',
          label: 'Credential mapping',
          description: 'Name.',
          kind: 'enum-list',
          required: true,
          choices: ['authorization', 'x-api-key', 'api_key', 'access_token'],
        },
        {
          key: 'binaries',
          label: 'Approved sandbox binaries',
          description: 'Binaries.',
          kind: 'enum-list',
          required: true,
          choices: ['curl', 'jq', 'python3'],
        },
        {
          key: 'attachmentMode',
          label: 'Attachment mode',
          description: 'Attachment.',
          kind: 'enum-list',
          required: true,
          choices: ['automatic', 'on-demand'],
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
      connectionTemplates: [{ id: 'github-readonly', version: 1 }],
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
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};
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
  vi.clearAllMocks();
  vi.mocked(connections.getConnections).mockResolvedValue(catalog);
  vi.mocked(connections.getConnectionTemplates).mockResolvedValue(templates);
  vi.mocked(connections.reauthorize).mockResolvedValue({
    csrf: 'c'.repeat(32),
    expiresAt: Date.now() + 300_000,
  });
  vi.mocked(connections.createConnection).mockResolvedValue(catalog.connections[0]);
  vi.mocked(connections.testConnection).mockResolvedValue(catalog.connections[0]);
  vi.mocked(connections.deleteConnection).mockResolvedValue(undefined);
  vi.mocked(connections.getConnectionCapabilityGrants).mockResolvedValue([]);
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
  it('grants and revokes a reviewed capability only after reauthorization', async () => {
    const github = {
      ...catalog.connections[0]!,
      id: 'github-1',
      templateId: 'github-readonly',
      label: 'GitHub',
      desiredAccountIds: ['work'],
      capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }],
    };
    vi.mocked(connections.getConnections).mockResolvedValue({ ...catalog, connections: [github] });
    let active = false;
    vi.mocked(connections.getConnectionCapabilityGrants).mockImplementation(async () =>
      active
        ? [
            {
              id: 'grant-1',
              connectionId: github.id,
              connectionRevision: github.revision,
              capabilityId: 'github.publish-pr',
              capabilityVersion: 1,
              accountIds: ['work'],
              status: 'active',
            },
          ]
        : [],
    );
    vi.mocked(connections.setConnectionCapabilityGrant).mockImplementation(async (value) => {
      active = value.status === 'active';
      return {
        id: 'grant-1',
        connectionId: github.id,
        connectionRevision: github.revision,
        capabilityId: value.capabilityId,
        capabilityVersion: value.capabilityVersion,
        accountIds: value.accountIds,
        status: value.status,
      };
    });
    await render();
    await act(async () => button('Manage capability grants').click());
    expect(container.textContent).toContain('Publish pull request');
    const profile = container.querySelector(
      '.connections-capability input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => profile.click());
    await act(async () => button('Save grant').click());
    expect(connections.setConnectionCapabilityGrant).not.toHaveBeenCalled();
    await reauthorize();
    await act(async () => button('Save grant').click());
    expect(connections.setConnectionCapabilityGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'github-1',
        revision: 2,
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        accountIds: ['work'],
        status: 'active',
        csrf: 'c'.repeat(32),
      }),
    );
    expect(container.textContent).toContain('Active for: work');
    await act(async () => button('Revoke grant').click());
    expect(connections.setConnectionCapabilityGrant).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'revoked',
        accountIds: ['work'],
      }),
    );
    expect(container.textContent).toContain('No active grant.');
  });
  it('keeps capability revocation available when the setup catalog fails', async () => {
    const github = {
      ...catalog.connections[0]!,
      id: 'github-1',
      templateId: 'github-readonly',
      label: 'GitHub',
      capabilityTemplates: [{ id: 'github.publish-pr', version: 1 }],
    };
    vi.mocked(connections.getConnections).mockResolvedValue({ ...catalog, connections: [github] });
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('catalog unavailable'),
    );
    vi.mocked(connections.getConnectionCapabilityGrants).mockResolvedValue([
      {
        id: 'grant-1',
        connectionId: github.id,
        connectionRevision: github.revision,
        capabilityId: 'github.publish-pr',
        capabilityVersion: 1,
        accountIds: ['work'],
        status: 'active',
      },
    ]);
    await render();
    await act(async () => button('Manage capability grants').click());
    expect(container.textContent).toContain('github.publish-pr v1');
    expect(button('Revoke grant')).toBeTruthy();
  });
  it('shows reviewed catalog cards with category, authentication, and risk summaries', async () => {
    await render();
    expect(container.textContent).toContain('Read-only sandbox egress');
    expect(container.textContent).toContain('Operator-defined reviewed access');
    expect(container.textContent).toContain('Authentication: bearer token');
    expect(container.textContent).toContain('GitHub (operator-managed)');
  });
  it('does not expose wizard navigation until a service is explicitly chosen', async () => {
    await render();
    expect(button('Continue')).toBeUndefined();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Service');
  });
  it('keeps existing connection controls available when the setup catalog fails', async () => {
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('Template catalog unavailable'),
    );
    await render();
    expect(container.textContent).toContain('Connection setup is temporarily unavailable');
    expect(container.textContent).toContain('me@example.com');
    expect(button('Test identity')).toBeTruthy();
    expect(button('Revoke')).toBeTruthy();
    expect(button('Remove connection')).toBeTruthy();
    await reauthorize();
    await act(async () => button('Test identity').click());
    expect(connections.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira-1', revision: 2 }),
    );
  });
  it('rotates a GitHub connection using its reviewed field metadata when the setup catalog fails', async () => {
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('Template catalog unavailable'),
    );
    vi.mocked(connections.getConnections).mockResolvedValue({
      ...catalog,
      connections: [
        {
          ...catalog.connections[0],
          id: 'github-1',
          templateId: 'github-readonly',
          label: 'GitHub',
          credentialFields: [
            {
              key: 'token',
              label: 'Access token',
              description: 'Gateway-owned token',
              style: 'bearer-token',
              secret: true,
              required: true,
            },
          ],
        },
      ],
    });
    await render();
    await reauthorize();
    expect(button('Rotate credentials').disabled).toBe(false);
    await act(async () => button('Rotate credentials').click());
    act(() =>
      fireEvent.change(input('Replacement Access token'), { target: { value: 'smoke-secret' } }),
    );
    await act(async () => button('Verify and rotate').click());
    expect(connections.rotateConnection).toHaveBeenCalledWith({
      id: 'github-1',
      revision: 2,
      credentials: { token: 'smoke-secret' },
      csrf: 'c'.repeat(32),
    });
    expect(container.textContent).not.toContain('smoke-secret');
  });
  it('renders and manages existing connections while template loading never resolves', async () => {
    vi.mocked(connections.getConnectionTemplates).mockReturnValue(new Promise(() => {}));
    await render();
    expect(container.textContent).toContain('me@example.com');
    await reauthorize();
    await act(async () => button('Test identity').click());
    expect(connections.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira-1', revision: 2 }),
    );
  });
  it('awaits connection reconciliation for mutations and ignores an older overlapping refresh', async () => {
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('Template catalog unavailable'),
    );
    await render();
    const older = deferred<ConnectionsCatalog>();
    const newer = deferred<ConnectionsCatalog>();
    vi.mocked(connections.getConnections)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await reauthorize();
    await act(async () => button('Test identity').click());
    expect(button('Test identity').disabled).toBe(true);
    await act(async () => button('Retry setup').click());
    older.resolve({
      ...catalog,
      connections: [{ ...catalog.connections[0], label: 'Older state' }],
    });
    await flush();
    expect(button('Test identity').disabled).toBe(true);
    newer.resolve({
      ...catalog,
      connections: [{ ...catalog.connections[0], label: 'Latest state' }],
    });
    await flush();
    expect(button('Test identity').disabled).toBe(false);
    expect(container.textContent).toContain('Latest state');
    expect(container.textContent).not.toContain('Older state');
  });
  it('retains cached credential metadata for active rotations during a template outage', async () => {
    await render();
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('Template catalog unavailable'),
    );
    await reauthorize();
    await act(async () => button('Test identity').click());
    expect(container.textContent).toContain('Connection setup is temporarily unavailable');
    await act(async () => button('Rotate credentials').click());
    expect(input('Replacement API token')).toBeTruthy();
    act(() =>
      fireEvent.change(input('Replacement API token'), { target: { value: 'replacement' } }),
    );
    await act(async () => button('Verify and rotate').click());
    expect(connections.rotateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira-1', credentials: { token: 'replacement' } }),
    );
  });
  it('uses native keyboard-focusable service controls to progress through the wizard', async () => {
    await render();
    const choose = button('Choose Jira');
    const user = userEvent.setup();
    choose.focus();
    expect(document.activeElement).toBe(choose);
    await user.keyboard('{Enter}');
    expect(container.textContent).toContain('Authenticate with Jira');
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Authenticate');
    expect(document.activeElement?.textContent).toBe('Authenticate');
  });
  it('validates required fields, clears secrets on template change, and never renders the old secret', async () => {
    await render();
    await act(async () => button('Choose Jira').click());
    const continueButton = button('Continue');
    expect(continueButton.disabled).toBe(true);
    act(() => fireEvent.change(input('API token'), { target: { value: 'first-secret' } }));
    expect(continueButton.disabled).toBe(false);
    await act(async () => button('Back').click());
    await act(async () => button('Choose Jira v2').click());
    expect(input('API token').value).toBe('');
    expect(container.textContent).not.toContain('first-secret');
  });
  it('blocks Authenticate with accessible label validation and renders reviewed provider guidance', async () => {
    await render();
    await act(async () => button('Choose Jira').click());
    act(() => fireEvent.change(input('Connection label'), { target: { value: '  ' } }));
    expect(input('Connection label').getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Enter a connection label before continuing.');
    expect(button('Continue').disabled).toBe(true);
    expect(container.textContent).toContain('Use a scoped token with Jira read permission.');
    const help = Array.from(container.querySelectorAll('a')).find(
      (item) => item.textContent === 'Atlassian token and scope guidance',
    );
    expect(help?.getAttribute('href')).toMatch(/^https:\/\//);
  });
  it('requires valid email and URL scope fields before Continue', async () => {
    vi.mocked(connections.getConnectionTemplates).mockResolvedValue({
      ...templates,
      templates: templates.templates.map((template) =>
        template.id === 'custom-rest-readonly' ? { ...template, available: true } : template,
      ),
    });
    await render();
    await act(async () => button('Choose Jira').click());
    act(() => fireEvent.change(input('API token'), { target: { value: 'secret' } }));
    await continueWizard();
    act(() =>
      fireEvent.change(input('Atlassian account email'), { target: { value: 'not-an-email' } }),
    );
    expect(button('Continue').disabled).toBe(true);
    act(() =>
      fireEvent.change(input('Atlassian account email'), { target: { value: 'me@example.com' } }),
    );
    expect(button('Continue').disabled).toBe(false);

    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Choose Custom REST API').click());
    act(() => fireEvent.change(input('Access token'), { target: { value: 'secret' } }));
    await continueWizard();
    act(() => fireEvent.change(input('HTTPS endpoint'), { target: { value: 'not a url' } }));
    expect(button('Continue').disabled).toBe(true);
    act(() =>
      fireEvent.change(input('HTTPS endpoint'), { target: { value: 'https://api.example.com' } }),
    );
    expect(button('Continue').disabled).toBe(true);
    act(() => fireEvent.change(input('Allowed paths'), { target: { value: '/v1/items' } }));
    expect(button('Continue').disabled).toBe(false);
    expect(input('HTTPS endpoint').type).toBe('url');
    act(() =>
      fireEvent.change(input('HTTPS endpoint'), { target: { value: 'http://api.example.com' } }),
    );
    expect(button('Continue').disabled).toBe(true);
  });
  it('gates custom protocol combinations and normalizes dependent selections', async () => {
    vi.mocked(connections.getConnectionTemplates).mockResolvedValue({
      ...templates,
      templates: templates.templates.map((template) =>
        template.id === 'custom-rest-readonly' ? { ...template, available: true } : template,
      ),
    });
    await render();
    await act(async () => button('Choose Custom REST API').click());
    act(() => fireEvent.change(input('Access token'), { target: { value: 'secret' } }));
    await continueWizard();
    act(() =>
      fireEvent.change(input('HTTPS endpoint'), { target: { value: 'https://api.openai.com' } }),
    );
    act(() => fireEvent.change(input('Allowed paths'), { target: { value: '/v1/items' } }));
    expect(button('Continue').disabled).toBe(false);
    const graphql = Array.from(container.querySelectorAll('label')).find(
      (label) => label.textContent?.trim() === 'graphql',
    )!;
    await act(async () => (graphql.querySelector('input') as HTMLInputElement).click());
    expect(input('Allowed paths').value).toBe('/graphql');
    expect(button('Continue').disabled).toBe(false);
    const query = Array.from(container.querySelectorAll('label')).find(
      (label) => label.textContent?.trim() === 'GRAPHQL_QUERY',
    )!;
    await act(async () => (query.querySelector('input') as HTMLInputElement).click());
    expect(button('Continue').disabled).toBe(true);
    await act(async () => (query.querySelector('input') as HTMLInputElement).click());
    expect(button('Continue').disabled).toBe(false);
    act(() => fireEvent.change(input('Allowed paths'), { target: { value: '/v1/items' } }));
    expect(button('Continue').disabled).toBe(true);
  });
  it('resets selected profiles when changing the template', async () => {
    await render();
    await chooseJiraToAssignments();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Choose Jira v2').click());
    act(() => fireEvent.change(input('API token'), { target: { value: 'v2-secret' } }));
    await continueWizard();
    act(() =>
      fireEvent.change(input('Atlassian account email'), { target: { value: 'me@example.com' } }),
    );
    await continueWizard();
    await continueWizard();
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
  });
  it('resets the complete wizard when a refreshed catalog removes its selected template', async () => {
    await render();
    await chooseJiraToAssignments();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    vi.mocked(connections.getConnectionTemplates).mockResolvedValue({
      ...templates,
      templates: templates.templates.filter(
        (item) => item.id !== 'jira-readonly' || item.version !== 1,
      ),
    });
    await reauthorize();
    await act(async () => button('Test identity').click());
    await flush();
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe('Service');
    expect(container.textContent).toContain('Choose Jira v2');
    expect(container.textContent).not.toContain('Authenticate with Jira');
    await act(async () => button('Choose Jira v2').click());
    expect(input('API token').value).toBe('');
    act(() => fireEvent.change(input('API token'), { target: { value: 'v2-token' } }));
    await continueWizard();
    expect(input('Atlassian account email').value).toBe('');
    act(() =>
      fireEvent.change(input('Atlassian account email'), { target: { value: 'me@example.com' } }),
    );
    await continueWizard();
    await continueWizard();
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
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
    await act(async () => button('Back').click());
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
  });
  it('permits an explicitly unassigned connection when no profiles are eligible', async () => {
    vi.mocked(connections.getConnections).mockResolvedValue({
      ...catalog,
      eligibleAccounts: [],
    });
    await render();
    await chooseJiraToAssignments();
    expect(container.textContent).toContain('create this connection unassigned');
    expect(button('Continue').disabled).toBe(false);
    await continueWizard();
    expect(container.textContent).toContain('Assigned profiles');
    expect(container.textContent).toContain('None');
    await reauthorize();
    await act(async () => button('Verify and connect Jira').click());
    expect(connections.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: [] }),
    );
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
  it('clears create credentials before rejecting an expired reauthorization', async () => {
    vi.mocked(connections.reauthorize).mockResolvedValue({
      csrf: 'c'.repeat(32),
      expiresAt: Date.now() - 1,
    });
    await render();
    await chooseJiraToAssignments();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await continueWizard();
    await reauthorize();
    await act(async () => button('Verify and connect Jira').click());
    expect(connections.createConnection).not.toHaveBeenCalled();
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    await act(async () => button('Back').click());
    expect(input('API token').value).toBe('');
  });
  it('shows unsupported templates as forthcoming and prevents them entering the wizard', async () => {
    await render();
    expect(container.textContent).toContain('Forthcoming: this gateway does not yet support');
    expect(button('Coming soon').disabled).toBe(true);
    expect(container.textContent).not.toContain('Authenticate with GitHub');
  });
  it('keeps template versions distinct in selection and connection-card metadata', async () => {
    await render();
    await act(async () => button('Choose Jira v2').click());
    act(() => fireEvent.change(input('API token'), { target: { value: 'v2-secret' } }));
    await continueWizard();
    act(() =>
      fireEvent.change(input('Atlassian account email'), { target: { value: 'me@example.com' } }),
    );
    await continueWizard();
    await continueWizard();
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    await continueWizard();
    await reauthorize();
    await act(async () => button('Verify and connect Jira v2').click());
    expect(connections.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'jira-readonly', templateVersion: 2 }),
    );
    vi.mocked(connections.getConnections).mockResolvedValue({
      ...catalog,
      connections: [{ ...catalog.connections[0], templateVersion: 2 }],
    });
    await act(async () => button('Test identity').click());
    expect(container.textContent).toContain('Jira v2 v2');
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
  it('submits active rotations with generic credential maps and clears secrets on failure', async () => {
    vi.mocked(connections.rotateConnection).mockRejectedValue(new Error('Rotation failed'));
    await render();
    await reauthorize();
    await act(async () => button('Rotate credentials').click());
    act(() =>
      fireEvent.change(input('Replacement API token'), { target: { value: 'rotate-secret' } }),
    );
    await act(async () => button('Verify and rotate').click());
    expect(connections.rotateConnection).toHaveBeenCalledWith({
      id: 'jira-1',
      revision: 2,
      credentials: { token: 'rotate-secret' },
      csrf: 'c'.repeat(32),
    });
    expect(container.textContent).toContain('Rotation failed');
    expect(container.textContent).not.toContain('rotate-secret');
  });
  it('clears rotation credentials before rejecting expired reauthorization', async () => {
    vi.mocked(connections.reauthorize).mockResolvedValue({
      csrf: 'c'.repeat(32),
      expiresAt: Date.now() - 1,
    });
    await render();
    await reauthorize();
    await act(async () => button('Rotate credentials').click());
    act(() =>
      fireEvent.change(input('Replacement API token'), { target: { value: 'rotate-secret' } }),
    );
    await act(async () => button('Verify and rotate').click());
    expect(input('Replacement API token').value).toBe('');
    expect(connections.rotateConnection).not.toHaveBeenCalled();
  });
  it('keeps retry and removal behind the existing Jira lifecycle safeguards', async () => {
    vi.mocked(connections.getConnections).mockResolvedValue({
      ...catalog,
      connections: [
        { ...catalog.connections[0], status: 'needs_attention', errorCode: 'PROVISION_FAILED' },
      ],
    });
    await render();
    vi.mocked(connections.getConnectionTemplates).mockRejectedValue(
      new Error('Template catalog unavailable'),
    );
    await reauthorize();
    await act(async () => button('Test identity').click());
    expect(container.textContent).toContain('Connection setup is temporarily unavailable');
    await act(async () => button('Retry credentials').click());
    act(() =>
      fireEvent.change(input('Replacement API token'), { target: { value: 'retry-secret' } }),
    );
    await act(async () => button('Verify and rotate').click());
    expect(connections.retryConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira-1', credentials: { token: 'retry-secret' } }),
    );
    await act(async () => button('Remove connection').click());
    expect(connections.deleteConnection).not.toHaveBeenCalled();
    await act(async () => button('Confirm removal').click());
    expect(connections.deleteConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'jira-1', revision: 2 }),
    );
  });
  it('does not send a removal request after reauthorization expires', async () => {
    vi.mocked(connections.reauthorize).mockResolvedValue({
      csrf: 'c'.repeat(32),
      expiresAt: Date.now() - 1,
    });
    await render();
    await reauthorize();
    await act(async () => button('Remove connection').click());
    await act(async () => button('Confirm removal').click());
    expect(connections.deleteConnection).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Reauthorize with your passphrase');
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
