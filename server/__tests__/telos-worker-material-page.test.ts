import { afterEach, expect, it, vi } from 'vitest';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});

it('filters the union before its single ordered page and never hydrates material bytes', () => {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const worker = Array.from({ length: 104 }, (_, i) =>
    f.artifacts.save({
      itemId: 'studio',
      filename: `worker-${i}.md`,
      title: `Output ${i}`,
      bytes: Buffer.from(`Output ${i}`),
      sessionId: 'worker',
    }),
  );
  const excluded = f.artifacts.save({
    itemId: 'studio',
    filename: 'unselected.md',
    title: 'Unselected',
    bytes: Buffer.from('not selected'),
    sessionId: 'worker',
  });
  const pins = worker.map((a) => ({ artifactId: a.id, revision: a.revision, sha256: a.sha256 }));
  const read = vi.spyOn(f.artifacts, 'read');
  const first = f.artifacts.sourceMaterialPage('planning', undefined, [...pins, pins[0]]);
  expect(first.artifacts).toHaveLength(100);
  expect(first.hasMore).toBe(true);
  const next = f.artifacts.sourceMaterialPage('planning', first.cursor!, pins);
  expect(next.artifacts).toHaveLength(5);
  expect(next.hasMore).toBe(false);
  const all = [...first.artifacts, ...next.artifacts];
  expect(new Set(all.map((a) => `${a.id}@${a.revision}`)).size).toBe(105);
  expect(all.some((a) => a.id === excluded.id)).toBe(false);
  expect(all.map((a) => [a.createdAt, a.id, a.revision])).toEqual(
    all
      .map((a) => [a.createdAt, a.id, a.revision])
      .sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) ||
          String(a[1]).localeCompare(String(b[1])) ||
          Number(a[2]) - Number(b[2]),
      ),
  );
  expect(read).not.toHaveBeenCalled();
});
