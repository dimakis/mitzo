import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PROFILE_BUILDER_REVISION,
  PROFILE_BUILDER_REVISIONS,
  profileBuilderDefinition,
  profileBuilderDefinitionForRevision,
} from '../src/profile-builder.js';

it('versions Library task review guidance while preserving earlier conversation snapshots', () => {
  expect(PROFILE_BUILDER_REVISION).toBe(3);
  expect(PROFILE_BUILDER_REVISIONS).toEqual([3, 2, 1]);
  expect(profileBuilderDefinition.instructions).toContain('Library task editor');
  expect(profileBuilderDefinition.instructions).toContain('ordinary tool result');
  expect(profileBuilderDefinition.instructions).not.toContain('create/edit cards');
  expect(profileBuilderDefinitionForRevision(2)?.instructions).toContain('create/edit cards');
  expect(
    createHash('sha256')
      .update(JSON.stringify(profileBuilderDefinitionForRevision(2)))
      .digest('hex'),
  ).toBe('1eda3e574fb1436a0823dfdc3afd0b7a822c45994b65ac0d1c2c67c341a83850');
  expect(profileBuilderDefinitionForRevision(1)?.instructions).not.toContain('AgentProposeTask');
  const resumed = profileBuilderDefinitionForRevision(2)!;
  resumed.instructions = 'mutated';
  expect(profileBuilderDefinitionForRevision(2)?.instructions).toContain('create/edit cards');
  expect(profileBuilderDefinitionForRevision(4)).toBeUndefined();
});
