/** Fixed coverage partition, balanced from retained complete Mac timings.
 * The closed seventeen-case selection remains the only case/config authority.
 */
export const supplementalShards = Object.freeze({
  '1/2': Object.freeze([
    'chooser-hydration',
    'navigation-context',
    'coordinator-controls',
    'origin-material-versions',
    'legacy-backup-process',
    'advisor-refine',
    'advisor-material-refusal',
    'source-only-outcome',
  ]),
  '2/2': Object.freeze([
    'voice-image',
    'coordinator-refresh',
    'process-restart',
    'worker-process-restart',
    'task-review-process',
    'worker-replacement',
    'advisor-child',
    'advisor-material',
    'task-chat-tree-app',
  ]),
});
export function selectSupplementalShard(cases, shard) {
  const names = cases.map((selected) => selected.name);
  const partition = Object.values(supplementalShards).flat();
  if (
    names.length !== 17 ||
    new Set(names).size !== 17 ||
    partition.length !== 17 ||
    new Set(partition).size !== 17 ||
    JSON.stringify([...names].sort()) !== JSON.stringify([...partition].sort())
  )
    throw Error('Every closed supplemental case must occur in exactly one required shard');
  if (shard === undefined) return cases;
  if (!Object.hasOwn(supplementalShards, shard)) throw Error('Select exactly shard1/2 or2/2');
  const selected = new Set(supplementalShards[shard]);
  return cases.filter((value) => selected.has(value.name));
}

export function parseSupplementalShardArgs(args) {
  if (args.length > 1 || (args.length === 1 && !/^--shard=[12]\/2$/.test(args[0])))
    throw Error('Only the complete selection or an exact required shard is supported');
  return args[0]?.slice('--shard='.length);
}
