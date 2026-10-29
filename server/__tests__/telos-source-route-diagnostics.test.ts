import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { TelosWorkError } from '../telos-work-store.js';
import { TelosSourceSaveUncertainError } from '../telos-source-approval.js';
import { listenOnLoopback, closeTestServer } from './loopback-test-server.js';

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({
  createLogger: (module: string) => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: module === 'telos-source' ? logs.warn : vi.fn(),
  }),
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  logs.warn.mockReset();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = createTelosCanonicalData('fresh');
  cleanups.push(() => f.close());
  const app = express();
  app.use(express.json());
  app.use(
    createTelosSourceRouter({
      dbPath: () => f.dbPath,
      events: f.events,
      ordinaryConversation: (id) => id === 'planning',
      operatorAuth: (_req, res, next) => {
        res.locals.authSession = { id: 'diagnostic-operator', expiresAt: Date.now() + 60_000 };
        next();
      },
    }),
  );
  const server = await listenOnLoopback(app);
  cleanups.push(() => closeTestServer(server));
  return {
    ...f,
    read: () => request(server).get('/api/telos/work/items/studio/sources/retained-snapshot'),
  };
}
const unavailable = { code: 'unavailable', error: 'Reviewed source service unavailable' };
function failure(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw Error('Fixture must produce a real failure');
}
function sqliteFailure(closed = false) {
  const db = new Database(':memory:');
  try {
    if (closed) db.close();
    return failure(() => db.prepare('SELECT private_sql_text FROM missing_private_table').get());
  } finally {
    if (db.open) db.close();
  }
}

it('retains SQLite failure stage and safe code without exposing the failed read or changing its response', async () => {
  const f = await fixture();
  f.db.exec('ALTER TABLE items RENAME TO temporarily_unavailable_items');
  try {
    const response = await f.read();
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('Reviewed source operation failed', {
      phase: 'open_work',
      reason: 'sqlite_unavailable',
      errorKind: 'sqlite',
      errorCode: 'SQLITE_ERROR',
    });
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('items');
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(f.dbPath);
  } finally {
    f.db.exec('ALTER TABLE temporarily_unavailable_items RENAME TO items');
  }
});

it.each([
  [
    'SQLite',
    () => sqliteFailure(),
    { reason: 'sqlite_unavailable', errorKind: 'sqlite', errorCode: 'SQLITE_ERROR' },
  ],
  ['closed database', () => sqliteFailure(true), { reason: 'database_closed', errorKind: 'type' }],
  [
    'JSON',
    () => failure(() => JSON.parse('{PRIVATE_JSON')),
    { reason: 'invalid_json', errorKind: 'syntax' },
  ],
  [
    'schema',
    () =>
      failure(() =>
        z.strictObject({ required: z.string() }).parse({ PRIVATE_FIELD: 'PRIVATE_VALUE' }),
      ),
    { reason: 'invalid_schema', errorKind: 'validation' },
  ],
  [
    'unexpected',
    () =>
      Object.assign(Error('PRIVATE_MESSAGE /private/path token=PRIVATE_TOKEN'), {
        code: 'PRIVATE_CODE',
      }),
    { reason: 'unexpected', errorKind: 'error' },
  ],
] as const)(
  'classifies an actual %s action failure with only fixed safe fields',
  async (_kind, create, expected) => {
    const f = await fixture();
    const original = create();
    const unchanged = Object.getOwnPropertyDescriptors(original);
    vi.spyOn(TelosSourceCapture.prototype, 'read').mockImplementationOnce(() => {
      throw original;
    });
    const response = await f.read();
    expect(response.status).toBe(503);
    expect(response.body).toEqual(unavailable);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('Reviewed source operation failed', {
      phase: 'action',
      ...expected,
    });
    expect(Object.getOwnPropertyDescriptors(original)).toEqual(unchanged);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toMatch(
      /PRIVATE|private_sql|missing_private|\/private\//,
    );
  },
);

it('ignores hostile diagnostic getters and preserves the original failure response', async () => {
  const f = await fixture();
  const original = Error('PRIVATE_MESSAGE');
  const getter = vi.fn(() => {
    throw Error('PRIVATE_GETTER');
  });
  Object.defineProperty(original, 'code', { get: getter });
  Object.defineProperty(original, 'cause', { get: getter });
  vi.spyOn(TelosSourceCapture.prototype, 'read').mockImplementationOnce(() => {
    throw original;
  });
  const response = await f.read();
  expect(response.status).toBe(503);
  expect(response.body).toEqual(unavailable);
  expect(getter).not.toHaveBeenCalled();
  expect(logs.warn).toHaveBeenCalledExactlyOnceWith('Reviewed source operation failed', {
    phase: 'action',
    reason: 'unexpected',
    errorKind: 'error',
  });
});

it.each([
  ['unauthorized', 403],
  ['not_found', 404],
  ['conflict', 409],
  ['invalid', 400],
] as const)(
  'preserves known %s responses without relaying them through unknown diagnostics',
  async (code, status) => {
    const f = await fixture();
    vi.spyOn(TelosSourceCapture.prototype, 'read').mockImplementationOnce(() => {
      throw new TelosWorkError(code, 'Original known condition');
    });
    const response = await f.read();
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, error: 'Original known condition' });
    expect(logs.warn).not.toHaveBeenCalled();
  },
);

it('keeps the source response intact when diagnostic logging itself fails', async () => {
  const f = await fixture();
  logs.warn.mockImplementationOnce(() => {
    throw Error('PRIVATE_LOG_FAILURE');
  });
  vi.spyOn(TelosSourceCapture.prototype, 'read').mockImplementationOnce(() => {
    throw sqliteFailure();
  });
  const response = await f.read();
  expect(response.status).toBe(503);
  expect(response.body).toEqual(unavailable);
});

it('preserves a save-uncertain response without relabeling its outcome', async () => {
  const f = await fixture();
  const original = new TelosSourceSaveUncertainError();
  vi.spyOn(TelosSourceCapture.prototype, 'read').mockImplementationOnce(() => {
    throw original;
  });
  const response = await f.read();
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ code: 'save_uncertain', error: original.message });
  expect(logs.warn).not.toHaveBeenCalled();
});
