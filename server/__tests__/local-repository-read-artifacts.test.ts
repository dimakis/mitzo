import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins effective read scope, private call authority and repository read fixtures', async () => {
  const artifacts: Readonly<Record<string, string>> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../local-repository-discovery.ts',
    '../local-repository-git-inspection.ts',
    '../session-local-repository-tools.ts',
    '../__tests__/local-repository-read-scope.test.ts',
    '../__tests__/session-local-repository-tools.test.ts',
    '../__tests__/local-repository-read-artifacts.test.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
