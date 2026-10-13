import { expect, it } from 'vitest';
import {
  readOrdinaryCodexAgentProfile as readResponsesAgentProfile,
  ordinaryCodexAgentProfiles,
  ordinaryCodexAgentProfileRouteProjection,
} from '../ordinary-codex-agent-profile.js';
const responsesBuiltinAgentProfile = () => ordinaryCodexAgentProfiles([])[0];
const responsesAgentProfileRouteProjection = (
  profiles: Parameters<typeof ordinaryCodexAgentProfileRouteProjection>[0],
  provider: string,
) =>
  ordinaryCodexAgentProfileRouteProjection(profiles, provider, 'local', undefined, {
    contextRecipes: 'none',
  });
it('projects builtin/plain eligibility but refuses runtime context independently of provider compatibility', () => {
  const builtin = responsesBuiltinAgentProfile();
  const context = {
    ...builtin,
    kind: undefined,
    profileId: 'context',
    definition: { ...builtin.definition, contextRecipe: { source: 'workspace' as const } },
  } as unknown as typeof builtin;
  const projection = responsesAgentProfileRouteProjection([builtin, context], 'openai');
  expect(projection.agentProfiles).toContainEqual({
    kind: 'builtin',
    profileId: builtin.profileId,
    revision: builtin.revision,
  });
  expect(projection.agentProfileRejections).toEqual([
    {
      agent: { profileId: 'context', revision: context.revision },
      reason: 'native_context_unavailable',
    },
  ]);
  expect(
    readResponsesAgentProfile(
      {
        version: () => {
          throw Error('Builtin must not use user namespace');
        },
      } as never,
      { kind: 'builtin', profileId: builtin.profileId, revision: builtin.revision },
    ),
  ).toEqual(builtin);
});
