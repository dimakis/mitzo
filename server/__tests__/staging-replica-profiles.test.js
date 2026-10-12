import { expect, it } from 'vitest';
import { assessStagingReplicaProfiles } from '../../scripts/lib/staging-replica-profiles.mjs';
const reference = [
  { id: 'work', provider: 'openai', runtime: 'responses', capabilities: ['images', 'context'] },
  {
    id: 'personal',
    provider: 'chatgpt',
    runtime: 'codex',
    capabilities: ['agent-library', 'context'],
  },
  { id: 'vertex', provider: 'vertex', runtime: 'claude', capabilities: ['context', 'tools'] },
];
const stage = () =>
  reference.map((p) => ({
    referenceId: p.id,
    profileId: 'stage-' + p.id,
    provider: p.provider,
    runtime: p.runtime,
    capabilities: p.capabilities,
    authorization: 'ready',
  }));
it('requires OpenAI, personal ChatGPT and Vertex profiles with their runtime capabilities', () => {
  expect(assessStagingReplicaProfiles(reference, stage())).toEqual({
    configurationMatches: true,
    issues: [],
    liveFeatureValidation: 'required',
  });
  expect(assessStagingReplicaProfiles(reference, stage().slice(0, 2))).toMatchObject({
    configurationMatches: false,
    issues: [{ profileId: 'vertex', reason: 'missing-profile' }],
  });
});
it('a future reference profile automatically makes an incomplete stage fail parity', () => {
  const extended = [
    ...reference,
    { id: 'future', provider: 'new-provider', runtime: 'new-runtime', capabilities: ['tools'] },
  ];
  expect(assessStagingReplicaProfiles(extended, stage()).issues).toContainEqual({
    profileId: 'future',
    reason: 'missing-profile',
  });
});
it('pending authorization, wrong runtime and missing capabilities do not count as a replica', () => {
  for (const changed of [
    { authorization: 'pending' },
    { runtime: 'other' },
    { capabilities: ['context'] },
  ]) {
    const actual = stage();
    actual[0] = { ...actual[0], ...changed };
    expect(assessStagingReplicaProfiles(reference, actual).configurationMatches).toBe(false);
  }
});
it('rejects credential-bearing or duplicate snapshot records rather than copying them', () => {
  expect(() =>
    assessStagingReplicaProfiles([{ ...reference[0], apiKey: 'secret' }], stage()),
  ).toThrow();
  expect(() => assessStagingReplicaProfiles(reference, [...stage(), stage()[0]])).toThrow();
});
