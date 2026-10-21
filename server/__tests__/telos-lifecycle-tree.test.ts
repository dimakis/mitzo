import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TodoListResponse } from '../api-schemas.js';
import { projectTelosLifecycleTree } from '../telos-lifecycle-tree.js';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosWorkStore } from '../telos-work-store.js';

const closes: Array<() => void> = [];
afterEach(() =>
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const f = createTelosCanonicalData();
  closes.push(() => f.close());
  for (const [id, parent] of [
    ['child', 'studio'],
    ['grandchild', 'child'],
    ['sibling', 'studio'],
  ]) {
    f.db
      .prepare(
        "INSERT INTO items(id,parent_id,summary,profile,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,'manual',?,?,?,?)",
      )
      .run(id, parent, id, f.stamp, f.stamp, f.stamp, f.stamp);
  }
  const item = (id: string, parentId: string | null, children: unknown[] = []) => ({
    id,
    parentId,
    summary: id,
    profile: 'manual',
    urgency: 0.5,
    priority: 8,
    status: 'active',
    ageDays: 17,
    sources: [],
    contextHints: {},
    children,
    childCount: children.length,
    completedChildCount: 0,
  });
  const canonical = TodoListResponse.parse({
    profiles: ['manual'],
    items: [
      item('studio', null, [
        item('child', 'studio', [item('grandchild', 'child')]),
        item('sibling', 'studio'),
      ]),
    ],
  });
  const mutate = (itemId: string, operation: string) =>
    f.work.executeLifecycle(
      {
        requestId: randomUUID(),
        itemId,
        operation,
        expectedRevision: f.work.read(itemId, f.actor).revision,
      },
      f.actor,
    );
  const project = (view: 'active' | 'archive' | 'trash' = 'active') =>
    projectTelosLifecycleTree(canonical, f.work.listLifecycle(view, f.actor), view);
  return { f, canonical, mutate, project };
}

it('uses actual canonical parser output and same-owner lifecycle without changing the normal active tree or sorting fields', () => {
  const f = fixture();
  expect(f.project()).toEqual(f.canonical);
  expect(f.project('archive').items).toEqual([]);
  expect(f.project('trash').items).toEqual([]);
});

it('hides archived subtrees from active and promotes archive presentation roots without changing canonical parentId or inputs', () => {
  const f = fixture();
  const original = JSON.stringify(f.canonical);
  f.mutate('child', 'archive');
  const active = f.project() as {
    items: Array<{ id: string; children: Array<{ id: string }>; childCount: number }>;
  };
  expect(active.items[0].children.map((c) => c.id)).toEqual(['sibling']);
  expect(active.items[0].childCount).toBe(1);
  const archive = f.project('archive') as {
    items: Array<{
      id: string;
      parentId: string;
      ageDays: number;
      priority: number;
      children: Array<{ id: string; parentId: string }>;
    }>;
  };
  expect(archive.items[0]).toMatchObject({
    id: 'child',
    parentId: 'studio',
    priority: 8,
    ageDays: 17,
  });
  expect(archive.items[0].children[0]).toMatchObject({ id: 'grandchild', parentId: 'child' });
  expect(JSON.stringify(f.canonical)).toBe(original);
  expect(f.f.work.read('child', f.f.actor).parentId).toBe('studio');
});

it('keeps nested trash separate from archive and restores it to inherited archive visibility', () => {
  const f = fixture();
  f.mutate('studio', 'archive');
  f.mutate('child', 'trash');
  const archive = f.project('archive') as {
    items: Array<{ id: string; children: Array<{ id: string }> }>;
  };
  expect(archive.items[0].children.map((c) => c.id)).toEqual(['sibling']);
  const trash = f.project('trash') as {
    items: Array<{ id: string; parentId: string; children: Array<{ id: string }> }>;
  };
  expect(trash.items[0]).toMatchObject({ id: 'child', parentId: 'studio' });
  expect(trash.items[0].children[0].id).toBe('grandchild');
  f.mutate('child', 'restore');
  expect(f.project('trash').items).toEqual([]);
  expect((f.project('archive').items[0] as { children: unknown[] }).children).toHaveLength(2);
});

it('omits rows missing from current lifecycle authority, rejects duplicate identities and never invents fallback active state', () => {
  const f = fixture();
  expect(projectTelosLifecycleTree(f.canonical, []).items).toEqual([]);
  const rows = f.f.work.listLifecycle('active', f.f.actor);
  expect(() => projectTelosLifecycleTree(f.canonical, [...rows, rows[0]])).toThrow(/duplicate/i);
  const duplicate = { ...f.canonical, items: [...f.canonical.items, ...f.canonical.items] };
  expect(() => projectTelosLifecycleTree(duplicate, rows)).toThrow(/duplicate/i);
});

it('projects an already-authenticated canonical list through read-only visibility without fabricating an operator or revealing history', () => {
  const f = fixture();
  f.mutate('child', 'trash');
  const reader = TelosWorkStore.openReadOnly(f.f.dbPath, {
    ordinaryConversation: () => {
      throw new Error('Visibility cannot consult conversation authority');
    },
  });
  closes.push(() => reader.close());
  const visibility = reader.lifecycleVisibilityForCanonicalList([
    'studio',
    'child',
    'grandchild',
    'sibling',
    'disappeared',
  ]);
  expect(visibility).toEqual([
    { itemId: 'studio', effectiveDisposition: 'active' },
    { itemId: 'child', effectiveDisposition: 'trashed' },
    { itemId: 'grandchild', effectiveDisposition: 'trashed' },
    { itemId: 'sibling', effectiveDisposition: 'active' },
  ]);
  expect(
    visibility.every((row) => Object.keys(row).sort().join(',') === 'effectiveDisposition,itemId'),
  ).toBe(true);
  const projected = projectTelosLifecycleTree(f.canonical, visibility) as {
    items: Array<{ children: Array<{ id: string }> }>;
  };
  expect(projected.items[0].children.map((row) => row.id)).toEqual(['sibling']);
  // Full lifecycle/history and mutations retain their original operator gate.
  expect(() => reader.listLifecycle('trash', { kind: 'conversation', id: 'planning' })).toThrow(
    /operator/i,
  );
});

it('bounds canonical-list visibility to the supplied identities and refuses duplicate or oversized selections', () => {
  const f = fixture();
  expect(f.f.work.lifecycleVisibilityForCanonicalList([])).toEqual([]);
  expect(f.f.work.lifecycleVisibilityForCanonicalList(['child'])).toEqual([
    { itemId: 'child', effectiveDisposition: 'active' },
  ]);
  expect(() => f.f.work.lifecycleVisibilityForCanonicalList(['child', 'child'])).toThrow(
    /duplicate/i,
  );
  expect(() =>
    f.f.work.lifecycleVisibilityForCanonicalList(
      Array.from({ length: 5001 }, (_, i) => `item-${i}`),
    ),
  ).toThrow();
});
