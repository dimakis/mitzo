import { expect, it } from 'vitest';
import { contextDigest } from '../agent-context-compiler.js';
import { PROFILE_BUILDER_ID, PROFILE_BUILDER_REVISION } from '@mitzo/protocol';
import {
  readOrdinaryCodexAgentProfile,
  ordinaryCodexAgentProfiles,
  ordinaryCodexAgentProfileRouteProjection,
} from '../ordinary-codex-agent-profile.js';

it('allows Local ContexGin and only explicitly configured OpenShell preset combinations', () => {
  const builtin = readOrdinaryCodexAgentProfile(
    { version: () => null },
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 },
  )!;
  const profile = {
    ...builtin,
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
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 },
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
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 },
  )!;
  const recipe = {
    ...builtin,
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
    { kind: 'builtin', profileId: PROFILE_BUILDER_ID, revision: 1 },
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
  ).toEqual([PROFILE_BUILDER_ID, 'mitzo-tool-builder', 'workspace']);
});
it('offers Tool Builder only on local API routes after native profile enrollment', () => {
  const profiles = ordinaryCodexAgentProfiles([]);
  const selection = { kind: 'builtin', profileId: 'mitzo-tool-builder', revision: 1 };
  const api = ordinaryCodexAgentProfileRouteProjection(profiles, 'openai', 'local', undefined, {
    contextRecipes: 'supported',
    toolSelection: true,
    toolRoute: 'local-api',
  });
  expect(api.agentProfiles).toContainEqual(selection);
  for (const route of ['codex', 'codex-owned-local']) {
    const native = ordinaryCodexAgentProfileRouteProjection(
      profiles,
      'openai',
      'local',
      undefined,
      { contextRecipes: 'none', toolSelection: true, toolRoute: route },
    );
    expect(native.agentProfiles).not.toContainEqual(selection);
    expect(native.agentProfileRejections).toContainEqual({
      agent: selection,
      reason: 'tool_selection_unavailable',
    });
  }
});
