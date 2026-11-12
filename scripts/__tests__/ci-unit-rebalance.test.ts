import { expect, it } from 'vitest';
import { selectUnitShard } from '../ci-unit-shards.mjs';
import { preparedConsumerCases } from '../ci-prepared-consumers.mjs';

const moves = {
  'tests/integration/prepared-repository/composer-delivery.test.tsx': 1,
  'server/__tests__/prepared-repository-native-public-tool-rollover-queued.test.ts': 3,
  'server/__tests__/prepared-repository-native-public-tool-rollover.test.ts': 4,
};
it('pins measured heavy files without losing or duplicating any selected file', () => {
  const files = [
    ...Object.keys(moves),
    ...Array.from({ length: 2006 }, (_, i) => `ordinary-${i}.test.ts`),
  ];
  for (const root of ['/checkout', '/moved']) {
    const absolute = files.map((file) => `${root}/${file}`);
    const shards = [1, 2, 3, 4].map((index) => selectUnitShard(absolute, root, index, 4));
    expect(shards.flat().sort()).toEqual([...absolute].sort());
    for (const [file, owner] of Object.entries(moves))
      expect(shards[owner - 1]).toContain(`${root}/${file}`);
    expect(shards).toEqual(
      [1, 2, 3, 4].map((index) => selectUnitShard([...absolute].reverse(), root, index, 4)),
    );
  }
});
it('retains transferred-owner exclusions and complete unsharded local selection', () => {
  const files = [...Object.keys(moves), ...preparedConsumerCases.map((c) => c.file)].map(
    (f) => `/checkout/${f}`,
  );
  const transferred = new Set(preparedConsumerCases.map((c) => `/checkout/${c.file}`));
  const selected = [1, 2, 3, 4].flatMap((i) => selectUnitShard(files, '/checkout', i, 4, true));
  expect(selected.sort()).toEqual(files.filter((f) => !transferred.has(f)).sort());
  expect(selectUnitShard(files, '/checkout', 1, 1).sort()).toEqual([...files].sort());
});
