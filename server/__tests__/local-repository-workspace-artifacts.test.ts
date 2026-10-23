import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins existing-repository metadata authorization, private Git preparation and custody fixtures', async () => {
  const artifacts: Readonly<Record<string, string>> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../worktree.ts',
    '../local-repository-worktree.ts',
    '../repository-workspaces.ts',
    '../local-repository-git-inspection.ts',
    '../__tests__/existing-local-repository-workspaces.test.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
