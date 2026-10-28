import { createHash } from 'node:crypto';
import { relative } from 'node:path';

// Retained Linux timings: about six minutes of consumer work per shard.
// Ordinary tests keep Vitest's path-hash partition; no file is excluded.
export const nativeConsumerOwners = Object.freeze({
  'server/__tests__/prepared-repository-native-cold-resume.test.ts': 1,
  'server/__tests__/prepared-repository-native-public-completed.test.ts': 1,
  'server/__tests__/prepared-repository-native-recovery.test.ts': 2,
  'server/__tests__/prepared-repository-native-consumer.test.ts': 2,
  'server/__tests__/prepared-repository-native-public-interrupted.test.ts': 3,
  'server/__tests__/prepared-repository-native-public-untransferred.test.ts': 3,
  'server/__tests__/prepared-repository-native-public-partial-adoption.test.ts': 4,
  'server/__tests__/prepared-repository-native-public-retained-http.test.ts': 4,
});
export function selectUnitShard(files, root, index, count) {
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    index < 1 ||
    index > count
  )
    throw Error('Invalid unit shard');
  const path = (file) => relative(root, file).replaceAll('\\', '/');
  const owner = (file) => (count === 4 ? nativeConsumerOwners[path(file)] : undefined);
  const ordinary = files
    .filter((file) => !owner(file))
    .map((file) => ({
      file,
      hash: createHash('sha1')
        .update('/' + path(file))
        .digest('hex'),
    }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const size = Math.floor(ordinary.length / count),
    remainder = ordinary.length % count;
  const start = (index - 1) * size + Math.min(index - 1, remainder);
  return [
    ...ordinary
      .slice(start, start + size + (index <= remainder ? 1 : 0))
      .map((entry) => entry.file),
    ...files.filter((file) => owner(file) === index),
  ];
}
