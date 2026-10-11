import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionRuntimeBindingSchema,
  SessionRuntimeBindingV1Schema,
  SessionRuntimeBindingV2Schema,
} from '../src/index.js';
import { EventStore } from '../src/event-store.js';

const v1 = {
  version: 1,
  account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile-1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local' },
} as const;
const v2 = {
  ...v1,
  version: 2,
  execution: { location: 'local', targetId: 'host-main', targetRevision: 'target-r1' },
} as const;
const meta = {
  sessionId: 'target-bound-session',
  accountBinding: { ...v1.account, accountLabel: 'Personal', model: 'offline-fixture' },
  repositoryWorkspaceId: 'workspace-1',
  cwd: '/isolated/task',
  summary: 'Initial',
};

describe('versioned dormant target binding schema', () => {
  it('reads V1 without inferring a target and V2 with the complete target identity', () => {
    expect(SessionRuntimeBindingSchema.parse(v1)).toEqual(v1);
    expect(SessionRuntimeBindingSchema.parse(v2)).toEqual(v2);
    expect(SessionRuntimeBindingV2Schema.parse(v2)).toEqual(v2);
    expect(SessionRuntimeBindingV1Schema.safeParse({ ...v2, version: 1 }).success).toBe(false);
  });

  it.each([
    ['codex', 'openai-codex'],
    ['codex', 'openai'],
    ['claude-sdk', 'anthropic-vertex'],
    ['responses', 'openai'],
    ['gemini', 'google-vertex'],
  ])('preserves descriptive %s/%s constraints in both locations', (implementation, provider) => {
    for (const location of ['local', 'openshell']) {
      expect(
        SessionRuntimeBindingSchema.safeParse({
          ...v2,
          account: { ...v2.account, provider },
          harness: { implementation },
          execution: { ...v2.execution, location },
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    { ...v2, version: 3 },
    { ...v2, harness: { implementation: 'claude-sdk' } },
    { ...v2, execution: { location: 'local' } },
    { ...v2, execution: { ...v2.execution, targetId: undefined } },
    { ...v2, execution: { ...v2.execution, targetId: '' } },
    { ...v2, execution: { ...v2.execution, targetId: ' spaced ' } },
    { ...v2, execution: { ...v2.execution, targetRevision: undefined } },
    { ...v2, execution: { ...v2.execution, targetRevision: '' } },
    { ...v2, execution: { ...v2.execution, targetRevision: 'two words' } },
    { ...v2, execution: { ...v2.execution, targetRevision: 'x'.repeat(201) } },
    { ...v2, execution: { ...v2.execution, gatewayEndpoint: 'https://fixture.invalid' } },
    { ...v2, account: { ...v2.account, credentialRef: 'fixture-secret' } },
    { ...v2, execution: { ...v2.execution, authorized: true } },
  ])('rejects incomplete, incompatible or authority-bearing values: %j', (input) => {
    expect(SessionRuntimeBindingSchema.safeParse(input).success).toBe(false);
  });
});

describe('durable configured target identity', () => {
  let directory: string;
  let file: string;
  let store: EventStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mitzo-target-binding-'));
    file = join(directory, 'events.db');
    store = new EventStore(file);
  });
  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retains exact target metadata across unrelated settings updates and cold reopen', () => {
    store.createSessionWithRuntimeBinding(meta, v2);
    store.upsertSession({
      sessionId: meta.sessionId,
      selectedModel: 'changed-fixture',
      summary: 'Updated',
    });
    store.close();
    store = new EventStore(file);
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(v2);
    expect(store.getSession(meta.sessionId)?.summary).toBe('Updated');
  });

  it('accepts a second-store exact retry as a read, without changing other metadata', () => {
    store.createSessionWithRuntimeBinding(meta, v2);
    const before = store.getSession(meta.sessionId);
    const second = new EventStore(file);
    try {
      second.createSessionWithRuntimeBinding({ ...meta, summary: 'Ignored retry' }, v2);
      expect(second.getSession(meta.sessionId)).toEqual(before);
      expect(second.getSessionRuntimeBinding(meta.sessionId)).toEqual(v2);
    } finally {
      second.close();
    }
  });

  it.each([
    { ...v2, execution: { ...v2.execution, targetId: 'other-host' } },
    { ...v2, execution: { ...v2.execution, targetRevision: 'target-r2' } },
    v1,
  ])('rejects target or version replacement from another store: %j', (replacement) => {
    store.createSessionWithRuntimeBinding(meta, v2);
    const before = store.getSession(meta.sessionId);
    const second = new EventStore(file);
    try {
      expect(() =>
        second.createSessionWithRuntimeBinding({ ...meta, summary: 'Must not apply' }, replacement),
      ).toThrow();
      expect(second.getSession(meta.sessionId)).toEqual(before);
      expect(second.getSessionRuntimeBinding(meta.sessionId)).toEqual(v2);
    } finally {
      second.close();
    }
  });

  it('never upgrades a V1 record by reading or retrying creation with V2', () => {
    store.createSessionWithRuntimeBinding(meta, v1);
    const before = store.getSession(meta.sessionId);
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(v1);
    expect(() => store.createSessionWithRuntimeBinding(meta, v2)).toThrow();
    expect(store.getSession(meta.sessionId)).toEqual(before);
    expect(store.getSessionRuntimeBinding(meta.sessionId)).toEqual(v1);
  });

  it('rolls back allocation if writing the target binding fails after row creation', () => {
    const db = new Database(file);
    db.exec(`CREATE TRIGGER reject_target_binding BEFORE UPDATE OF runtime_binding ON sessions
      BEGIN SELECT RAISE(ABORT, 'injected binding write failure'); END`);
    try {
      expect(() => store.createSessionWithRuntimeBinding(meta, v2)).toThrow(/injected/);
      expect(store.getSession(meta.sessionId)).toBeNull();
      expect(store.getSessionRuntimeBinding(meta.sessionId)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([
    { ...v2, execution: { location: 'local', targetId: 'host-main' } },
    { ...v2, version: 3 },
    { ...v2, account: { ...v2.account, accountId: 'other-account' } },
  ])('refuses corrupt V2 reads and upserts without applying unrelated changes: %j', (corrupt) => {
    store.createSessionWithRuntimeBinding(meta, v2);
    const db = new Database(file);
    db.prepare('UPDATE sessions SET runtime_binding=? WHERE session_id=?').run(
      JSON.stringify(corrupt),
      meta.sessionId,
    );
    try {
      expect(() => store.getSessionRuntimeBinding(meta.sessionId)).toThrow();
      expect(() => store.createSessionWithRuntimeBinding(meta, v2)).toThrow();
      expect(() =>
        store.upsertSession({ sessionId: meta.sessionId, summary: 'Must not apply' }),
      ).toThrow();
      expect(
        db.prepare('SELECT summary FROM sessions WHERE session_id=?').get(meta.sessionId),
      ).toEqual({ summary: 'Initial' });
    } finally {
      db.close();
    }
  });
});
