const suite = 'tests/integration/telos-s9/integrated-candidate';
const originalCases = [
  { name: 'non-git', config: 'vitest.joined.config.ts', file: 'non-git-browser.contract.ts' },
  {
    name: 'repository',
    config: 'vitest.repository-joined.config.ts',
    file: 'repository-browser.contract.ts',
  },
  {
    name: 'lost-response-recovery',
    config: 'vitest.recovery-joined.config.ts',
    file: 'lost-response-browser.contract.ts',
  },
  {
    name: 'tree-priority',
    config: 'vitest.tree-priority-joined.config.ts',
    file: 'tree-priority-browser.contract.ts',
  },
  {
    name: 's8-chooser',
    config: 'vitest.s8-joined.config.ts',
    file: 's8-chooser-browser.contract.ts',
  },
  {
    name: 'stop-isolation',
    config: 'vitest.stop-isolation.config.ts',
    file: 'stop-isolation-browser.contract.ts',
  },
  {
    name: 's6-app-owners',
    config: 'vitest.s6-app-owners.config.ts',
    files: [
      'server/__tests__/telos-ordinary-canonical-journey.test.ts',
      'server/__tests__/agent-communication-nongit-app.test.ts',
      'server/__tests__/telos-coordinator-v2-native-journey.test.ts',
    ],
  },
  {
    name: 'native-lead-worker-workflow',
    configPath: 'tests/integration/telos-s5b/vitest.native-role-composition.config.ts',
    files: ['tests/integration/telos-s5b/native-role-composition.contract.ts'],
  },
  {
    name: 'worker-first-completion',
    configPath: 'tests/integration/telos-s9/worker-first-completion/vitest.config.ts',
    files: ['tests/integration/telos-s9/worker-first-completion/first-completion.contract.ts'],
  },
  {
    name: 'native-complete-non-git',
    config: 'vitest.native-complete-non-git.config.ts',
    file: 'native-complete-non-git.contract.ts',
  },
  {
    name: 'native-complete-repository',
    config: 'vitest.native-complete-repository.config.ts',
    file: 'native-complete-repository.contract.ts',
  },
  {
    name: 'selected-model-readiness',
    configPath: 'tests/integration/telos-s9/model-readiness/vitest.config.ts',
    files: ['tests/integration/telos-s9/model-readiness/model-readiness.contract.ts'],
  },
];
// Keep the original closed selection authoritative; only its execution is partitioned.
export const joinedCases = originalCases.map((selected) => ({
  name: selected.name,
  configPath: selected.configPath ?? suite + '/' + selected.config,
  files: selected.files ?? [suite + '/' + selected.file],
}));
export const joinedShards = Object.freeze({
  '1/3': ['non-git', 'repository', 'native-complete-repository', 'selected-model-readiness'],
  '2/3': ['lost-response-recovery', 'tree-priority', 's8-chooser', 'native-complete-non-git'],
  '3/3': [
    'stop-isolation',
    's6-app-owners',
    'native-lead-worker-workflow',
    'worker-first-completion',
  ],
});
export function selectJoinedShard(shard) {
  const names = joinedCases.map((selected) => selected.name);
  const partition = Object.values(joinedShards).flat();
  if (
    names.length !== 12 ||
    new Set(names).size !== 12 ||
    partition.length !== 12 ||
    new Set(partition).size !== 12 ||
    JSON.stringify([...names].sort()) !== JSON.stringify([...partition].sort())
  )
    throw Error('Every joined acceptance group must occur in exactly one required shard');
  if (shard === undefined) return joinedCases;
  if (!Object.hasOwn(joinedShards, shard)) throw Error('Select exactly a required joined shard');
  const selected = new Set(joinedShards[shard]);
  return joinedCases.filter((value) => selected.has(value.name));
}
export function parseJoinedShardArgs(args) {
  if (args.length > 1 || (args.length === 1 && !/^--shard=[123]\/3$/.test(args[0])))
    throw Error('Only the complete joined selection or an exact required shard is supported');
  return args[0]?.slice('--shard='.length);
}
export function requireJoinedReport(observed, selected) {
  const completeFiles = selected.files.every((path) => {
    const matches = observed.testResults.filter((r) => r.name.endsWith('/' + path));
    return (
      matches.length === 1 &&
      matches[0].status === 'passed' &&
      matches[0].assertionResults.length === 1 &&
      matches[0].assertionResults[0].status === 'passed'
    );
  });
  if (
    !observed.success ||
    observed.numTotalTests !== selected.files.length ||
    observed.numPassedTests !== selected.files.length ||
    observed.numFailedTests !== 0 ||
    observed.numPendingTests !== 0 ||
    observed.testResults.length !== selected.files.length ||
    !completeFiles
  )
    throw Error('Every required actual App case must pass exactly once with zero skips');
}
