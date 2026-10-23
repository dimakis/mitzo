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
    '../local-repository-git-snapshot.ts',
    '../local-repository-read-access.ts',
    '../local-repository-native-read.ts',
    '../native-host-tool-context.ts',
    '../sandboxed-command.ts',
    '../sandboxed-command-worker.ts',
    '../native-file-operation.ts',
    '../__tests__/agent-communication-native.test.ts',
    '../__tests__/native-read-anchor-capture.test.ts',
    '../__tests__/native-helper-transport.test.ts',
    '../__tests__/sandboxed-command-private-output.test.ts',
    '../__tests__/native-anchored-read.test.ts',
    '../__tests__/local-repository-read-security.test.ts',
    '../__tests__/local-repository-discovery.test.ts',
    '../__tests__/local-repository-racy-status.test.ts',
    '../__tests__/local-repository-status-semantics.test.ts',
    '../__tests__/local-repository-worktree-facts.test.ts',
    '../__tests__/fixtures/local-repository-read-owner.ts',
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
