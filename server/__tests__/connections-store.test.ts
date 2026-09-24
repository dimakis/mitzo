import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  ConnectionStore,
  ConnectionAssignmentConflictError,
  RevisionConflictError,
} from '../connections-store.js';
import { connectionTemplateRegistry } from '../connections/registry.js';

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
    ).toThrow(ConnectionAssignmentConflictError);
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
    ).toThrow(ConnectionAssignmentConflictError);
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

  it('migrates legacy Jira email metadata into public config without changing effective policy', () => {
    store.close();
    const dbPath = join(directory, 'connections.db');
    const db = new Database(dbPath);
    db.exec('DROP TABLE connections');
    db.exec(`CREATE TABLE connections (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, template_id TEXT NOT NULL,
      template_version INTEGER NOT NULL, label TEXT NOT NULL, endpoint TEXT NOT NULL,
      gateway_provider_name TEXT NOT NULL UNIQUE, gateway_provider_id TEXT,
      gateway TEXT NOT NULL DEFAULT 'openshell', workspace TEXT NOT NULL DEFAULT 'default',
      submitted_email TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0), desired_account_ids TEXT NOT NULL,
      identity TEXT, verified_at INTEGER, error_code TEXT, archived_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const now = Date.now();
    db.prepare(
      'INSERT INTO connections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'legacy-jira',
      'operator',
      'jira-readonly',
      1,
      'Legacy Jira',
      'https://redhat.atlassian.net',
      'mitzo-conn-legacy',
      'provider-legacy',
      'openshell',
      'default',
      'submitted@example.com',
      'active',
      7,
      '["work"]',
      'account-legacy',
      now,
      null,
      null,
      now,
      now,
    );
    db.close();
    store = new ConnectionStore(dbPath);
    const legacy = store.get('legacy-jira')!;
    const expected = connectionTemplateRegistry.compileProviderPolicy({
      templateId: legacy.templateId,
      templateVersion: legacy.templateVersion,
      fields: { email: legacy.submittedEmail },
    });
    const migrated = store.get(legacy.id)!;
    expect(migrated.publicConfig).toEqual({ email: 'submitted@example.com' });
    expect(
      connectionTemplateRegistry.compileProviderPolicy({
        templateId: migrated.templateId,
        templateVersion: migrated.templateVersion,
        fields: migrated.publicConfig,
      }),
    ).toEqual(expected);
  });

  it.each(['"string"', 'true', '42', 'null', '[]'])(
    'rejects a non-object durable public config: %s',
    (publicConfig) => {
      const connection = create();
      const database = new Database(join(directory, 'connections.db'));
      database
        .prepare('UPDATE connections SET public_config=? WHERE id=?')
        .run(publicConfig, connection.id);
      database.close();
      expect(() => store.get(connection.id)).toThrow(
        'Stored connection public configuration is invalid',
      );
    },
  );

  it('archives only a revoked connection while retaining its audit record', () => {
    const connection = create();
    const revoked = store.transition(
      connection.id,
      connection.revision,
      { status: 'revoked', desiredAccountIds: [], errorCode: null },
      { operation: 'revoke', outcome: 'success', actor: 'operator' },
    );
    const archived = store.archive(revoked.id, revoked.revision, 'operator');
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(store.list('operator')).toEqual([]);
    expect(store.get(connection.id)?.archivedAt).toBe(archived.archivedAt);
    expect(store.audit(connection.id).at(-1)).toMatchObject({
      operation: 'archive',
      outcome: 'success',
    });
    expect(() => store.archive(connection.id, archived.revision, 'operator')).toThrow(
      /already archived/i,
    );
  });
});
