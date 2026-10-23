import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../connections/reviewed-handler-artifacts.js';

it('pins the private preparation decision producer, same-row custody and signed fixtures', async () => {
  const artifacts: Readonly<Record<string, string>> = reviewedHandlerSourceArtifacts;
  for (const file of [
    '../local-repository-preparation-authorization.ts',
    '../local-repository-preparation-source.ts',
    '../__tests__/local-repository-preparation-source.test.ts',
    '../__tests__/local-repository-preparation-references.test.ts',
    '../__tests__/native-host-read-owner.test.ts',
    '../__tests__/local-repository-reference-metadata.test.ts',
    '../__tests__/local-repository-cached-stat.test.ts',
    '../__tests__/local-repository-verification.test.ts',
    '../__tests__/native-directory-verification-batch.test.ts',
    '../local-repository-allocation-facts.ts',
    '../local-repository-git-snapshot.ts',
    '../local-repository-read-access.ts',
    '../local-repository-native-read.ts',
    '../__tests__/prepared-repository-native-read.test.ts',
    '../prepared-repository-transition.ts',
    '../__tests__/local-repository-allocation-facts.test.ts',
    '../pending-host-task.ts',
    '../native-file-operation.ts',
    '../__tests__/native-exclusive-directory.test.ts',
    '../repository-workspaces.ts',
    '../__tests__/fixtures/local-preparation-native.ts',
    '../__tests__/local-repository-preparation-authorization.test.ts',
    '../__tests__/local-repository-preparation-artifacts.test.ts',
  ]) {
    const source = await readFile(
      new URL(file, new URL('../connections/', import.meta.url)),
      'utf8',
    );
    expect(artifacts[file], file).toBe(reviewedHandlerSourceFingerprint(source));
  }
});
