import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ConnectionStore, RevisionConflictError } from '../connections-store.js';

describe('ConnectionStore', () => {
  let directory: string;
  let store: ConnectionStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mitzo-connections-'));
    store = new ConnectionStore(join(directory, 'connections.db'));
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function create() {
    return store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Work Jira',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-a',
      desiredAccountIds: ['codex-work'],
      submittedEmail: 'submitted@example.com',
      gateway: 'openshell-a',
      workspace: 'work',
    });
  }

  it('persists only non-secret metadata and durable provisioning intent', () => {
    const connection = create();
    expect(connection.status).toBe('provisioning');
    expect(connection.revision).toBe(1);
    expect(connection.desiredAccountIds).toEqual(['codex-work']);
    expect(connection.submittedEmail).toBe('submitted@example.com');
    expect(connection.gateway).toBe('openshell-a');
    expect(store.audit(connection.id)[0]).toMatchObject({
      operation: 'provision',
      outcome: 'started',
    });
    expect(JSON.stringify(connection)).not.toMatch(/token|password|secret/i);
    expect(store.incomplete()).toEqual([connection]);
  });

  it('updates state and appends audit atomically with optimistic revisions', () => {
    const connection = create();
    const active = store.transition(
      connection.id,
      connection.revision,
      {
        status: 'active',
        gatewayProviderId: 'opaque-provider-id',
        identity: 'person@example.com',
        verifiedAt: 1000,
        errorCode: null,
      },
      { operation: 'activate', outcome: 'success', actor: 'operator' },
    );
    expect(active.revision).toBe(2);
    expect(store.audit(connection.id)).toContainEqual(
      expect.objectContaining({ operation: 'activate', outcome: 'success' }),
    );
    expect(() =>
      store.transition(
        connection.id,
        1,
        { status: 'revoking' },
        { operation: 'revoke', outcome: 'started', actor: 'operator' },
      ),
    ).toThrow(RevisionConflictError);
  });

  it('rejects duplicate active profile assignments and duplicate env bindings', () => {
    const first = create();
    store.transition(
      first.id,
      first.revision,
      { status: 'active' },
      { operation: 'activate', outcome: 'success', actor: 'operator' },
    );
    const second = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Other',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-b',
      desiredAccountIds: [],
    });
    expect(() =>
      store.setAssignments(second.id, second.revision, ['codex-work'], 'operator'),
    ).toThrow(/already assigned/i);
  });

  it('rejects activation of two independently provisioned Jira connections for one profile', () => {
    const first = create();
    const second = store.create({
      ownerId: 'operator',
      templateId: 'jira-readonly',
      templateVersion: 1,
      label: 'Duplicate',
      endpoint: 'https://redhat.atlassian.net',
      gatewayProviderName: 'mitzo-conn-c',
      desiredAccountIds: ['codex-work'],
    });
    store.transition(
      first.id,
      first.revision,
      { status: 'active' },
      { operation: 'activate', outcome: 'success', actor: 'operator' },
    );
    expect(() =>
      store.transition(
        second.id,
        second.revision,
        { status: 'active' },
        { operation: 'activate', outcome: 'success', actor: 'operator' },
      ),
    ).toThrow(/already assigned/i);
  });

  it('preserves revoking work across a restart', () => {
    const connection = create();
    store.transition(
      connection.id,
      1,
      { status: 'revoking', desiredAccountIds: [] },
      { operation: 'revoke', outcome: 'started', actor: 'operator' },
    );
    store.close();
    store = new ConnectionStore(join(directory, 'connections.db'));
    expect(store.incomplete().map((item) => item.status)).toEqual(['revoking']);
  });
});
