import { expect, it } from 'vitest';
import { contextDigest } from '../agent-context-compiler.js';
import {
  PROFILE_BUILDER_ID,
  PROFILE_BUILDER_REVISION,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
} from '@mitzo/protocol';
import {
  readOrdinaryCodexAgentProfile,
  ordinaryCodexAgentProfiles,
  ordinaryCodexAgentProfileRouteProjection,
} from '../ordinary-codex-agent-profile.js';

it('allows Local ContexGin and only explicitly configured OpenShell preset combinations', () => {
  const builtin = readOrdinaryCodexAgentProfile(
    { version: () => null },
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: PROFILE_BUILDER_REVISION },
  )!;
  const profile = {
    ...builtin,
    revision: 1,
    kind: undefined,
    profileId: 'preset',
    definition: {
      ...builtin.definition,
      contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'original' },
    },
  };
  profile.contentHash = contextDigest(profile.definition);
  expect(
    ordinaryCodexAgentProfileRouteProjection([profile], 'openai-codex', 'local').agentProfiles,
  ).toEqual([{ profileId: 'preset', revision: 1 }]);
  const absent = ordinaryCodexAgentProfileRouteProjection([profile], 'openai-codex', 'openshell');
  expect(absent.agentProfiles).toEqual([]);
  expect(absent.agentProfileRejections[0].reason).toBe('sandbox_context_preset_unconfigured');
  expect(
    ordinaryCodexAgentProfileRouteProjection([profile], 'openai-codex', 'openshell', {
      original: {
        version: 1,
        source: 'workspace',
        files: ['context.md'],
        tokenBudget: 1000,
        required: [],
        excluded: [],
      },
    }).agentProfiles,
  ).toEqual([{ profileId: 'preset', revision: 1 }]);
});

it('projects published provider compatibility on the existing exact route', () => {
  const builtin = readOrdinaryCodexAgentProfile(
    { version: () => null },
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: PROFILE_BUILDER_REVISION },
  )!;
  const profile = {
    ...builtin,
    definition: {
      ...builtin.definition,
      recipe: {
        version: 1 as const,
        context: { include: [], sources: [] },
        skillRefs: [],
        toolDefaults: { mode: 'read-only' as const, preferredTools: [] },
        compatibleProviders: ['google-vertex' as const],
        reviewerTemplate: 'general' as const,
      },
    },
  };
  profile.contentHash = contextDigest(profile.definition);
  expect(
    ordinaryCodexAgentProfileRouteProjection([profile], 'openai-codex', 'local')
      .agentProfileRejections[0].reason,
  ).toBe('provider_incompatible');
  expect(
    ordinaryCodexAgentProfileRouteProjection([profile], 'google-vertex', 'local').agentProfiles[0]
      .kind,
  ).toBe('builtin');
});

it('keeps plain compatible builtins eligible while a plain-only native adapter refuses recipes', () => {
  const builtin = readOrdinaryCodexAgentProfile(
    { version: () => null },
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: PROFILE_BUILDER_REVISION },
  )!;
  const recipe = {
    ...builtin,
    revision: 1,
    kind: undefined,
    profileId: 'recipe',
    definition: {
      ...builtin.definition,
      contextRecipe: { version: 1 as const, source: 'contexgin' as const, agentName: 'preset' },
    },
  };
  recipe.contentHash = contextDigest(recipe.definition);
  const projected = ordinaryCodexAgentProfileRouteProjection(
    [builtin, recipe],
    'google-vertex',
    'local',
    undefined,
    { contextRecipes: 'none' },
  );
  expect(projected.agentProfiles).toEqual([
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: PROFILE_BUILDER_REVISION },
  ]);
  expect(projected.agentProfileRejections).toEqual([
    { agent: { profileId: 'recipe', revision: 1 }, reason: 'native_context_unavailable' },
  ]);
});

it('resolves builtins only in their exact namespace without consulting user publications', () => {
  const library = {
    version: () => {
      throw Error('Builtin must not consult user namespace');
    },
  };
  const selection = {
    kind: 'builtin' as const,
    profileId: PROFILE_BUILDER_ID,
    revision: PROFILE_BUILDER_REVISION,
  };
  expect(readOrdinaryCodexAgentProfile(library, selection)?.kind).toBe('builtin');
  expect(readOrdinaryCodexAgentProfile(library, { ...selection, revision: 999 })).toBeNull();
});

it('capabilities retain supported recipes and exclude native packs', () => {
  const builtin = readOrdinaryCodexAgentProfile(
    { version: () => null },
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: PROFILE_BUILDER_REVISION },
  )!;
  const workspace = {
    ...builtin,
    revision: 1,
    kind: undefined,
    profileId: 'workspace',
    definition: {
      ...builtin.definition,
      contextRecipe: {
        version: 1 as const,
        source: 'workspace' as const,
        files: ['README.md'],
        tokenBudget: 1000,
        required: [],
        excluded: [],
      },
    },
  };
  const packs = {
    ...builtin,
    revision: 1,
    kind: undefined,
    profileId: 'packs',
    definition: {
      ...builtin.definition,
      contextRecipe: {
        version: 2 as const,
        source: 'packs' as const,
        packs: [{ id: 'pin', revision: 1, hash: 'a'.repeat(64) }],
        tokenBudget: 1000,
      },
    },
  };
  workspace.contentHash = contextDigest(workspace.definition);
  packs.contentHash = contextDigest(packs.definition);
  expect(
    ordinaryCodexAgentProfiles([workspace, packs]).map((profile) => profile.profileId),
  ).toEqual([
    DEFAULT_MITZO_PROFILE_ID,
    PROFILE_BUILDER_ID,
    PROFILE_BUILDER_ID,
    PROFILE_BUILDER_ID,
    'workspace',
  ]);
});

it('keeps historical Builder revision one eligible without replacing its captured definition', () => {
  const inventory = ordinaryCodexAgentProfiles([]);
  expect(
    inventory.filter((p) => p.profileId === PROFILE_BUILDER_ID).map(({ revision }) => revision),
  ).toEqual([PROFILE_BUILDER_REVISION, 2, 1]);
  const historical = inventory.find(
    (profile) => profile.profileId === PROFILE_BUILDER_ID && profile.revision === 1,
  )!;
  expect(historical.definition.instructions).not.toContain('AgentProposeTask');
  expect(
    ordinaryCodexAgentProfileRouteProjection(inventory, 'openai-codex', 'local').agentProfiles,
  ).toContainEqual({ kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 });
});

it('provides Default Mitzo from code with an empty Library and keeps user identity separate', () => {
  const selection = {
    kind: 'builtin' as const,
    profileId: DEFAULT_MITZO_PROFILE_ID,
    revision: DEFAULT_MITZO_PROFILE_REVISION,
  };
  const library = { version: () => null };
  const profile = readOrdinaryCodexAgentProfile(library, selection)!;
  expect(profile.definition.name).toBe('Default Mitzo');
  expect(profile.contentHash).toBe(contextDigest(profile.definition));
  expect(ordinaryCodexAgentProfiles([])).toContainEqual(profile);
  for (const provider of ['openai', 'openai-codex', 'anthropic-vertex', 'google-vertex'])
    for (const location of ['local', 'openshell'] as const)
      expect(
        ordinaryCodexAgentProfileRouteProjection([profile], provider, location).agentProfiles,
      ).toEqual([selection]);
  expect(readOrdinaryCodexAgentProfile(library, { ...selection, revision: 999 })).toBeNull();
  expect(
    readOrdinaryCodexAgentProfile(library, {
      profileId: selection.profileId,
      revision: selection.revision,
    }),
  ).toBeNull();
  profile.definition.instructions = 'Changed returned copy';
  expect(readOrdinaryCodexAgentProfile(library, selection)?.definition.instructions).not.toBe(
    'Changed returned copy',
  );
});
