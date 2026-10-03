import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SymposiumConfigurationOperationReceiptSchema } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'symposium-config-receipts-'));
});
const stores: EventStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  rmSync(directory, { recursive: true, force: true });
});
const config = {
  version: 2 as const,
  revision: 1,
  state: 'draft' as const,
  anchorSeatId: 'anchor',
  activeSeatCap: 3,
  seats: [
    {
      id: 'anchor',
      name: 'Anchor',
      role: 'agent',
      model: 'luna',
      systemPrompt: '',
      color: '#335577',
    },
  ],
  turnRules: { mode: 'directed' as const, maxTurns: 8 },
  interceptMode: 'manual' as const,
};
const operation = {
  version: 1 as const,
  actor: 'operator:original',
  action: 'draft' as const,
  idempotencyKey: 'original-draft',
  expectedRevision: 0,
  request: {
    expectedRevision: 0,
    idempotencyKey: 'original-draft',
    expectedAccountId: 'approved-account',
  },
};
it('atomically retains an exact original configuration receipt across reopen and rejects changed-key payloads', () => {
  const path = join(directory, 'persist.db');
  const store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'session' });
  store.setSymposiumConfig('session', config, 0, operation);
  const receipt = store.getSymposiumConfigurationOperation('session', operation.idempotencyKey);
  expect(receipt).toMatchObject({ ...operation, sessionId: 'session', config });
  const reopened = new EventStore(path);
  stores.push(reopened);
  expect(reopened.getSymposiumConfigurationOperation('session', operation.idempotencyKey)).toEqual(
    receipt,
  );
  expect(
    reopened.getSymposiumConfigurationOperation('other', operation.idempotencyKey),
  ).toBeUndefined();
  expect(() =>
    reopened.setSymposiumConfig('session', config, 0, {
      ...operation,
      request: { ...operation.request, expectedAccountId: 'different' },
    }),
  ).toThrow(/conflict/i);
  expect(() =>
    reopened.setSymposiumConfig('session', config, 0, { ...operation, expectedRevision: 1 }),
  ).toThrow();
  expect(reopened.getSession('session')?.symposiumRevision).toBe(1);
});
it('rolls back the configuration CAS when receipt persistence fails', () => {
  const path = join(directory, 'failure.db');
  const store = new EventStore(path);
  stores.push(store);
  store.upsertSession({ sessionId: 'session' });
  const db = new Database(path);
  db.exec(
    "CREATE TRIGGER refuse_receipt BEFORE INSERT ON symposium_configuration_operations BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END",
  );
  db.close();
  expect(() => store.setSymposiumConfig('session', config, 0, operation)).toThrow();
  expect(store.getSession('session')?.symposiumConfig).toBeNull();
  expect(store.getSession('session')?.symposiumRevision).toBe(0);
  expect(
    store.getSymposiumConfigurationOperation('session', operation.idempotencyKey),
  ).toBeUndefined();
});

it('rejects a revise receipt that reports a draft rather than the required active result', () => {
  expect(
    SymposiumConfigurationOperationReceiptSchema.safeParse({
      ...operation,
      action: 'seats/revise',
      request: { ...operation.request, seatId: 'anchor' },
      sessionId: 'session',
      config,
      completedAt: 1,
    }).success,
  ).toBe(false);
});
