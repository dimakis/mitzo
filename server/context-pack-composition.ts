import { agentProfileLabel, type PublishedContextPack } from '@mitzo/protocol';
import type { AgentLibraryStore } from './agent-library-store.js';
import { compileAgentContext } from './agent-context-compiler.js';
import { contextPackHash } from './context-pack-store.js';
import { createAcceptedContextPacks, type ContextPackRuntime } from './context-pack-runtime.js';
import type { ContextPackDependencies } from './context-pack-router.js';

/** The two editors use this same store, source and compiler. Preview creates no published record. */
export function contextPackRouterDependencies(
  runtime: ContextPackRuntime,
  library: Pick<AgentLibraryStore, 'list'>,
): ContextPackDependencies {
  return {
    store: runtime.contextPacks,
    source: runtime.source,
    async impact(id) {
      return library.list('user').versions.flatMap((profile) => {
        const recipe = profile.definition.contextRecipe;
        if (recipe?.source !== 'packs') return [];
        return recipe.packs
          .filter((pin) => pin.id === id)
          .map((pin) => ({
            profileId: profile.profileId,
            name: agentProfileLabel(profile.definition),
            revision: profile.revision,
            packRevision: pin.revision,
          }));
      });
    },
    async preview(definition, signal) {
      const pack: PublishedContextPack = {
        id: definition.id,
        revision: 1,
        hash: contextPackHash(definition),
        definition,
        publishedAt: new Date().toISOString(),
      };
      const packs = createAcceptedContextPacks(runtime, {
        assertCurrent: () => signal.throwIfAborted(),
      });
      return compileAgentContext(
        {
          version: 2,
          source: 'packs',
          tokenBudget: definition.tokenBudget,
          packs: [{ id: pack.id, revision: pack.revision, hash: pack.hash }],
        },
        {
          signal,
          packs: {
            ...packs,
            resolve: async (pin) => {
              if (pin.id !== pack.id || pin.revision !== pack.revision || pin.hash !== pack.hash)
                throw Error('Preview pack identity changed');
              return pack;
            },
          },
        },
      );
    },
  };
}
