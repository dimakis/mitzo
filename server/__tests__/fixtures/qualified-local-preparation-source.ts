import { isAbsolute, relative, sep } from 'node:path';
import { captureLocalRepositoryAllocationFacts } from '../../local-repository-allocation-facts.js';
import {
  localRepositoryPreparationSourceFacts,
  type NativeQualifiedLocalRepositoryPreparationSource,
} from '../../local-repository-preparation-source.js';
import { fixtureReadAnchor } from './local-repository-read-owner.js';

/** Actual bounded Git read facts under an explicit fixture-only owner. The
 * signed callback tests exercise permission/custody composition; this helper
 * is not the production native reader or evidence of its enforced permissions. */
export async function fixtureQualifiedLocalPreparationSource(
  input: Parameters<typeof captureLocalRepositoryAllocationFacts>[1],
  controls: {
    assertCurrentSync(): void;
    assertCurrent(): Promise<void>;
  },
): Promise<NativeQualifiedLocalRepositoryPreparationSource> {
  const intent = Object.freeze({ ...input });
  const capture = async () => {
    controls.assertCurrentSync();
    const held = await captureLocalRepositoryAllocationFacts(
      {
        deniedRoots: [],
        deadline: Date.now() + 30000,
        captureReadAnchor: fixtureReadAnchor,
        assertReadable: async (path) => {
          controls.assertCurrentSync();
          const inside = [intent.sourcePath, intent.taskRoot].some((root) => {
            const suffix = relative(root, path);
            return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
          });
          if (!inside) throw Error('Fixture path outside source/task scope');
        },
      },
      intent,
    );
    controls.assertCurrentSync();
    // Data only: no closed ReadAccess/verification closure is retained.
    return {
      facts: held.facts,
      factsSha256: held.factsSha256,
      publicationPackedRefs: held.publicationPackedRefs,
    };
  };
  const initial = await capture();
  return {
    ...localRepositoryPreparationSourceFacts(initial.facts),
    referenceCoverage: 'preparation-head-and-namespace-v1',
    allocationFacts: initial.facts,
    allocationFactsSha256: initial.factsSha256,
    publicationPackedRefs: initial.publicationPackedRefs,
    assertCurrentSync: () => controls.assertCurrentSync(),
    assertCurrent: async () => controls.assertCurrent(),
    async revalidateAllocationFacts() {
      const actual = await capture();
      if (actual.factsSha256 !== initial.factsSha256) throw Error('Original fixture facts changed');
    },
  };
}
