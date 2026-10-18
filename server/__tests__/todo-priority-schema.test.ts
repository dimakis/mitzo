import { expect, it } from 'vitest';
import { TodoListResponse } from '../api-schemas.js';

it('preserves explicit values and maps legacy stars consistently, including nested items', () => {
  const item = {
    id: 'legacy',
    summary: 'Legacy',
    profile: 'work',
    urgency: 0.5,
    status: 'active',
    ageDays: 0,
    sources: [],
    contextHints: {},
  };
  const parsed = TodoListResponse.parse({
    profiles: ['work'],
    items: [
      { ...item, starred: true, children: [{ ...item, id: 'child', priority: 2 }] },
      { ...item, id: 'plain' },
    ],
  }) as { items: Array<{ priority: number; children: Array<{ priority: number }> }> };
  expect(parsed.items[0].priority).toBe(10);
  expect(parsed.items[0].children[0].priority).toBe(2);
  expect(parsed.items[1].priority).toBe(5);
  for (const priority of [0, 11, 7.5, true, '7', null])
    expect(
      TodoListResponse.safeParse({ profiles: [], items: [{ ...item, priority }] }).success,
    ).toBe(false);
});
