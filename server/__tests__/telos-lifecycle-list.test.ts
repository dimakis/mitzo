import { afterEach, expect, it, vi } from 'vitest';
import { TodoListResponse } from '../api-schemas.js';
import { projectCanonicalTelosLifecycleList } from '../telos-lifecycle-list.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { revokeAuthSession } from '../auth.js';

// This composition test exercises actual interactive revocation, not host token
// authentication. Keep auth.ts's unrelated credential import entirely offline.
vi.mock('../internal-token.js', () => ({
  INTERNAL_TOKEN: '0'.repeat(64),
  isValidInternalToken: () => false,
  isValidSignalCallbackToken: () => false,
}));

const closes: Array<() => void> = [];
afterEach(() => {
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close());
  vi.unstubAllEnvs();
});
function fixture() {
  const f = createTelosCanonicalData();
  closes.push(() => f.close());
  f.db
    .prepare(
      "INSERT INTO items(id,parent_id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES('child','studio','Child','manual',?,?,?,?)",
    )
    .run(f.stamp, f.stamp, f.stamp, f.stamp);
  const child = {
    id: 'child',
    parentId: 'studio',
    summary: 'Child',
    profile: 'manual',
    urgency: 0.5,
    contextHints: {},
    status: 'active',
    children: [],
    childCount: 0,
    completedChildCount: 0,
    priority: 7,
    ageDays: 12,
    sources: [],
  };
  const canonical = TodoListResponse.parse({
    profiles: ['manual'],
    items: [
      {
        ...child,
        id: 'studio',
        parentId: null,
        summary: 'Home studio',
        children: [child],
        childCount: 1,
      },
    ],
  });
  const operator = { id: `lifecycle-list-${Math.random()}`, expiresAt: Date.now() + 60000 };
  const policy = { ordinaryConversation: () => false };
  const archive = (id: string) =>
    f.work.executeLifecycle(
      {
        requestId: `archive-${id}`,
        itemId: id,
        expectedRevision: f.work.read(id, f.actor).revision,
        operation: 'archive',
      },
      f.actor,
    );
  const project = (view: unknown = 'active', auth: typeof operator | undefined = undefined) =>
    projectCanonicalTelosLifecycleList({
      canonical,
      databasePath: f.dbPath,
      view,
      operator: auth,
      policy,
    });
  return { f, canonical, operator, policy, archive, project };
}

it('preserves the already-authenticated internal active list while pruning hidden descendants without changing canonical fields', () => {
  const f = fixture();
  expect(f.project()).toEqual(f.canonical);
  const before = JSON.stringify(f.canonical);
  f.archive('child');
  const result = f.project() as { items: Array<{ children: unknown[]; childCount: number }> };
  expect(result.items[0].children).toEqual([]);
  expect(result.items[0].childCount).toBe(0);
  expect(JSON.stringify(f.canonical)).toBe(before);
});

it('uses current interactive authority for archive presentation and retains original canonical parent and sorting data', () => {
  const f = fixture();
  f.archive('child');
  const result = f.project('archive', f.operator) as { items: Array<Record<string, unknown>> };
  expect(result.items[0]).toMatchObject({
    id: 'child',
    parentId: 'studio',
    priority: 7,
    ageDays: 12,
    summary: 'Child',
  });
  expect(f.project('trash', f.operator).items).toEqual([]);
  expect(f.f.work.read('child', f.f.actor).parentId).toBe('studio');
});

it.each(['archive', 'trash'])(
  'denies internal-only %s reads before opening any database',
  (view) => {
    const f = fixture();
    expect(() =>
      projectCanonicalTelosLifecycleList({
        canonical: f.canonical,
        databasePath: '/does-not-exist/telos.db',
        view,
        operator: undefined,
        policy: f.policy,
      }),
    ).toThrow(/interactive operator/i);
  },
);

it('refuses expired and revoked interactive sessions before lifecycle reads', () => {
  const f = fixture();
  const expired = { ...f.operator, expiresAt: Date.now() - 1 };
  expect(() => f.project('active', expired)).toThrow(/current interactive/i);
  expect(() => f.project('archive', expired)).toThrow(/current interactive/i);
  revokeAuthSession(f.operator);
  expect(() => f.project('archive', f.operator)).toThrow(/current interactive/i);
});

it('reads the captured selected database rather than a later environment path', () => {
  const selected = fixture();
  const other = fixture();
  other.archive('studio');
  vi.stubEnv('TELOS_DB_PATH', other.f.dbPath);
  expect(selected.project()).toEqual(selected.canonical);
  expect(other.project().items).toEqual([]);
});

it('refuses unknown views instead of silently displaying active records', () => {
  const f = fixture();
  expect(() => f.project('everything', f.operator)).toThrow(/lifecycle view/i);
  expect(() => f.project(['active'], f.operator)).toThrow(/lifecycle view/i);
});
