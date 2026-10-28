import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

it('executes the configured sequencer in real Vitest and retains every file exactly once', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-sequencer-')));
  const selected = [
    ...Object.keys(nativeConsumerOwners),
    ...Array.from({ length: 8 }, (_, i) => `ordinary-${i}.test.ts`),
  ];
  try {
    symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
    writeFileSync(
      join(root, 'vitest.config.mjs'),
      `import Sequencer from ${JSON.stringify(pathToFileURL(resolve('scripts/ci-unit-sequencer.ts')).href)};export default {test:{sequence:{sequencer:Sequencer}}};`,
    );
    for (const file of selected) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(
        join(root, file),
        "import {test,expect} from 'vitest';test('offline fixture',()=>expect(true).toBe(true));",
      );
    }
    const seen: string[] = [];
    for (let shard = 1; shard <= 4; shard++) {
      const report = join(root, `report-${shard}.json`);
      const result = spawnSync(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          'run',
          `--shard=${shard}/4`,
          '--maxWorkers=1',
          '--reporter=json',
          '--outputFile=' + report,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const files = JSON.parse(readFileSync(report, 'utf8')).testResults.map(
        (r: { name: string }) => r.name.slice(root.length + 1),
      );
      for (const [file, owner] of Object.entries(nativeConsumerOwners))
        expect(files.includes(file)).toBe(owner === shard);
      seen.push(...files);
    }
    expect(seen.sort()).toEqual(selected.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
