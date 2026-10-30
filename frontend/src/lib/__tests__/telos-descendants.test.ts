import { expect, it } from 'vitest';
import { telosDescendants } from '../telos-descendants';

it('walks unordered descendants once and excludes unrelated records', () => {
  let reads = 0;
  const records = Array.from({ length: 2000 }, (_, index) => ({
    itemId: String(index),
    get parentId() {
      reads++;
      return index === 0 ? null : String(index - 1);
    },
  })).reverse();
  expect(telosDescendants(records, '0').size).toBe(2000);
  expect([
    ...telosDescendants([...records, { itemId: 'other', parentId: null }], '0'),
  ]).not.toContain('other');
  expect(reads).toBeLessThanOrEqual(4000);
});
it('terminates a corrupt cycle and supports a root omitted from the current read', () => {
  const records = [
    { itemId: 'child', parentId: 'root' },
    { itemId: 'root', parentId: 'child' },
  ];
  expect([...telosDescendants(records, 'root')]).toEqual(['root', 'child']);
  expect([...telosDescendants(records.slice(0, 1), 'root')]).toEqual(['root', 'child']);
});
