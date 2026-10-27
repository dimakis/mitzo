import { expect, it } from 'vitest';
import { selectUnitShard, nativeConsumerOwners } from '../ci-unit-shards.mjs';

const files = [
  ...Object.keys(nativeConsumerOwners).map((file) => '/checkout/' + file),
  ...Array.from({ length: 100 }, (_, i) => `/checkout/server/__tests__/ordinary-${i}.test.ts`),
];
it('distributes the expensive consumer family while covering every selected file once', () => {
  const shards = [1, 2, 3, 4].map((index) => selectUnitShard(files, '/checkout', index, 4));
  expect(shards.flat().sort()).toEqual([...files].sort());
  expect(new Set(shards.flat()).size).toBe(files.length);
  for (const [file, owner] of Object.entries(nativeConsumerOwners))
    expect(shards[Number(owner) - 1]).toContain('/checkout/' + file);
  expect(
    shards.map(
      (shard) =>
        shard.filter((file) => Object.hasOwn(nativeConsumerOwners, file.slice('/checkout/'.length)))
          .length,
    ),
  ).toEqual([2, 2, 2, 2]);
});
it('preserves complete discovery for focused selections, other shard counts and moved checkout roots', () => {
  for (const count of [1, 2, 3, 4, 5]) {
    for (const selected of [files, files.slice(0, 3), files.slice(3, 9)]) {
      const actual = Array.from({ length: count }, (_, i) =>
        selectUnitShard(selected, '/checkout', i + 1, count),
      ).flat();
      expect(actual.sort()).toEqual([...selected].sort());
      expect(
        Array.from({ length: count }, (_, i) =>
          selectUnitShard(
            selected.map((file) => file.replace('/checkout/', '/other/')),
            '/other',
            i + 1,
            count,
          ),
        )
          .flat()
          .map((file) => file.replace('/other/', '/checkout/'))
          .sort(),
      ).toEqual([...selected].sort());
    }
  }
});
it('rejects invalid shard requests rather than omitting coverage silently', () => {
  for (const [index, count] of [
    [0, 4],
    [5, 4],
    [1, 0],
    [1.5, 4],
  ])
    expect(() => selectUnitShard(files, '/checkout', index, count)).toThrow();
});
